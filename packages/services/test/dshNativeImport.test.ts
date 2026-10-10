import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { getLegacyTaskSessionSnapshotPath, setDataBaseDir } from "../src/paths.js";
import { parseLegacyTaskSessionFile } from "../src/session/legacyTaskSessionFile.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import {
  buildImportedDshTaskFile,
  buildImportedDshTaskId,
} from "../src/session/dsh-native/buildImportedDshTaskFile.js";
import { dshNativeSessionImportRepo } from "../src/session/dsh-native/dshNativeSessionImportRepo.js";
import { parseDshNativeSession } from "../src/session/dsh-native/dshNativeSessionImportParser.js";
import { parseDshSessionLogBuffer } from "../src/session/dsh-native/dshSessionLogReader.js";
import { importDshNativeSessions } from "../src/session/dsh-native/dshNativeSessionImportService.js";
import type { DshNativeImportedSessionSource } from "../src/session/dsh-native/dshNativeSessionTypes.js";

type Record_ = Record<string, unknown>;

/**
 * 构造 DSH 会话日志：每个 chunk 压缩成一个 zstd frame 后拼接（还原“每段追加一帧”的真实布局）。
 * chunks 里每个元素是多条 JSONL 行（验证一帧多行）。
 */
async function writeDshSessionLog(
  filePath: string,
  chunks: readonly (readonly Record_[])[],
): Promise<void> {
  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    const text = chunk.map((record) => JSON.stringify(record)).join("\n") + "\n";
    parts.push(zstdCompressSync(Buffer.from(text, "utf8")));
  }
  await writeFile(filePath, Buffer.concat(parts));
}

function sessionHeader(cwd: string, id: string, createdAt = 1000): Record_ {
  return { type: "session", version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0 };
}

function userMessage(text: string, time: number): Record_ {
  return {
    type: "user/message",
    seq: time,
    time,
    data: { role: "user", id: `u-${time}`, content: [{ type: "text", text }] },
  };
}

function assistantMessage(text: string, time: number, withReasoning = true): Record_ {
  const blocks: Record<string, unknown>[] = [];
  if (withReasoning) {
    blocks.push({ type: "reasoning", text: "思考内容" });
  }
  blocks.push({ type: "text", text });
  blocks.push({ type: "tool-call", id: `call-${time}`, name: "read", arguments: "{}" });
  return {
    type: "assistant/message",
    seq: time,
    time,
    data: { turn: 0, step: 1, message: { role: "assistant", id: `a-${time}`, content: blocks } },
  };
}

test("parser aggregates assistant text blocks per turn and skips meta events", () => {
  const result = parseDshNativeSession({
    sessionId: "session-11111111-2222",
    directory: "D:/work/demo",
    sourcePath: "C:/fake/.dsh/sessions/demo/session-1/session.v4.jsonl.zstd",
    fallbackCreatedAt: 1000,
    fallbackUpdatedAt: 9000,
    records: [
      sessionHeader("D:/work/demo", "session-11111111-2222", 1000),
      { type: "model/selection", seq: 1001, time: 1001, data: { provider: "deepseek", model: "deepseek-chat" } },
      { type: "turn/start", seq: 1002, time: 1002, data: { turn: 0 } },
      userMessage("帮我看下日志", 1100),
      { type: "step/start", seq: 1101, time: 1101, data: { turn: 0, step: 0 } },
      assistantMessage("我先读文件。", 1200),
      { type: "tool/call", seq: 1250, time: 1250, data: { callId: "c1", name: "read", arguments: "{}" } },
      { type: "tool/result", seq: 1300, time: 1300, data: { message: { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "文件内容" }] } } },
      assistantMessage("结论是 X。", 1400),
      { type: "turn/end", seq: 1450, time: 1450, data: { turn: 0, reason: { kind: "stop" } } },
      { type: "session/title", seq: 1451, time: 1451, data: { title: "日志排查" } },
      { type: "session-log-deepseek/delivery-accepted", seq: 1452, time: 1452, data: {} },
      userMessage("再确认下", 2100),
      assistantMessage("确认完毕。", 2200, false),
    ],
  });

  assert.equal(result.provider, "deepseekHarness");
  assert.equal(result.migrationSource, "deepseekHarness");
  assert.equal(result.model, "deepseek-chat");
  // session/title 事件优先于首条 user 消息派生标题
  assert.equal(result.title, "日志排查");
  assert.equal(result.createdAt, 1100);
  assert.deepEqual(
    result.messages.map((message) => [message.role, message.turnIndex]),
    [
      ["user", 0],
      ["assistant", 0],
      ["user", 1],
      ["assistant", 1],
    ],
  );
  // 同轮多条 assistant/message 的 text 块聚合；reasoning/tool-call 块不进入正文
  assert.equal(result.messages[1]?.content, ["我先读文件。", "结论是 X。"].join("\n\n"));
  assert.equal(result.messages[1]?.timestamp, 1200);
  assert.equal(result.messages[3]?.content, "确认完毕。");

  assert.throws(
    () =>
      parseDshNativeSession({
        sessionId: "session-empty",
        directory: "D:/work/empty",
        sourcePath: "C:/fake/session.v4.jsonl.zstd",
        records: [sessionHeader("D:/work/empty", "session-empty")],
      }),
    /没有可导入的可见消息/u,
  );
});

test("session log reader tolerates corrupted frames between valid ones", () => {
  const goodFrame1 = zstdCompressSync(
    Buffer.from(`${JSON.stringify(sessionHeader("D:/w", "s1"))}\n`, "utf8"),
  );
  const goodFrame2 = zstdCompressSync(
    Buffer.from(`${JSON.stringify(userMessage("你好", 1200))}\n`, "utf8"),
  );
  // 伪 magic + 垃圾字节：模拟压缩数据内 magic 误报/半写 frame
  const badFrame = Buffer.concat([
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
    Buffer.from("definitely-not-zstd-payload"),
  ]);
  const buffer = Buffer.concat([goodFrame1, badFrame, goodFrame2]);

  const result = parseDshSessionLogBuffer(buffer);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0]?.type, "session");
  assert.equal(result.records[1]?.type, "user/message");
  assert.equal(result.skippedFrames, 1);
});

test("repo scan picks the highest version file and honors filters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-dsh-scan-"));
  const sessionsRoot = join(dir, "sessions");
  const workspaceSlug = "--D-work-demo--";
  const sessionDir = join(sessionsRoot, workspaceSlug, "session-aaaabbbb-cccc");
  const otherDir = join(sessionsRoot, "--Z-elsewhere--", "session-dddd");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(otherDir, { recursive: true });

  // v3 只有头部（模拟升级后残留），v4 是全量；扫描/导入都必须只认 v4
  await writeDshSessionLog(join(sessionDir, "session.v3.jsonl.zstd"), [
    [sessionHeader("D:/work/demo", "session-aaaabbbb-cccc", 999)],
  ]);
  await writeDshSessionLog(join(sessionDir, "session.v4.jsonl.zstd"), [
    [
      sessionHeader("D:/work/demo", "session-aaaabbbb-cccc", 1000),
      { type: "model/selection", seq: 1001, time: 1001, data: { provider: "deepseek", model: "deepseek-chat" } },
    ],
    [userMessage("v4 的问题", 1100), assistantMessage("v4 的回答", 1200, false)],
    [{ type: "session/title", seq: 1300, time: 1300, data: { title: "v4 标题" } }],
  ]);
  await writeDshSessionLog(join(otherDir, "session.v4.jsonl.zstd"), [
    [sessionHeader("Z:/elsewhere", "session-dddd", 2000), userMessage("其它 workspace", 2100)],
  ]);

  // 让 v4 会话的 mtime 固定在最近，v3 目录另一个旧会话测试 modifiedSince
  const oldDir = join(sessionsRoot, workspaceSlug, "session-oldddd");
  await mkdir(oldDir, { recursive: true });
  await writeDshSessionLog(join(oldDir, "session.v4.jsonl.zstd"), [
    [sessionHeader("D:/work/demo", "session-oldddd", 500), userMessage("旧会话", 600)],
  ]);
  const now = new Date();
  await utimes(join(sessionDir, "session.v4.jsonl.zstd"), now, now);
  // dddd 设为稍新，保证“按最近活跃倒序”的断言稳定
  const newer = new Date(now.getTime() + 60_000);
  await utimes(join(otherDir, "session.v4.jsonl.zstd"), newer, newer);
  await utimes(
    join(oldDir, "session.v4.jsonl.zstd"),
    now,
    new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
  );

  try {
    const all = await dshNativeSessionImportRepo.scanImportableSessions({
      sessionsRoots: [sessionsRoot],
    });
    assert.deepEqual(
      all.map((candidate) => candidate.sessionId),
      ["session-dddd", "session-aaaabbbb-cccc", "session-oldddd"],
    );
    const target = all.find((candidate) => candidate.sessionId === "session-aaaabbbb-cccc");
    assert.equal(target?.provider, "deepseekHarness");
    assert.equal(target?.workspacePath, "D:/work/demo");
    assert.equal(target?.createdAt, 1000);
    // 标题预览来自头部帧里的 session/title 事件
    assert.equal(target?.previewTitle, "v4 标题");
    assert.ok(target?.sourcePath.endsWith("session.v4.jsonl.zstd"));

    const filtered = await dshNativeSessionImportRepo.scanImportableSessions({
      sessionsRoots: [sessionsRoot],
      workspacePath: "D:\\work\\demo",
    });
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every((candidate) => candidate.workspacePath === "D:/work/demo"));

    const recent = await dshNativeSessionImportRepo.scanImportableSessions({
      sessionsRoots: [sessionsRoot],
      modifiedSince: now - 60_000,
    });
    assert.deepEqual(
      recent.map((candidate) => candidate.sessionId).sort(),
      ["session-aaaabbbb-cccc", "session-dddd"],
    );

    const found = await dshNativeSessionImportRepo.findImportableSession({
      sessionsRoots: [sessionsRoot],
      sessionId: "session-aaaabbbb-cccc",
    });
    assert.equal(found?.sessionId, "session-aaaabbbb-cccc");
    assert.equal(
      await dshNativeSessionImportRepo.findImportableSession({
        sessionsRoots: [sessionsRoot],
        sessionId: "session-not-exist",
      }),
      null,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("importDshNativeSessions persists legacy snapshot and task index with deepseekHarness markers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-dsh-import-"));
  setDataBaseDir(dir);
  const sessionsRoot = join(dir, "sessions");
  const sessionDir = join(sessionsRoot, "--" + dir.replaceAll(/[\\/:]/g, "-").replace(/^-+/, "") + "--", "session-import-1");
  await mkdir(sessionDir, { recursive: true });
  await writeDshSessionLog(join(sessionDir, "session.v4.jsonl.zstd"), [
    [
      sessionHeader(dir, "session-import-1", 1000),
      { type: "model/selection", seq: 1001, time: 1001, data: { provider: "deepseek", model: "deepseek-chat" } },
    ],
    [userMessage("DSH 导入问题", 1100), assistantMessage("DSH 导入回答", 1200, false)],
  ]);

  const taskIndexRepo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const captured: DshNativeImportedSessionSource[] = [];
  try {
    const result = await importDshNativeSessions({
      taskIndexRepo,
      sessionIds: ["session-import-1", "session-not-exist"],
      sessionsRoots: [sessionsRoot],
      createImportedSession: async (source) => {
        captured.push(source);
        const taskFile = buildImportedDshTaskFile(source);
        return {
          taskId: taskFile.meta.taskId,
          traceId: taskFile.meta.traceId,
          title: taskFile.meta.title,
          workspacePath: source.workspacePath,
          createdAt: source.createdAt,
          updatedAt: source.updatedAt,
          mode: "build",
        };
      },
      onTaskImported: () => {},
    });

    assert.equal(result.imported.length, 1);
    assert.equal(result.imported[0]?.provider, "deepseekHarness");
    assert.equal(result.imported[0]?.sessionId, "session-import-1");
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]?.reason, "session_not_found_or_workspace_mismatch");

    const source = captured[0];
    assert.ok(source);
    assert.equal(source.migrationSource, "deepseekHarness");
    assert.deepEqual(
      source.messages.map((message) => [message.role, message.content]),
      [
        ["user", "DSH 导入问题"],
        ["assistant", "DSH 导入回答"],
      ],
    );

    const expectedTaskId = buildImportedDshTaskId(dir, "session-import-1");
    assert.equal(buildImportedDshTaskId(dir, "session-import-1"), expectedTaskId);
    assert.notEqual(buildImportedDshTaskId(dir, "session-other"), expectedTaskId);
    assert.equal(result.imported[0]?.taskId, expectedTaskId);

    const indexedMeta = await taskIndexRepo.getTaskMeta({
      taskId: expectedTaskId,
      workspacePath: dir,
    });
    assert.equal(indexedMeta?.migrationSource, "deepseekHarness");

    const snapshotPath = getLegacyTaskSessionSnapshotPath(dir, expectedTaskId);
    const legacy = parseLegacyTaskSessionFile(JSON.parse(await readFile(snapshotPath, "utf8")));
    assert.equal(legacy.meta.migrationSource, "deepseekHarness");
    // 来源端运行态（mode/model）被清洗
    assert.equal(legacy.meta.mode, undefined);
    assert.equal(legacy.meta.model, undefined);
    assert.equal(legacy.messages.length, 2);
  } finally {
    taskIndexRepo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});
