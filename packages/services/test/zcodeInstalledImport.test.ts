import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { getLegacyTaskSessionSnapshotPath, setDataBaseDir } from "../src/paths.js";
import { parseLegacyTaskSessionFile } from "../src/session/legacyTaskSessionFile.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import {
  buildImportedZCodeInstalledTaskFile,
  buildImportedZCodeInstalledTaskId,
} from "../src/session/zcode-installed-native/buildImportedZCodeInstalledTaskFile.js";
import { zcodeInstalledSessionImportRepo } from "../src/session/zcode-installed-native/zcodeInstalledSessionImportRepo.js";
import { parseZCodeInstalledSession } from "../src/session/zcode-installed-native/zcodeInstalledSessionImportParser.js";
import { importZCodeInstalledSessions } from "../src/session/zcode-installed-native/zcodeInstalledSessionImportService.js";
import { importZCodeInstalledConfigs } from "../src/session/zcode-installed-native/zcodeInstalledConfigImport.js";
import type { ZCodeInstalledImportedSessionSource } from "../src/session/zcode-installed-native/zcodeInstalledSessionTypes.js";

const require = createRequire(import.meta.url);

/** Windows：node:sqlite 句柄关闭后仍有短暂滞留，直接 rm 会 EBUSY；带重试清理（与 claude 导入测试同法）。 */
async function rmRetry(target: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  await rm(target, { recursive: true, force: true });
}

const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

/** 按来源库的最小可用子集建表：session / message / part / session_task_link。 */
function createPortableSessionDb(dbPath: string): InstanceType<typeof DatabaseSync> {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id text primary key,
      project_id text not null,
      workspace_id text,
      parent_id text,
      slug text not null,
      directory text not null,
      path text,
      title text not null,
      version text not null,
      share_url text,
      summary_additions integer,
      summary_deletions integer,
      summary_files integer,
      summary_diffs text,
      revert text,
      permission text,
      time_created integer not null,
      time_updated integer not null,
      time_compacting integer,
      time_archived integer,
      task_type text not null default 'interactive',
      title_source text not null default 'first_input',
      title_message_id text,
      time_title_updated integer,
      trace_id text,
      time_deleted integer,
      last_outcome text
    );
    CREATE TABLE message (
      id text primary key,
      session_id text not null references session(id) on delete cascade,
      time_created integer not null,
      time_updated integer not null,
      data text not null,
      sequence integer
    );
    CREATE TABLE part (
      id text primary key,
      message_id text not null references message(id) on delete cascade,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null,
      sequence integer
    );
    CREATE TABLE session_task_link (
      id text primary key,
      root_workflow_run_id text,
      parent_link_id text,
      activity_id text,
      parent_session_id text,
      child_session_id text not null unique,
      role text not null,
      depth integer not null default 0,
      path text not null,
      phase text,
      label text,
      agent_type text,
      model text,
      status text not null,
      time_created integer not null,
      time_updated integer not null
    );
  `);
  return db;
}

interface PortableMessageFixture {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  timeCreated: number;
  sequence: number | null;
  text?: string;
}

function insertMessage(
  db: InstanceType<typeof DatabaseSync>,
  fixture: PortableMessageFixture,
): void {
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    fixture.id,
    fixture.sessionId,
    fixture.timeCreated,
    fixture.timeCreated,
    JSON.stringify({ role: fixture.role, time: { created: fixture.timeCreated } }),
    fixture.sequence,
  );
  if (fixture.text !== undefined) {
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      `${fixture.id}_p1`,
      fixture.id,
      fixture.sessionId,
      fixture.timeCreated,
      fixture.timeCreated,
      JSON.stringify({ type: "text", text: fixture.text }),
      0,
    );
  }
}

function insertSession(
  db: InstanceType<typeof DatabaseSync>,
  fixture: {
    id: string;
    directory: string;
    title?: string;
    parentId?: string;
    timeArchived?: number;
    timeDeleted?: number;
    taskType?: string;
    timeCreated?: number;
    timeUpdated?: number;
  },
): void {
  db.prepare(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated,
      time_archived, task_type, parent_id, time_deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fixture.id,
    "proj",
    fixture.id,
    fixture.directory,
    fixture.title ?? fixture.id,
    "3.15.0",
    fixture.timeCreated ?? 1000,
    fixture.timeUpdated ?? 2000,
    fixture.timeArchived ?? null,
    fixture.taskType ?? "interactive",
    fixture.parentId ?? null,
    fixture.timeDeleted ?? null,
  );
}

test("解析器聚合同一轮的多条 assistant 文本并跳过纯工具轮", () => {
  const directory = "/repo/portable";
  const source = parseZCodeInstalledSession({
    sessionId: "ses_main",
    directory,
    title: "安装版会话",
    timeCreated: 1000,
    timeUpdated: 9000,
    sourcePath: "D:/portable/.zcode/cli/db/db.sqlite",
    messages: [
      {
        id: "m1",
        timeCreated: 1100,
        data: { role: "user", time: { created: 1100 } },
      },
      {
        id: "m2",
        timeCreated: 1200,
        data: { role: "assistant", time: { created: 1200 }, modelID: "glm-4.7" },
      },
      {
        id: "m3",
        timeCreated: 1300,
        // 纯工具 step 消息：没有 text part，不贡献可见内容。
        data: { role: "assistant", time: { created: 1300 } },
      },
      {
        id: "m4",
        timeCreated: 1400,
        data: { role: "assistant", time: { created: 1400 } },
      },
    ],
    partsByMessageId: new Map([
      ["m1", [{ timeCreated: 1100, data: { type: "text", text: "安装版问题" } }]],
      [
        "m2",
        [
          { timeCreated: 1200, data: { type: "reasoning", text: "不应导入的思考" } },
          { timeCreated: 1210, data: { type: "text", text: "回答前半" } },
        ],
      ],
      ["m4", [{ timeCreated: 1400, data: { type: "text", text: "回答后半" } }]],
    ]),
  });

  assert.equal(source.provider, "zcodeInstalled");
  assert.equal(source.workspacePath, directory);
  assert.deepEqual(
    source.messages.map((message) => [message.role, message.content]),
    [
      ["user", "安装版问题"],
      ["assistant", "回答前半\n\n回答后半"],
    ],
  );
  assert.equal(source.model, "glm-4.7");
});

test("没有可见文本的会话解析抛错，导入计入 skipped", async () => {
  // home 模拟安装版用户主目录；current 是当前实例数据根（两者分离以避开自我导入防护）。
  const home = await mkdtemp(join(tmpdir(), "zcode-installed-empty-home-"));
  const current = await mkdtemp(join(tmpdir(), "zcode-installed-empty-current-"));
  setDataBaseDir(current);
  try {
    const dbPath = join(home, ".zcode", "cli", "db", "db.sqlite");
    await mkdir(join(home, ".zcode", "cli", "db"), { recursive: true });
    const db = createPortableSessionDb(dbPath);
    insertSession(db, { id: "ses_empty", directory: home });
    insertMessage(db, {
      id: "m1",
      sessionId: "ses_empty",
      role: "assistant",
      timeCreated: 1100,
      sequence: 0,
    });
    db.close();

    const taskIndexRepo = new TaskIndexRepo(join(current, "tasks.sqlite"));
    try {
      const result = await importZCodeInstalledSessions({
        taskIndexRepo,
        homeDir: home,
        sessionIds: ["ses_empty"],
        createImportedSession: () => {
          throw new Error("不应触达导入回调");
        },
        onTaskImported: () => {},
      });
      assert.equal(result.imported.length, 0);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0]?.reason, "no_visible_messages");
    } finally {
      taskIndexRepo.close();
    }
  } finally {
    setDataBaseDir(null);
    await rmRetry(home);
    await rmRetry(current);
  }
});

test("扫描只返回安装版主会话候选", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-installed-scan-home-"));
  const current = await mkdtemp(join(tmpdir(), "zcode-installed-scan-current-"));
  setDataBaseDir(current);
  try {
    const dbPath = join(home, ".zcode", "cli", "db", "db.sqlite");
    await mkdir(join(home, ".zcode", "cli", "db"), { recursive: true });
    const db = createPortableSessionDb(dbPath);
    insertSession(db, { id: "ses_main", directory: "/repo/a", timeUpdated: 5000 });
    insertSession(db, { id: "ses_child", directory: "/repo/a", parentId: "ses_main" });
    insertSession(db, { id: "ses_archived", directory: "/repo/a", timeArchived: 4000 });
    insertSession(db, { id: "ses_deleted", directory: "/repo/a", timeDeleted: 4000 });
    insertSession(db, { id: "ses_workflow", directory: "/repo/a", taskType: "workflow_child" });
    insertSession(db, { id: "ses_linked", directory: "/repo/a" });
    db.prepare(
      "INSERT INTO session_task_link (id, child_session_id, role, path, status, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("link1", "ses_linked", "child", "root/ses_linked", "completed", 1000, 1000);
    db.close();

    const candidates = await zcodeInstalledSessionImportRepo.scanImportableSessions({
      homeDir: home,
    });
    assert.deepEqual(
      candidates.map((candidate) => candidate.sessionId),
      ["ses_main"],
    );
    assert.equal(candidates[0]?.provider, "zcodeInstalled");
    assert.equal(candidates[0]?.workspacePath, "/repo/a");
    assert.equal(candidates[0]?.sourcePath, dbPath);

    // workspace 过滤与 modifiedSince 过滤。
    const filtered = await zcodeInstalledSessionImportRepo.scanImportableSessions({
      homeDir: home,
      workspacePath: "/repo/other",
    });
    assert.equal(filtered.length, 0);
    const recent = await zcodeInstalledSessionImportRepo.scanImportableSessions({
      homeDir: home,
      modifiedSince: 4999,
    });
    assert.equal(recent.length, 1);

    // findImportableSession 与扫描同一套导入边界。
    const found = await zcodeInstalledSessionImportRepo.findImportableSession({
      homeDir: home,
      sessionId: "ses_linked",
    });
    assert.equal(found, null);
  } finally {
    setDataBaseDir(null);
    await rmRetry(home);
    await rmRetry(current);
  }
});

test("导入为真实 ZCode session 并写入 legacy snapshot 与索引事实", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-installed-import-home-"));
  const current = await mkdtemp(join(tmpdir(), "zcode-installed-import-current-"));
  setDataBaseDir(current);
  const workspaceDir = join(home, "repo");
  try {
    await mkdir(workspaceDir, { recursive: true });
    const dbPath = join(home, ".zcode", "cli", "db", "db.sqlite");
    await mkdir(join(home, ".zcode", "cli", "db"), { recursive: true });
    const db = createPortableSessionDb(dbPath);
    insertSession(db, {
      id: "ses_import",
      directory: workspaceDir,
      title: "导入测试",
      timeCreated: 1000,
      timeUpdated: 6000,
    });
    insertMessage(db, {
      id: "m1",
      sessionId: "ses_import",
      role: "user",
      timeCreated: 1100,
      sequence: 0,
      text: "导入测试问题",
    });
    insertMessage(db, {
      id: "m2",
      sessionId: "ses_import",
      role: "assistant",
      timeCreated: 1200,
      sequence: 1,
      text: "导入测试回答",
    });
    db.close();

    const taskIndexRepo = new TaskIndexRepo(join(current, "tasks.sqlite"));
    const captured: ZCodeInstalledImportedSessionSource[] = [];
    const importedMetas: Array<{ taskId: string; migrationSource?: string }> = [];
    try {
      const result = await importZCodeInstalledSessions({
        taskIndexRepo,
        homeDir: home,
        sessionIds: ["ses_import", "ses_missing"],
        createImportedSession: async (source) => {
          captured.push(source);
          // 模拟真实适配器：createSession 先把 CLI 事实写进 task index，
          // 服务侧只允许在其上补 presentation/searchable，不能再凭空建行。
          const taskFile = buildImportedZCodeInstalledTaskFile(source);
          // 快照过滤器会剥离来源端 mode/model；真实适配器返回的 meta 带 CLI 侧 mode，这里同样补齐。
          const meta: ZCodeTaskMeta = { ...taskFile.meta, mode: "build" };
          await taskIndexRepo.applyCliFacts({ meta, titleSource: "generated" });
          return meta;
        },
        onTaskImported: (meta) => {
          importedMetas.push({ taskId: meta.taskId, migrationSource: meta.migrationSource });
        },
      });

      assert.equal(result.imported.length, 1);
      assert.equal(result.imported[0]?.provider, "zcodeInstalled");
      assert.equal(result.imported[0]?.sessionId, "ses_import");
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0]?.reason, "session_not_found_or_workspace_mismatch");

      const source = captured[0];
      assert.ok(source);
      assert.equal(source.migrationSource, "zcodeInstalled");
      assert.deepEqual(
        source.messages.map((message) => [message.role, message.content]),
        [
          ["user", "导入测试问题"],
          ["assistant", "导入测试回答"],
        ],
      );

      const expectedTaskId = buildImportedZCodeInstalledTaskId(workspaceDir, "ses_import");
      assert.equal(result.imported[0]?.taskId, expectedTaskId);
      assert.equal(importedMetas[0]?.migrationSource, "zcodeInstalled");

      const indexedMeta = await taskIndexRepo.getTaskMeta({
        taskId: expectedTaskId,
        workspacePath: workspaceDir,
      });
      assert.equal(indexedMeta?.migrationSource, "zcodeInstalled");

      const snapshotPath = getLegacyTaskSessionSnapshotPath(workspaceDir, expectedTaskId);
      const legacy = parseLegacyTaskSessionFile(JSON.parse(await readFile(snapshotPath, "utf8")));
      assert.equal(legacy.meta.migrationSource, "zcodeInstalled");
      // 来源端运行态（mode/model）被清洗，避免恢复时污染当前 workspace 的运行时选择。
      assert.equal(legacy.meta.mode, undefined);
      assert.equal(legacy.meta.model, undefined);
      assert.equal(legacy.messages.length, 2);
    } finally {
      taskIndexRepo.close();
    }
  } finally {
    setDataBaseDir(null);
    await rmRetry(home);
    await rmRetry(current);
  }
});

test("当前实例使用主目录数据（安装版形态）时拒绝导入", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-installed-self-"));
  setDataBaseDir(home);
  try {
    const dbPath = join(home, ".zcode", "cli", "db", "db.sqlite");
    await mkdir(join(home, ".zcode", "cli", "db"), { recursive: true });
    const db = createPortableSessionDb(dbPath);
    insertSession(db, { id: "ses_self", directory: home });
    db.close();

    await assert.rejects(
      zcodeInstalledSessionImportRepo.scanImportableSessions({ homeDir: home }),
      /无需也无法从自身导入/,
    );
    await assert.rejects(importZCodeInstalledConfigs({ homeDir: home }), /无需导入安装版配置/);
  } finally {
    setDataBaseDir(null);
    await rmRetry(home);
  }
});

test("主目录没有安装版数据时扫描给出可读错误", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-installed-invalid-"));
  const current = await mkdtemp(join(tmpdir(), "zcode-installed-invalid-current-"));
  setDataBaseDir(current);
  try {
    await writeFile(join(home, "readme.txt"), "no installed edition data", "utf8");
    await assert.rejects(
      zcodeInstalledSessionImportRepo.scanImportableSessions({ homeDir: home }),
      /没有找到 ZCode 安装版数据/,
    );
  } finally {
    setDataBaseDir(null);
    await rmRetry(home);
    await rmRetry(current);
  }
});

test("配置导入只补缺失文件且不覆盖当前实例已有配置", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-installed-config-home-"));
  const current = await mkdtemp(join(tmpdir(), "zcode-installed-config-current-"));
  setDataBaseDir(current);
  try {
    // 安装版侧三个配置文件 + 一个不存在的文件（credentials 缺失场景）。
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    await mkdir(join(home, ".zcode", "cli"), { recursive: true });
    await writeFile(join(home, ".zcode", "v2", "provider_config.json"), '{"providers":1}', "utf8");
    await writeFile(join(home, ".zcode", "cli", "config.json"), '{"theme":"dark"}', "utf8");
    // 当前实例已有自己的 provider 配置，不允许被安装版覆盖。
    await mkdir(join(current, ".zcode", "v2"), { recursive: true });
    await writeFile(
      join(current, ".zcode", "v2", "provider_config.json"),
      '{"providers":"current"}',
      "utf8",
    );

    const first = await importZCodeInstalledConfigs({ homeDir: home });
    assert.deepEqual(first.copied, [".zcode/cli/config.json"]);
    assert.deepEqual(first.skipped, [
      ".zcode/v2/provider_config.json",
      ".zcode/v2/credentials.json",
    ]);

    // 当前实例的 provider 配置未被覆盖，CLI 配置已复制。
    assert.equal(
      await readFile(join(current, ".zcode", "v2", "provider_config.json"), "utf8"),
      '{"providers":"current"}',
    );
    assert.equal(
      await readFile(join(current, ".zcode", "cli", "config.json"), "utf8"),
      '{"theme":"dark"}',
    );

    // 再次导入：CLI 配置已存在，全部 skip。
    const second = await importZCodeInstalledConfigs({ homeDir: home });
    assert.equal(second.copied.length, 0);
    assert.equal(second.skipped.length, 3);
  } finally {
    setDataBaseDir(null);
    await rmRetry(home);
    await rmRetry(current);
  }
});
