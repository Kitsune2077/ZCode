import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
// 官方 v3.15.1 已把单测栈迁移到 vitest（root vitest 收集全部 *.test.ts），
// node:test 风格文件因无 vitest 套件会整体报 No test suite found。
import { test } from "vitest";
import { getLegacyTaskSessionSnapshotPath, setDataBaseDir } from "../src/paths.js";
import { parseLegacyTaskSessionFile } from "../src/session/legacyTaskSessionFile.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import {
  buildImportedOpenCodeTaskFile,
  buildImportedOpenCodeTaskId,
} from "../src/session/opencode-native/buildImportedOpenCodeTaskFile.js";
import { opencodeNativeSessionImportRepo } from "../src/session/opencode-native/opencodeNativeSessionImportRepo.js";
import { parseOpenCodeNativeSession } from "../src/session/opencode-native/opencodeNativeSessionImportParser.js";
import { importOpenCodeNativeSessions } from "../src/session/opencode-native/opencodeNativeSessionImportService.js";
import type { OpenCodeNativeImportedSessionSource } from "../src/session/opencode-native/opencodeNativeSessionTypes.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

interface FixturePart {
  id: string;
  messageId: string;
  data: Record<string, unknown>;
}

interface FixtureMessage {
  id: string;
  data: Record<string, unknown>;
  parts: FixturePart[];
}

/** 构造最小 V1/V2 opencode.db fixture；列集合覆盖 repo 查询所需字段。 */
function createFixtureDatabase(
  dbPath: string,
  sessions: Array<{
    id: string;
    directory: string;
    title?: string;
    parentId?: string;
    timeArchived?: number;
    timeCreated: number;
    timeUpdated: number;
    messages?: FixtureMessage[];
    v2Rows?: Array<{ type: string; data: Record<string, unknown> }>;
  }>,
): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      directory TEXT,
      title TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      type TEXT,
      seq INTEGER,
      time_created INTEGER,
      data TEXT
    );
  `);
  const insertSession = db.prepare(
    "INSERT INTO session (id, parent_id, directory, title, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertMessage = db.prepare(
    "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
  );
  const insertPart = db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
  );
  const insertV2 = db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)",
  );

  for (const session of sessions) {
    insertSession.run(
      session.id,
      session.parentId ?? null,
      session.directory,
      session.title ?? null,
      session.timeCreated,
      session.timeUpdated,
      session.timeArchived ?? null,
    );
    for (const [index, message] of (session.messages ?? []).entries()) {
      insertMessage.run(message.id, session.id, session.timeCreated + index, JSON.stringify(message.data));
      for (const [partIndex, part] of message.parts.entries()) {
        insertPart.run(
          part.id,
          part.messageId,
          session.id,
          session.timeCreated + index + partIndex,
          JSON.stringify(part.data),
        );
      }
    }
    for (const [index, row] of (session.v2Rows ?? []).entries()) {
      insertV2.run(
        `${session.id}_v2_${index}`,
        session.id,
        row.type,
        index,
        session.timeCreated + index,
        JSON.stringify(row.data),
      );
    }
  }
  db.close();
}

function textPart(id: string, messageId: string, text: string): FixturePart {
  return { id, messageId, data: { type: "text", text } };
}

function toolStepParts(messageId: string, prefix: string): FixturePart[] {
  return [
    { id: `${prefix}-start`, messageId, data: { type: "step-start" } },
    {
      id: `${prefix}-tool`,
      messageId,
      data: { type: "tool", tool: "read", callID: `${prefix}-call`, state: { status: "completed" } },
    },
    { id: `${prefix}-finish`, messageId, data: { type: "step-finish" } },
  ];
}

test("parser aggregates multi-step assistant turns and skips tool-only user rows", () => {
  const result = parseOpenCodeNativeSession({
    sessionId: "ses_parse",
    directory: "D:/work/demo",
    timeCreated: 1000,
    timeUpdated: 9000,
    sourcePath: "C:/fake/opencode.db",
    messages: [
      {
        id: "msg_u1",
        timeCreated: 1000,
        data: { role: "user", time: { created: 1100 }, summary: "预览" },
      },
      {
        id: "msg_a1",
        timeCreated: 1200,
        data: { role: "assistant", modelID: "deepseek-chat" },
      },
      {
        id: "msg_a2",
        timeCreated: 1300,
        data: { role: "assistant", modelID: "deepseek-chat" },
      },
      // 纯 tool_result 承载的 user 行（无 text part），Phase 1 跳过
      { id: "msg_u2", timeCreated: 1400, data: { role: "user" } },
      { id: "msg_a3", timeCreated: 1500, data: { role: "assistant" } },
    ],
    partsByMessageId: new Map([
      ["msg_u1", [{ timeCreated: 1000, data: { type: "text", text: "帮我看看这个函数" } }]],
      [
        "msg_a1",
        [
          { timeCreated: 1200, data: { type: "step-start" } },
          { timeCreated: 1201, data: { type: "reasoning", text: "思考中" } },
          { timeCreated: 1202, data: { type: "text", text: "我先看看文件。" } },
        ],
      ],
      ["msg_a2", [{ timeCreated: 1300, data: { type: "text", text: "这个函数的问题是 X。" } }]],
      ["msg_u2", [{ timeCreated: 1400, data: { type: "tool", state: { status: "completed" } } }]],
      ["msg_a3", [{ timeCreated: 1500, data: { type: "text", text: "补充说明 Y" } }]],
    ]),
  });

  assert.equal(result.provider, "openCode");
  assert.equal(result.migrationSource, "openCode");
  assert.equal(result.model, "deepseek-chat");
  // 无显式标题时从首条 user 消息派生
  assert.ok(result.title?.startsWith("帮我看看这个函数"));
  assert.equal(result.createdAt, 1100);
  assert.deepEqual(
    result.messages.map((message) => [message.role, message.turnIndex]),
    [
      ["user", 0],
      ["assistant", 0],
    ],
  );
  const assistant = result.messages[1];
  assert.equal(
    assistant.content,
    ["我先看看文件。", "这个函数的问题是 X。", "补充说明 Y"].join("\n\n"),
  );
  // assistant 轮时间戳取该轮首个 assistant 消息的行时间戳（msg_a1: 1200），
  // 不使用 text part 的时间戳。
  assert.equal(assistant.timestamp, 1200);
});

test("parser falls back to V2 rows carrying role and throws when nothing visible", () => {
  const v2Source = parseOpenCodeNativeSession({
    sessionId: "ses_v2",
    directory: "D:/work/v2",
    timeCreated: 100,
    timeUpdated: 300,
    sourcePath: "C:/fake/opencode.db",
    messages: [],
    partsByMessageId: new Map(),
    v2Rows: [
      { type: "model-switched", seq: 0, timeCreated: 100, data: { model: { id: "x" } } },
      {
        type: "message",
        seq: 1,
        timeCreated: 110,
        data: { role: "user", parts: [{ type: "text", text: "V2 问题" }] },
      },
      {
        type: "message",
        seq: 2,
        timeCreated: 120,
        data: { role: "assistant", text: "V2 回答" },
      },
    ],
  });
  assert.deepEqual(
    v2Source.messages.map((message) => [message.role, message.content]),
    [
      ["user", "V2 问题"],
      ["assistant", "V2 回答"],
    ],
  );

  assert.throws(
    () =>
      parseOpenCodeNativeSession({
        sessionId: "ses_empty",
        directory: "D:/work/empty",
        timeCreated: 1,
        timeUpdated: 2,
        sourcePath: "C:/fake/opencode.db",
        messages: [{ id: "m", timeCreated: 1, data: { role: "user" } }],
        partsByMessageId: new Map(),
      }),
    /没有可导入的可见消息/u,
  );
});

test("repo scan excludes sidechain/archived sessions and honors filters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-opencode-scan-"));
  const dbPath = join(dir, "opencode.db");
  createFixtureDatabase(dbPath, [
    {
      id: "ses_main",
      directory: dir,
      timeCreated: 1000,
      timeUpdated: 5000,
      messages: [
        {
          id: "msg_u1",
          data: { role: "user" },
          parts: [textPart("p1", "msg_u1", "主会话问题")],
        },
      ],
    },
    {
      id: "ses_sub",
      directory: dir,
      parentId: "ses_main",
      timeCreated: 1100,
      timeUpdated: 6000,
    },
    {
      id: "ses_archived",
      directory: dir,
      timeArchived: 123,
      timeCreated: 1200,
      timeUpdated: 7000,
    },
    {
      id: "ses_other_ws",
      directory: "Z:/not/current/workspace",
      timeCreated: 1300,
      timeUpdated: 8000,
    },
  ]);

  try {
    const all = await opencodeNativeSessionImportRepo.scanImportableSessions({
      databasePaths: [dbPath],
    });
    assert.deepEqual(
      all.map((candidate) => candidate.sessionId),
      ["ses_other_ws", "ses_main"],
    );
    assert.equal(all[1]?.provider, "openCode");
    assert.equal(all[1]?.previewTitle, undefined);
    assert.equal(all[1]?.workspacePath, dir);

    const filtered = await opencodeNativeSessionImportRepo.scanImportableSessions({
      databasePaths: [dbPath],
      workspacePath: dir,
    });
    assert.deepEqual(
      filtered.map((candidate) => candidate.sessionId),
      ["ses_main"],
    );

    const limited = await opencodeNativeSessionImportRepo.scanImportableSessions({
      databasePaths: [dbPath],
      limit: 1,
    });
    assert.equal(limited.length, 1);

    const stale = await opencodeNativeSessionImportRepo.scanImportableSessions({
      databasePaths: [dbPath],
      modifiedSince: 9999,
    });
    assert.equal(stale.length, 0);

    const found = await opencodeNativeSessionImportRepo.findImportableSession({
      databasePaths: [dbPath],
      sessionId: "ses_main",
    });
    assert.equal(found?.sessionId, "ses_main");
    assert.equal(
      await opencodeNativeSessionImportRepo.findImportableSession({
        databasePaths: [dbPath],
        sessionId: "ses_sub",
      }),
      null,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("importOpenCodeNativeSessions persists legacy snapshot and task index with openCode markers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-opencode-import-"));
  setDataBaseDir(dir);
  const dbPath = join(dir, "opencode.db");
  createFixtureDatabase(dbPath, [
    {
      id: "ses_import",
      directory: dir,
      timeCreated: 1000,
      timeUpdated: 5000,
      messages: [
        {
          id: "msg_u1",
          data: { role: "user", time: { created: 1100 } },
          parts: [textPart("p1", "msg_u1", "导入测试问题")],
        },
        {
          id: "msg_a1",
          data: { role: "assistant", modelID: "kimi-k2" },
          parts: [
            ...toolStepParts("msg_a1", "t1"),
            textPart("p2", "msg_a1", "导入测试回答"),
          ],
        },
      ],
    },
    {
      id: "ses_missing_ws",
      directory: "Z:/definitely/not/exist",
      timeCreated: 1000,
      timeUpdated: 6000,
      messages: [
        {
          id: "msg_u2",
          data: { role: "user" },
          parts: [textPart("p3", "msg_u2", "不该导入")],
        },
      ],
    },
  ]);

  const taskIndexRepo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const captured: OpenCodeNativeImportedSessionSource[] = [];
  const importedMetas: Array<{ taskId: string; migrationSource?: string }> = [];
  try {
    const result = await importOpenCodeNativeSessions({
      taskIndexRepo,
      sessionIds: ["ses_import", "ses_missing_ws"],
      databasePaths: [dbPath],
      createImportedSession: async (source) => {
        captured.push(source);
        // 模拟真实链路：CLI 创建持久会话并把事实写入 task index（mock 固定用确定性
        // taskId，便于断言）。缺这一步时 updateTaskPresentation 找不到索引行。
        const taskFile = buildImportedOpenCodeTaskFile(source);
        return taskIndexRepo.applyCliFacts({
          meta: {
            taskId: taskFile.meta.taskId,
            traceId: taskFile.meta.traceId,
            title: taskFile.meta.title,
            workspacePath: source.workspacePath,
            createdAt: source.createdAt,
            updatedAt: source.updatedAt,
            mode: "build",
          },
        });
      },
      onTaskImported: (meta) => {
        importedMetas.push({ taskId: meta.taskId, migrationSource: meta.migrationSource });
      },
    });

    assert.equal(result.imported.length, 1);
    assert.equal(result.imported[0]?.provider, "openCode");
    assert.equal(result.imported[0]?.sessionId, "ses_import");
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]?.reason, "workspace_path_missing");

    const source = captured[0];
    assert.ok(source);
    assert.equal(source.migrationSource, "openCode");
    assert.deepEqual(
      source.messages.map((message) => [message.role, message.content]),
      [
        ["user", "导入测试问题"],
        ["assistant", "导入测试回答"],
      ],
    );
    // 工具 step part 不进入导入正文（Phase 1 text-only）
    assert.ok(!source.messages[1]?.content.includes("read"));

    const expectedTaskId = buildImportedOpenCodeTaskId(dir, "ses_import");
    assert.equal(buildImportedOpenCodeTaskId(dir, "ses_import"), expectedTaskId);
    assert.notEqual(buildImportedOpenCodeTaskId(dir, "ses_other"), expectedTaskId);
    assert.equal(result.imported[0]?.taskId, expectedTaskId);
    assert.equal(importedMetas[0]?.migrationSource, "openCode");

    const indexedMeta = await taskIndexRepo.getTaskMeta({
      taskId: expectedTaskId,
      workspacePath: dir,
    });
    assert.equal(indexedMeta?.migrationSource, "openCode");

    const snapshotPath = getLegacyTaskSessionSnapshotPath(dir, expectedTaskId);
    const legacy = parseLegacyTaskSessionFile(JSON.parse(await readFile(snapshotPath, "utf8")));
    assert.equal(legacy.meta.migrationSource, "openCode");
    // 来源端运行态（mode/model）被清洗，避免恢复时污染当前 workspace 的运行时选择。
    assert.equal(legacy.meta.mode, undefined);
    assert.equal(legacy.meta.model, undefined);
    assert.equal(legacy.messages.length, 2);
  } finally {
    taskIndexRepo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});
