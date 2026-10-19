import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { normalize, resolve } from "node:path";
import { createRequire } from "node:module";
import type { ZCodeImportableSessionCandidate } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getDataBaseDir } from "#src/paths.js";
import type {
  ZCodeInstalledMessageRow,
  ZCodeInstalledPartRow,
} from "#src/session/zcode-installed-native/zcodeInstalledSessionImportParser.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const logger = createServiceLogger("zcode-installed-import");

const SESSION_DB_RELATIVE_PATH = ["cli", "db", "db.sqlite"];

function normalizePathForComparison(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

interface ZCodeInstalledSessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  parent_id: string | null;
  task_type: string | null;
  time_archived: number | null;
  time_deleted: number | null;
  time_created: number | null;
  time_updated: number | null;
}

/** 安装版转录读取结果：message 行 + 按 message 分组的 part 行（CLI 规范排序）。 */
export interface ZCodeInstalledTranscript {
  messages: ZCodeInstalledMessageRow[];
  partsByMessageId: Map<string, ZCodeInstalledPartRow[]>;
}

/**
 * 解析安装版数据位置：NSIS 安装版不重定向数据目录，会话库固定在
 * 真实用户主目录 `{homedir}/.zcode/cli/db/db.sqlite`。便携版实例的
 * ZCODE_DATA_BASE_DIR 重定向不影响 os.homedir()（引导只设置 ZCODE 专属
 * 环境变量，不改写 USERPROFILE/HOME），因此便携实例内仍能定位安装版数据。
 */
export function resolveZCodeInstalledSessionDbPath(
  homeDir: string = homedir(),
): string | null {
  const dbPath = resolve(homeDir, ".zcode", ...SESSION_DB_RELATIVE_PATH);
  return existsSync(dbPath) ? dbPath : null;
}

/**
 * ZCode 安装版历史库的只读仓库（面向 Windows 便携版实例接收安装版数据）。
 *
 * 关键业务逻辑：来源库的唯一写者是安装版自己的 CLI 进程，这里始终以
 * readOnly 打开，绝不写入、不复制来源库；当前实例的会话事实仍只能经
 * RPC session/create 创建，本仓库不成为第二条写入路径。
 */
class ZCodeInstalledSessionImportRepo {
  openDatabase(dbPath: string): InstanceType<typeof DatabaseSync> | null {
    try {
      return new DatabaseSync(dbPath, { readOnly: true });
    } catch (error) {
      logger.warn(undefined, `打开 ZCode 安装版会话库失败 path=${dbPath}`, error);
      return null;
    }
  }

  /** 自我导入防护：来源库不能是当前运行实例自己的 db.sqlite，否则会把本实例会话复制成副本。 */
  assertNotCurrentInstanceDb(dbPath: string): void {
    const currentDbPath = resolve(getDataBaseDir(), ".zcode", ...SESSION_DB_RELATIVE_PATH);
    if (normalizePathForComparison(dbPath) === normalizePathForComparison(currentDbPath)) {
      throw new Error(
        "[zcode-installed] 当前实例正在使用用户主目录数据（安装版/默认形态），无需也无法从自身导入",
      );
    }
  }

  private toCandidate(
    row: ZCodeInstalledSessionRow,
    dbPath: string,
  ): ZCodeImportableSessionCandidate | null {
    // 与扫描同一套导入边界：主会话目录缺失时无法判定导入落点，跳过而不是猜测。
    const workspacePath = row.directory?.trim();
    if (!workspacePath || !row.id) {
      return null;
    }
    return {
      provider: "zcodeInstalled",
      sessionId: row.id,
      workspacePath,
      sourcePath: dbPath,
      updatedAt: row.time_updated ?? row.time_created ?? 0,
      ...(row.time_created ? { createdAt: row.time_created } : {}),
      ...(row.title?.trim() ? { previewTitle: row.title.trim() } : {}),
    };
  }

  private isImportableSessionRow(row: ZCodeInstalledSessionRow): boolean {
    // 主会话过滤边界（与 desktop 任务列表语义对齐）：fork/sidechain（parent_id）、
    // workflow 子任务（session_task_link）、已归档与已软删除的 session 都不属于用户主列表。
    if (row.parent_id || row.time_archived || row.time_deleted) {
      return false;
    }
    return !row.task_type || row.task_type === "interactive";
  }

  private isLinkedChildSession(
    db: InstanceType<typeof DatabaseSync>,
    sessionId: string,
  ): boolean {
    try {
      const row = db
        .prepare("SELECT 1 AS hit FROM session_task_link WHERE child_session_id = ? LIMIT 1")
        .get(sessionId) as { hit: number } | undefined;
      return Boolean(row);
    } catch (error) {
      // 旧版本库可能没有 session_task_link 表；没有该表即没有 workflow 子任务可排除。
      logger.debug(undefined, `读取 session_task_link 失败（旧版库可忽略） sessionId=${sessionId}`, error);
      return false;
    }
  }

  private readSessionRow(
    db: InstanceType<typeof DatabaseSync>,
    sessionId: string,
  ): ZCodeInstalledSessionRow | null {
    try {
      return (
        (db
          .prepare(
            [
              "SELECT id, directory, title, parent_id, task_type, time_archived, time_deleted, time_created, time_updated",
              "FROM session WHERE id = ?",
            ].join(" "),
          )
          .get(sessionId) as ZCodeInstalledSessionRow | undefined) ?? null
      );
    } catch (error) {
      logger.warn(undefined, `读取 ZCode 安装版 session 失败 sessionId=${sessionId}`, error);
      return null;
    }
  }

  async scanImportableSessions(params: {
    workspacePath?: string;
    modifiedSince?: number;
    limit?: number;
    /** 测试/高级用法注入的安装版用户主目录；缺省取 os.homedir()。 */
    homeDir?: string;
    /** 测试/高级用法注入的来源库路径；缺省按 homeDir 解析。 */
    databasePath?: string;
  }): Promise<ZCodeImportableSessionCandidate[]> {
    const dbPath = params.databasePath ?? resolveZCodeInstalledSessionDbPath(params.homeDir);
    if (!dbPath) {
      throw new Error(
        "[zcode-installed] 本机用户主目录中没有找到 ZCode 安装版数据（~/.zcode/cli/db/db.sqlite）",
      );
    }
    this.assertNotCurrentInstanceDb(dbPath);
    const db = this.openDatabase(dbPath);
    if (!db) {
      throw new Error(`[zcode-installed] 无法打开 ZCode 安装版会话库: ${dbPath}`);
    }

    const workspaceKey = params.workspacePath
      ? normalizePathForComparison(params.workspacePath)
      : null;
    const candidates: ZCodeImportableSessionCandidate[] = [];

    try {
      const rows = db
        .prepare(
          [
            "SELECT id, directory, title, parent_id, task_type, time_archived, time_deleted, time_created, time_updated FROM session",
            "WHERE parent_id IS NULL AND time_archived IS NULL AND time_deleted IS NULL",
            ...(params.modifiedSince !== undefined ? ["AND time_updated >= ?"] : []),
            "ORDER BY time_updated DESC",
          ].join(" "),
        )
        .all(...(params.modifiedSince !== undefined ? [params.modifiedSince] : [])) as unknown as (
        | ZCodeInstalledSessionRow
        | undefined
      )[];

      for (const row of rows) {
        if (!row || !this.isImportableSessionRow(row)) {
          continue;
        }
        if (this.isLinkedChildSession(db, row.id)) {
          continue;
        }
        if (
          workspaceKey !== null &&
          normalizePathForComparison(row.directory ?? "") !== workspaceKey
        ) {
          continue;
        }
        const candidate = this.toCandidate(row, dbPath);
        if (candidate) {
          candidates.push(candidate);
        }
      }
    } catch (error) {
      logger.warn(undefined, `扫描 ZCode 安装版会话库失败 path=${dbPath}`, error);
    } finally {
      db.close();
    }

    const limited =
      typeof params.limit === "number" && params.limit > 0
        ? candidates.slice(0, params.limit)
        : candidates;

    logger.info(
      undefined,
      `ZCode 安装版 session 扫描完成 path=${dbPath} workspaceFilter=${params.workspacePath ?? "all"} candidateCount=${limited.length}`,
    );
    return limited;
  }

  async findImportableSession(params: {
    workspacePath?: string;
    sessionId: string;
    /** 测试/高级用法注入的安装版用户主目录；缺省取 os.homedir()。 */
    homeDir?: string;
    /** 测试/高级用法注入的来源库路径；缺省按 homeDir 解析。 */
    databasePath?: string;
  }): Promise<ZCodeImportableSessionCandidate | null> {
    const dbPath = params.databasePath ?? resolveZCodeInstalledSessionDbPath(params.homeDir);
    if (!dbPath) {
      return null;
    }
    this.assertNotCurrentInstanceDb(dbPath);
    const db = this.openDatabase(dbPath);
    if (!db) {
      return null;
    }

    const workspaceKey = params.workspacePath
      ? normalizePathForComparison(params.workspacePath)
      : null;

    try {
      const row = this.readSessionRow(db, params.sessionId);
      if (!row || !this.isImportableSessionRow(row) || this.isLinkedChildSession(db, row.id)) {
        return null;
      }
      if (
        workspaceKey !== null &&
        normalizePathForComparison(row.directory ?? "") !== workspaceKey
      ) {
        return null;
      }
      return this.toCandidate(row, dbPath);
    } finally {
      db.close();
    }
  }

  /** 读取单个 session 的完整转录；排序与 CLI session store 的规范排序一致（sequence 优先，NULL 靠后）。 */
  async readSessionTranscript(params: {
    sessionId: string;
    sourcePath: string;
  }): Promise<ZCodeInstalledTranscript> {
    this.assertNotCurrentInstanceDb(params.sourcePath);
    const db = this.openDatabase(params.sourcePath);
    if (!db) {
      throw new Error(`[zcode-installed] 无法打开 ZCode 安装版会话库: ${params.sourcePath}`);
    }

    try {
      const messages = (
        db
          .prepare(
            [
              "SELECT id, time_created, data FROM message WHERE session_id = ?",
              // CLI 规范排序：sequence 为 NULL 的旧行按写入顺序排在有 sequence 的行之后。
              "ORDER BY sequence IS NULL, sequence, time_created, rowid",
            ].join(" "),
          )
          .all(params.sessionId) as Array<{ id: string; time_created: number | null; data: unknown }>
      ).map((row) => ({ id: row.id, timeCreated: row.time_created, data: row.data }));

      const partsByMessageId = new Map<string, ZCodeInstalledPartRow[]>();
      if (messages.length > 0) {
        const partRows = db
          .prepare(
            [
              "SELECT message_id, time_created, data FROM part WHERE session_id = ?",
              "ORDER BY message_id, sequence IS NULL, sequence, time_created, id",
            ].join(" "),
          )
          .all(params.sessionId) as Array<{
          message_id: string;
          time_created: number | null;
          data: unknown;
        }>;
        for (const row of partRows) {
          const bucket = partsByMessageId.get(row.message_id) ?? [];
          bucket.push({ timeCreated: row.time_created, data: row.data });
          partsByMessageId.set(row.message_id, bucket);
        }
      }

      return { messages, partsByMessageId };
    } finally {
      db.close();
    }
  }
}

export const zcodeInstalledSessionImportRepo = new ZCodeInstalledSessionImportRepo();
