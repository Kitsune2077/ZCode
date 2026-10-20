import { access, copyFile, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  generateTraceId,
  ZCODE_AGENT_PROVIDER,
  type ZCodeImportSessionsResult,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  getLegacyTaskSessionSnapshotPath,
  getZCodeDataRootDir,
} from "#src/paths.js";
import {
  getCurrentSessionDbPath,
} from "#src/session/zcode-native/zcodeNativeConversationSource.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import {
  assignImportedTaskProject,
  copyProjectMemoryForDirectory,
  readSourceTaskProjectAssignments,
} from "#src/session/zcode-native/zcodeNativeProjectImport.js";
import {
  copySessionDbToTemp,
  disposeSessionDbCopy,
  findSourceLegacySnapshot,
  type ZcodeNativeConversationSource,
} from "#src/session/zcode-native/zcodeNativeConversationSource.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const logger = createServiceLogger("zcode-native-import");

function normalizePathForComparison(path: string): string {
  const normalized = path.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

type Database = InstanceType<typeof DatabaseSync>;

/** 各表两侧交集列；schema 漂移以列交集吸收（spec 第 2 节）。 */
interface MergeColumns {
  session: string[];
  message: string[];
  part: string[];
  session_entry: string[];
  todo: string[];
}

type SqlParams = Parameters<ReturnType<Database["prepare"]>["run"]>;

function intersectColumns(db: Database, table: string, otherDb: Database): string[] {
  const columnsOf = (handle: Database): string[] => {
    const rows = handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return rows.map((row) => row.name);
  };
  const own = new Set(columnsOf(db));
  return columnsOf(otherDb).filter((name) => own.has(name));
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const MERGED_TABLES = ["session", "message", "part", "session_entry", "todo"] as const;

/** 遥测/统计/运行态表不合并（spec 第 5 节）：用量面板会重复计数，workflow 链路依赖未迁移的父表。 */

interface SessionMergeOutcome {
  sessionRowNew: boolean;
  mergedChildRows: number;
}

function mergeSessionRows(params: {
  target: Database;
  source: Database;
  sessionId: string;
  columns: MergeColumns;
}): SessionMergeOutcome {
  const { target, source, sessionId, columns } = params;
  const result: SessionMergeOutcome = { sessionRowNew: false, mergedChildRows: 0 };

  target.exec("BEGIN IMMEDIATE");
  try {
    const sessionCols = columns.session;
    const sessionRow = source
      .prepare(
        `SELECT ${sessionCols.map(quoteIdent).join(", ")} FROM session WHERE id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!sessionRow) {
      throw new Error("session_not_found_in_source");
    }
    const existing = target.prepare(`SELECT 1 FROM session WHERE id = ?`).get(sessionId);
    result.sessionRowNew = !existing;

    const insertSession = target.prepare(
      `INSERT OR IGNORE INTO session (${sessionCols.map(quoteIdent).join(", ")})
       VALUES (${sessionCols.map(() => "?").join(", ")})`,
    );
    insertSession.run(
      ...sessionCols.map((col) => sessionRow[col]) as SqlParams,
    );

    for (const table of MERGED_TABLES.slice(1)) {
      const cols = columns[table];
      if (cols.length === 0) continue;
      const childRows = source
        .prepare(
          `SELECT ${cols.map(quoteIdent).join(", ")} FROM ${quoteIdent(table)}
           WHERE session_id = ?`,
        )
        .all(sessionId) as Array<Record<string, unknown>>;
      if (childRows.length === 0) continue;
      const insertChild = target.prepare(
        `INSERT OR IGNORE INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(", ")})
         VALUES (${cols.map(() => "?").join(", ")})`,
      );
      for (const row of childRows) {
        const changes = insertChild.run(...cols.map((col) => row[col]) as SqlParams).changes;
        result.mergedChildRows += Number(changes);
      }
    }

    target.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      target.exec("ROLLBACK");
    } catch {
      // 事务已由 SQLite 自行回滚（如 BEGIN 未成功），忽略二次回滚错误。
    }
    throw error;
  }
}

/**
 * 把安装版勾选的会话原生合并进当前数据根（CLI 会话库 + legacy 快照 + 任务索引）。
 * taskId 即源 session id，永不改写；冲突一律目标状态优先（幂等，spec 第 5 节）。
 */
export async function importZcodeNativeSessions(params: {
  taskIndexRepo: TaskIndexRepo;
  source: ZcodeNativeConversationSource;
  workspacePath?: string;
  sessionIds: string[];
  onTaskImported: (meta: ZCodeTaskMeta) => void;
}): Promise<ZCodeImportSessionsResult> {
  const normalizedSessionIds = [
    ...new Set(params.sessionIds.map((item) => item.trim()).filter(Boolean)),
  ];
  const result: ZCodeImportSessionsResult = {
    imported: [],
    skipped: [],
    failed: [],
  };
  if (normalizedSessionIds.length === 0) {
    return result;
  }

  logger.info(
    undefined,
    `开始导入安装版对话 workspaceFilter=${params.workspacePath ?? "all"} count=${normalizedSessionIds.length}`,
  );

  const targetDbPath = getCurrentSessionDbPath();
  const copyPath = await copySessionDbToTemp(params.source.sourceSessionDbPath);
  let target: Database | null = null;
  let sourceDb: Database | null = null;
  try {
    await mkdir(dirname(targetDbPath), { recursive: true });
    try {
      await access(targetDbPath, fsConstants.F_OK);
    } catch {
      // 全新便携数据根没有 CLI 会话库：直接以源库副本为初始库，
      // schema 版本差异由 agent CLI 启动迁移收敛（它本就要支持旧版本库）。
      await copyFile(copyPath, targetDbPath);
    }
    target = new DatabaseSync(targetDbPath);
    target.exec("PRAGMA busy_timeout = 5000");
    // 会话行/子行整体落地不依赖源端 FK 链上的 workflow 等表（这些表不迁移）。
    target.exec("PRAGMA foreign_keys = OFF");
    sourceDb = new DatabaseSync(copyPath);

    const columns: MergeColumns = {
      session: [],
      message: [],
      part: [],
      session_entry: [],
      todo: [],
    };
    for (const table of MERGED_TABLES) {
      columns[table] = intersectColumns(target, table, sourceDb);
    }
    if (columns.session.length === 0) {
      throw new Error("source session schema unreadable");
    }

    // 项目归属与记忆随导入带入（spec 第 1/3 节）：读取失败/无源索引走"按目录建单
    // root 项目"回退；两个仓库句柄在批次内共享（归属按目录缓存，同目录只解析一次）。
    const sourceProjects = await readSourceTaskProjectAssignments(
      params.source,
      normalizedSessionIds,
    );
    const projectRepository = await params.taskIndexRepo.getProjectRepository();
    const resolvedProjectsByDirectory = new Map<string, string>();
    const memoryCopiedDirectories = new Set<string>();
    const targetMemoriesProjectsRoot = join(getZCodeDataRootDir(), "cli", "memories", "projects");

    for (const sessionId of normalizedSessionIds) {
      try {
        // 索引 meta 所需字段按交集列选取：旧版源库可能没有 trace_id/last_outcome。
        const metaColumns = ["id", "directory", "title", "time_created", "time_updated", "trace_id", "last_outcome"]
          .filter((name) => columns.session.includes(name));
        const sourceSession = sourceDb
          .prepare(`SELECT ${metaColumns.map(quoteIdent).join(", ")}
                    FROM session WHERE id = ?`)
          .get(sessionId) as
          | (Partial<{
              id: string;
              directory: string;
              title: string;
              time_created: number;
              time_updated: number;
              trace_id: string;
              last_outcome: string;
            }> & { id: string })
          | undefined;
        if (!sourceSession?.directory) {
          result.skipped.push({
            provider: "zcodeDesktop",
            sessionId,
            reason: "session_not_found_or_workspace_mismatch",
          });
          continue;
        }
        if (
          params.workspacePath &&
          normalizePathForComparison(sourceSession.directory) !==
            normalizePathForComparison(params.workspacePath)
        ) {
          result.skipped.push({
            provider: "zcodeDesktop",
            sessionId,
            reason: "session_not_found_or_workspace_mismatch",
            workspacePath: sourceSession.directory,
          });
          continue;
        }

        // 目标索引里是否已有该任务：全新便携以源库副本为初始库时，合并多为 no-op，
        // "对用户是否新任务"以索引行（任务列表可见性）为准（spec 第 5 节幂等语义）。
        const indexBefore = await params.taskIndexRepo.getTaskMeta({
          taskId: sessionId,
          workspacePath: sourceSession.directory,
        });

        const merge = mergeSessionRows({
          target,
          source: sourceDb,
          sessionId,
          columns,
        });

        // legacy 快照：源存在且目标不存在时复制，hash 按目标侧约定重算（无 identity）。
        const targetSnapshotPath = getLegacyTaskSessionSnapshotPath(
          sourceSession.directory,
          sessionId,
        );
        const sourceSnapshotPath = await findSourceLegacySnapshot(
          params.source,
          sessionId,
        );
        if (sourceSnapshotPath) {
          await mkdir(dirname(targetSnapshotPath), { recursive: true });
          await copyFile(sourceSnapshotPath, targetSnapshotPath);
        }

        const indexMeta: ZCodeTaskMeta = {
          taskId: sessionId,
          workspacePath: sourceSession.directory,
          traceId: sourceSession.trace_id ?? generateTraceId(sessionId),
          title: sourceSession.title ?? sessionId,
          createdAt: sourceSession.time_created ?? 0,
          updatedAt: sourceSession.time_updated ?? 0,
          mode: "default",
          provider: ZCODE_AGENT_PROVIDER,
          migrationSource: "zcodeDesktop",
          ...(sourceSession.last_outcome
            ? { status: sourceSession.last_outcome === "error" ? "error" : "completed" }
            : {}),
        };
        const indexedMeta = await params.taskIndexRepo.applyCliFacts({
          meta: indexMeta,
          lastOutcome:
            sourceSession.last_outcome === "completed" ||
            sourceSession.last_outcome === "interrupted" ||
            sourceSession.last_outcome === "error"
              ? sourceSession.last_outcome
              : undefined,
        });

        if (!merge.sessionRowNew && merge.mergedChildRows === 0 && indexBefore) {
          result.skipped.push({
            provider: "zcodeDesktop",
            sessionId,
            reason: "already_imported",
            workspacePath: sourceSession.directory,
          });
          continue;
        }

        // 项目归属：失败只降级为未归类（任务区可见），不把整个会话记为导入失败。
        try {
          await assignImportedTaskProject({
            projectRepository,
            taskId: sessionId,
            workspacePath: sourceSession.directory,
            sourceProject: sourceProjects.get(sessionId),
            resolvedProjectsByDirectory,
          });
        } catch (error) {
          logger.warn(undefined, `导入安装版对话的项目归属失败 session=${sessionId}`, error);
        }

        // 项目记忆：同目录只复制一次；失败不影响导入结果。
        if (!memoryCopiedDirectories.has(sourceSession.directory)) {
          memoryCopiedDirectories.add(sourceSession.directory);
          try {
            const copied = await copyProjectMemoryForDirectory({
              sourceDataRoot: params.source.sourceDataRoot,
              targetMemoriesProjectsRoot,
              workspacePath: sourceSession.directory,
            });
            if (copied > 0) {
              logger.info(
                undefined,
                `已复制安装版项目记忆 directory=${sourceSession.directory} files=${copied}`,
              );
            }
          } catch (error) {
            logger.warn(
              undefined,
              `复制安装版项目记忆失败 directory=${sourceSession.directory}`,
              error,
            );
          }
        }

        const meta = indexedMeta ?? indexMeta;
        params.onTaskImported(meta);
        result.imported.push({
          provider: "zcodeDesktop",
          sessionId,
          taskId: sessionId,
          workspacePath: sourceSession.directory,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn(undefined, `导入安装版对话失败 session=${sessionId}`, error);
        result.failed.push({
          provider: "zcodeDesktop",
          sessionId,
          reason,
        });
      }
    }
  } catch (error) {
    // 源副本打不开 / 目标库整体不可用：所有未处理 session 记为失败，保留批内已有进度。
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(undefined, `安装版对话导入批次失败`, error);
    const handled = new Set([
      ...result.imported.map((item) => item.sessionId),
      ...result.skipped.map((item) => item.sessionId),
      ...result.failed.map((item) => item.sessionId),
    ]);
    for (const sessionId of normalizedSessionIds) {
      if (!handled.has(sessionId)) {
        result.failed.push({ provider: "zcodeDesktop", sessionId, reason });
      }
    }
  } finally {
    try {
      sourceDb?.close();
    } catch {
      // 关闭失败不影响主流程
    }
    try {
      target?.close();
    } catch {
      // 关闭失败不影响主流程
    }
    await disposeSessionDbCopy(copyPath);
  }

  logger.info(
    undefined,
    `安装版对话导入完成 imported=${result.imported.length} skipped=${result.skipped.length} failed=${result.failed.length}`,
  );
  return result;
}
