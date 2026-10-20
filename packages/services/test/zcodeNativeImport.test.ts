import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// 官方 v3.15.1 已把单测栈迁移到 vitest（root vitest 收集全部 *.test.ts），
// node:test 风格文件因无 vitest 套件会整体报 No test suite found。
import { test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  getLegacyTaskSessionSnapshotPath,
  setDataBaseDir,
} from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import {
  getCurrentSessionDbPath,
  resolveInstalledConversationSource,
  scanImportableZcodeDesktopSessions,
} from "../src/session/zcode-native/zcodeNativeConversationSource.js";
import { importZcodeNativeSessions } from "../src/session/zcode-native/zcodeNativeConversationImportService.js";

interface SourceSessionSeed {
  id: string;
  title: string;
  directory: string;
  timeCreated: number;
  timeUpdated: number;
  parentId?: string | null;
  timeDeleted?: number | null;
  traceId?: string | null;
  lastOutcome?: string | null;
  messages?: Array<{ id: string; data: string; parts?: Array<{ id: string; data: string }> }>;
  entries?: Array<{ id: string; type: string; data: string }>;
  todos?: Array<{ content: string; status: string; priority: string; position: number }>;
  /** 置为子代理链接的 child（源库带 session_task_link 表时扫描应排除）。 */
  linkedAsChildOf?: string;
}

/**
 * 构造安装版 CLI 会话库 fixture：列集为基线子集（列交集合并按两侧都存在的列读写）。
 * slim 时省去 trace_id/last_outcome，模拟旧版本源库缺新列。
 */
async function createSessionDb(
  dbPath: string,
  sessions: SourceSessionSeed[],
  options?: { slim?: boolean },
): Promise<void> {
  const db = new DatabaseSync(dbPath);
  const sessionColumns = options?.slim
    ? `id text primary key, project_id text not null, directory text not null,
       title text not null, time_created integer not null, time_updated integer not null,
       parent_id text, time_deleted integer`
    : `id text primary key, project_id text not null, directory text not null,
       title text not null, time_created integer not null, time_updated integer not null,
       parent_id text, time_deleted integer, trace_id text, last_outcome text`;
  db.exec(`CREATE TABLE session (${sessionColumns})`);
  db.exec(
    `CREATE TABLE message (id text primary key, session_id text not null, data text not null)`,
  );
  db.exec(
    `CREATE TABLE part (id text primary key, message_id text not null, session_id text not null, data text not null)`,
  );
  db.exec(
    `CREATE TABLE session_entry (id text primary key, session_id text not null, type text not null, data text not null)`,
  );
  db.exec(
    `CREATE TABLE todo (session_id text not null, content text not null, status text not null,
     priority text not null, position integer not null, primary key(session_id, position))`,
  );

  const insertSession = db.prepare(
    `INSERT INTO session (id, project_id, directory, title, time_created, time_updated,
      parent_id, time_deleted${options?.slim ? "" : ", trace_id, last_outcome"})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?${options?.slim ? "" : ", ?, ?"})`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)`,
  );
  const insertPart = db.prepare(
    `INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)`,
  );
  const insertEntry = db.prepare(
    `INSERT INTO session_entry (id, session_id, type, data) VALUES (?, ?, ?, ?)`,
  );
  const insertTodo = db.prepare(
    `INSERT INTO todo (session_id, content, status, priority, position) VALUES (?, ?, ?, ?, ?)`,
  );

  for (const session of sessions) {
    insertSession.run(
      session.id,
      "proj_default",
      session.directory,
      session.title,
      session.timeCreated,
      session.timeUpdated,
      session.parentId ?? null,
      session.timeDeleted ?? null,
      ...(options?.slim ? [] : [session.traceId ?? null, session.lastOutcome ?? null]),
    );
    for (const message of session.messages ?? []) {
      insertMessage.run(message.id, session.id, message.data);
      for (const part of message.parts ?? []) {
        insertPart.run(part.id, message.id, session.id, part.data);
      }
    }
    for (const entry of session.entries ?? []) {
      insertEntry.run(entry.id, session.id, entry.type, entry.data);
    }
    for (const todo of session.todos ?? []) {
      insertTodo.run(session.id, todo.content, todo.status, todo.priority, todo.position);
    }
  }

  if (sessions.some((session) => session.linkedAsChildOf)) {
    db.exec(`CREATE TABLE session_task_link (
      id text primary key, parent_session_id text, child_session_id text not null,
      role text not null, depth integer not null default 0, path text not null,
      status text not null, time_created integer not null, time_updated integer not null)`);
    const insertLink = db.prepare(
      `INSERT INTO session_task_link (id, parent_session_id, child_session_id, role, path, status, time_created, time_updated)
       VALUES (?, ?, ?, 'child', 'p/c', 'completed', 1, 1)`,
    );
    for (const session of sessions) {
      if (session.linkedAsChildOf) {
        insertLink.run(`link-${session.id}`, session.linkedAsChildOf, session.id);
      }
    }
  }
  db.close();
}

const WORKSPACE_A = "D:/work/demo";
const WORKSPACE_B = "D:/work/other";

interface InstalledFixture {
  homeDir: string;
  sourceDataRoot: string;
  source: {
    sourceDataRoot: string;
    sourceSessionDbPath: string;
    sourceTasksIndexPath: string;
  };
  cleanup: () => Promise<void>;
}

/** 在独立临时目录里搭一套"安装版"：home + .zcode/cli/db/db.sqlite。 */
async function createInstalledFixture(sessions: SourceSessionSeed[]): Promise<InstalledFixture> {
  const homeDir = await mkdtemp(join(tmpdir(), "zcode-installed-home-"));
  const sourceDataRoot = join(homeDir, ".zcode");
  const dbPath = join(sourceDataRoot, "cli", "db", "db.sqlite");
  await mkdir(join(sourceDataRoot, "cli", "db"), { recursive: true });
  await createSessionDb(dbPath, sessions);
  return {
    homeDir,
    sourceDataRoot,
    source: {
      sourceDataRoot,
      sourceSessionDbPath: dbPath,
      sourceTasksIndexPath: join(sourceDataRoot, "v2", "tasks-index.sqlite"),
    },
    cleanup: async () => {
      await rm(homeDir, { recursive: true, force: true });
    },
  };
}

test("resolveInstalledConversationSource honors setting.json dataBaseDir and excludes same-root", async () => {
  const fixture = await createInstalledFixture([]);
  try {
    // 安装版 setting.json 显式配置 dataBaseDir：来源根切到被配置的根，且该根下必须有会话库。
    const customDataDir = join(fixture.homeDir, "custom-data");
    const customDbPath = join(customDataDir, ".zcode", "cli", "db", "db.sqlite");
    await mkdir(join(customDataDir, ".zcode", "cli", "db"), { recursive: true });
    await createSessionDb(customDbPath, []);
    const settingsFile = join(fixture.sourceDataRoot, "v2", "setting.json");
    await mkdir(join(fixture.sourceDataRoot, "v2"), { recursive: true });
    await writeFile(settingsFile, JSON.stringify({ dataBaseDir: customDataDir }));

    const resolved = await resolveInstalledConversationSource({
      currentDataBaseDir: join(fixture.homeDir, "portable"),
      homeDir: fixture.homeDir,
    });
    assert.ok(resolved);
    assert.equal(resolved.sourceDataRoot, join(customDataDir, ".zcode"));
    assert.equal(resolved.sourceSessionDbPath, customDbPath);

    // 生效根下没有会话库 → 不可用。
    assert.equal(
      await resolveInstalledConversationSource({
        currentDataBaseDir: join(fixture.homeDir, "portable"),
        homeDir: fixture.homeDir,
        pathExists: async () => false,
      }),
      null,
    );

    // 当前数据根与来源根相同（安装版内/开发态）→ 不可用。
    assert.equal(
      await resolveInstalledConversationSource({
        currentDataBaseDir: fixture.homeDir,
        homeDir: fixture.homeDir,
        readConfiguredDataBaseDir: async () => null,
      }),
      null,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("scanImportableZcodeDesktopSessions lists root sessions and filters subagents/deleted/workspace/time", async () => {
  const now = Date.now();
  const fixture = await createInstalledFixture([
    {
      id: "ses_a",
      title: "Demo 对话",
      directory: WORKSPACE_A,
      timeCreated: now - 5000,
      timeUpdated: now,
      traceId: "trace-a",
      lastOutcome: "completed",
      messages: [{ id: "m1", data: "{}" }],
    },
    {
      id: "ses_deleted",
      title: "已删除",
      directory: WORKSPACE_A,
      timeCreated: now - 5000,
      timeUpdated: now - 10,
      timeDeleted: now - 5,
    },
    {
      id: "ses_child",
      title: "子代理",
      directory: WORKSPACE_A,
      timeCreated: now - 5000,
      timeUpdated: now - 20,
      parentId: "ses_a",
    },
    {
      id: "ses_linked",
      title: "链接子代理",
      directory: WORKSPACE_A,
      timeCreated: now - 5000,
      timeUpdated: now - 30,
      linkedAsChildOf: "ses_a",
    },
    {
      id: "ses_old",
      title: "旧会话",
      directory: WORKSPACE_B,
      timeCreated: now - 90 * 24 * 3600 * 1000,
      timeUpdated: now - 80 * 24 * 3600 * 1000,
    },
  ]);
  try {
    const all = await scanImportableZcodeDesktopSessions({
      source: fixture.source,
      limit: 50,
    });
    assert.deepEqual(
      all.map((candidate) => candidate.sessionId),
      ["ses_a", "ses_old"],
    );
    assert.equal(all[0]?.provider, "zcodeDesktop");
    assert.equal(all[0]?.previewTitle, "Demo 对话");
    assert.equal(all[0]?.workspacePath, WORKSPACE_A);
    assert.equal(all[0]?.updatedAt, now);

    // 过滤输入用正斜杠形式：zcode-native 的归一化在所有平台统一斜杠、
    // 仅 win32 附加小写比较（Linux CI 上小写字面量永远匹配不上）。
    const filtered = await scanImportableZcodeDesktopSessions({
      source: fixture.source,
      workspacePath: "D:/work/demo",
    });
    assert.deepEqual(
      filtered.map((candidate) => candidate.sessionId),
      ["ses_a"],
    );

    const recent = await scanImportableZcodeDesktopSessions({
      source: fixture.source,
      modifiedSince: now - 1000,
    });
    assert.deepEqual(
      recent.map((candidate) => candidate.sessionId),
      ["ses_a"],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("importZcodeNativeSessions merges cli db rows, snapshot and index; re-import is idempotent", async () => {
  const now = Date.now();
  const fixture = await createInstalledFixture([
    {
      id: "ses_import",
      title: "安装版对话",
      directory: WORKSPACE_A,
      timeCreated: now - 5000,
      timeUpdated: now,
      traceId: "trace-import",
      lastOutcome: "completed",
      messages: [
        {
          id: "m1",
          data: JSON.stringify({ role: "user", text: "问题" }),
          parts: [{ id: "p1", data: JSON.stringify({ kind: "text", text: "问题" }) }],
        },
        {
          id: "m2",
          data: JSON.stringify({ role: "assistant", text: "回答" }),
          parts: [{ id: "p2", data: JSON.stringify({ kind: "tool_call", name: "read" }) }],
        },
      ],
      entries: [{ id: "e1", type: "compaction", data: "{}" }],
      todos: [{ content: "跟进", status: "pending", priority: "medium", position: 0 }],
    },
    {
      id: "ses_missing",
      title: "不在源里",
      directory: WORKSPACE_A,
      timeCreated: now,
      timeUpdated: now,
    },
  ]);
  const portableDir = await mkdtemp(join(tmpdir(), "zcode-portable-data-"));
  setDataBaseDir(portableDir);
  const taskIndexRepo = new TaskIndexRepo();
  const importedMetas: ZCodeTaskMeta[] = [];
  try {
    // 源快照放在任意 hash 目录，证明目标侧按自身 hash 约定重算落盘。
    const snapshotDir = join(fixture.sourceDataRoot, "v2", "sessions", "somehash");
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(
      join(snapshotDir, "ses_import.json"),
      JSON.stringify({ meta: { taskId: "ses_import" }, messages: [] }),
    );

    const result = await importZcodeNativeSessions({
      taskIndexRepo,
      source: fixture.source,
      sessionIds: ["ses_import", "ses_missing", "ses_unknown"],
      onTaskImported: (meta) => {
        importedMetas.push(meta);
      },
    });
    assert.equal(result.imported.length, 2);
    assert.equal(result.imported[0]?.sessionId, "ses_import");
    // taskId 保持源 session id（原生合并不做 id 映射）。
    assert.equal(result.imported[0]?.taskId, "ses_import");
    assert.equal(result.imported[1]?.sessionId, "ses_missing");
    // ses_unknown 不在源库：按"找不到/不匹配"跳过而非失败。
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]?.sessionId, "ses_unknown");
    assert.equal(result.skipped[0]?.reason, "session_not_found_or_workspace_mismatch");
    assert.equal(result.failed.length, 0);
    assert.equal(importedMetas[0]?.migrationSource, "zcodeDesktop");

    // 会话库：session 行 + 消息/分片/条目/待办全部并入当前数据根的 CLI 会话库。
    const targetDb = new DatabaseSync(getCurrentSessionDbPath());
    try {
      const sessionRow = targetDb
        .prepare(`SELECT title, directory, time_updated FROM session WHERE id = 'ses_import'`)
        .get() as { title: string; directory: string; time_updated: number } | undefined;
      assert.ok(sessionRow);
      assert.equal(sessionRow.title, "安装版对话");
      assert.equal(sessionRow.directory, WORKSPACE_A);
      assert.equal(sessionRow.time_updated, now);
      const countOf = (sql: string): number =>
        (targetDb.prepare(sql).get() as { n: number }).n;
      assert.equal(countOf(`SELECT count(*) AS n FROM message WHERE session_id = 'ses_import'`), 2);
      assert.equal(countOf(`SELECT count(*) AS n FROM part WHERE session_id = 'ses_import'`), 2);
      assert.equal(
        countOf(`SELECT count(*) AS n FROM session_entry WHERE session_id = 'ses_import'`),
        1,
      );
      assert.equal(countOf(`SELECT count(*) AS n FROM todo WHERE session_id = 'ses_import'`), 1);
    } finally {
      targetDb.close();
    }

    // legacy 快照按目标侧 hash 约定复制。
    const targetSnapshot = getLegacyTaskSessionSnapshotPath(WORKSPACE_A, "ses_import");
    const snapshotRaw = JSON.parse(await readFile(targetSnapshot, "utf8")) as {
      meta: { taskId: string };
    };
    assert.equal(snapshotRaw.meta.taskId, "ses_import");

    // 任务索引：applyCliFacts 落行并带 zcodeDesktop 迁移标记。
    const indexedMeta = await taskIndexRepo.getTaskMeta({
      taskId: "ses_import",
      workspacePath: WORKSPACE_A,
    });
    assert.equal(indexedMeta?.title, "安装版对话");
    assert.equal(indexedMeta?.migrationSource, "zcodeDesktop");

    // 用户把导入任务归档后重导：目标状态优先（保持归档、不回滚），结果收敛为 skipped。
    await taskIndexRepo.updateTaskState({
      workspacePath: WORKSPACE_A,
      taskId: "ses_import",
      patch: { archived: true },
    });
    const rerun = await importZcodeNativeSessions({
      taskIndexRepo,
      source: fixture.source,
      sessionIds: ["ses_import"],
      onTaskImported: () => {},
    });
    assert.equal(rerun.imported.length, 0);
    assert.equal(rerun.skipped.length, 1);
    assert.equal(rerun.skipped[0]?.reason, "already_imported");
  } finally {
    taskIndexRepo.close();
    setDataBaseDir(null);
    await rm(portableDir, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("importZcodeNativeSessions tolerates source schema drift and fresh portable data root", async () => {
  const now = Date.now();
  // slim 源库缺 trace_id/last_outcome 列（旧版本），列交集合并应忽略缺失列。
  const homeDir = await mkdtemp(join(tmpdir(), "zcode-installed-slim-"));
  const sourceDataRoot = join(homeDir, ".zcode");
  const dbPath = join(sourceDataRoot, "cli", "db", "db.sqlite");
  await mkdir(join(sourceDataRoot, "cli", "db"), { recursive: true });
  await createSessionDb(
    dbPath,
    [
      {
        id: "ses_slim",
        title: "旧版本会话",
        directory: WORKSPACE_A,
        timeCreated: now - 1000,
        timeUpdated: now,
        messages: [{ id: "m1", data: "{}" }],
      },
    ],
    { slim: true },
  );
  const portableDir = await mkdtemp(join(tmpdir(), "zcode-portable-fresh-"));
  setDataBaseDir(portableDir);
  const taskIndexRepo = new TaskIndexRepo();
  try {
    const result = await importZcodeNativeSessions({
      taskIndexRepo,
      source: {
        sourceDataRoot,
        sourceSessionDbPath: dbPath,
        sourceTasksIndexPath: join(sourceDataRoot, "v2", "tasks-index.sqlite"),
      },
      sessionIds: ["ses_slim"],
      onTaskImported: () => {},
    });
    assert.equal(result.imported.length, 1);

    // 全新便携数据根没有 CLI 会话库：以源库副本为初始库落位，行可查。
    const targetDb = new DatabaseSync(getCurrentSessionDbPath());
    try {
      const row = targetDb
        .prepare(`SELECT title FROM session WHERE id = 'ses_slim'`)
        .get() as { title: string } | undefined;
      assert.equal(row?.title, "旧版本会话");
    } finally {
      targetDb.close();
    }
  } finally {
    taskIndexRepo.close();
    setDataBaseDir(null);
    await rm(portableDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("importZcodeNativeSessions skips sessions outside the workspace filter", async () => {
  const now = Date.now();
  const fixture = await createInstalledFixture([
    {
      id: "ses_other",
      title: "其它 workspace",
      directory: WORKSPACE_B,
      timeCreated: now,
      timeUpdated: now,
    },
  ]);
  const portableDir = await mkdtemp(join(tmpdir(), "zcode-portable-filter-"));
  setDataBaseDir(portableDir);
  const taskIndexRepo = new TaskIndexRepo();
  try {
    const result = await importZcodeNativeSessions({
      taskIndexRepo,
      source: fixture.source,
      workspacePath: WORKSPACE_A,
      sessionIds: ["ses_other"],
      onTaskImported: () => {},
    });
    assert.equal(result.imported.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]?.reason, "session_not_found_or_workspace_mismatch");
  } finally {
    taskIndexRepo.close();
    setDataBaseDir(null);
    await rm(portableDir, { recursive: true, force: true });
    await fixture.cleanup();
  }
});
