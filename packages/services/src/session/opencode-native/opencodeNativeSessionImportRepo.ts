import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { createRequire } from "node:module";
import type { ZCodeImportableSessionCandidate } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  OpenCodeMessageRow,
  OpenCodePartRow,
  OpenCodeV2Row,
} from "#src/session/opencode-native/opencodeNativeSessionImportParser.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const logger = createServiceLogger("opencode-native-import");

function normalizePathForComparison(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

interface OpenCodeSessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  parent_id: string | null;
  time_archived: number | null;
  time_created: number | null;
  time_updated: number | null;
}

/** V1/V2 双 schema 的转录读取结果；V1 缺失时才读取 V2（session_message）行。 */
export interface OpenCodeNativeTranscript {
  messages: OpenCodeMessageRow[];
  partsByMessageId: Map<string, OpenCodePartRow[]>;
  v2Rows: OpenCodeV2Row[];
}

/**
 * OpenCode 原生历史的只读仓库。
 *
 * 关键业务逻辑：OpenCode 全平台把会话存在单一 SQLite 库
 * ~/.local/share/opencode/opencode.db（Windows 同路径，已实机取证），
 * V1（session/message/part）与 V2（session_message）两代 schema 并存。
 * 这里始终以 readOnly 打开，绝不写入、不复制来源库；
 * 唯一写者仍是 CLI agent 进程自己的 session store。
 */
class OpenCodeNativeSessionImportRepo {
  private getNativeDatabasePaths(): string[] {
    const dataDirs = new Set<string>();
    dataDirs.add(join(homedir(), ".local", "share"));

    const envHome = process.env.HOME?.trim();
    if (envHome) {
      dataDirs.add(join(envHome, ".local", "share"));
    }

    const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
    if (xdgDataHome) {
      dataDirs.add(xdgDataHome);
    }

    return [...dataDirs].map((dataDir) => join(dataDir, "opencode", "opencode.db"));
  }

  private openDatabase(dbPath: string): InstanceType<typeof DatabaseSync> | null {
    try {
      return new DatabaseSync(dbPath, { readOnly: true });
    } catch (error) {
      logger.warn(undefined, `打开 OpenCode 原生库失败 path=${dbPath}`, error);
      return null;
    }
  }

  private readSessionRow(
    db: InstanceType<typeof DatabaseSync>,
    sessionId: string,
  ): OpenCodeSessionRow | null {
    try {
      return (
        (db
          .prepare(
            "SELECT id, directory, title, parent_id, time_archived, time_created, time_updated FROM session WHERE id = ?",
          )
          .get(sessionId) as OpenCodeSessionRow | undefined) ?? null
      );
    } catch (error) {
      logger.warn(undefined, `读取 OpenCode 原生 session 失败 sessionId=${sessionId}`, error);
      return null;
    }
  }

  private toCandidate(row: OpenCodeSessionRow, dbPath: string): ZCodeImportableSessionCandidate | null {
    // 直接按 sessionId 导入也必须复用扫描边界：子代理（parent_id）与已归档会话不可导入，
    // 防止 UI 过滤后仍能按 id 导入 sidechain（与 Claude 侧 findSessionFile 的边界一致）。
    if (row.parent_id || row.time_archived) {
      return null;
    }
    // directory 是 OpenCode 会话的 workspace 归属（等价于 Claude jsonl 里的 cwd），
    // 缺失时无法判定导入落点，直接跳过而不是猜测。
    const workspacePath = row.directory?.trim();
    if (!workspacePath || !row.id) {
      return null;
    }
    return {
      provider: "openCode",
      sessionId: row.id,
      workspacePath,
      sourcePath: dbPath,
      updatedAt: row.time_updated ?? row.time_created ?? 0,
      ...(row.time_created ? { createdAt: row.time_created } : {}),
      ...(row.title?.trim() ? { previewTitle: row.title.trim() } : {}),
    };
  }

  async scanImportableSessions(params: {
    workspacePath?: string;
    modifiedSince?: number;
    limit?: number;
    /** 测试/高级用法注入的来源库路径；缺省解析 ~/.local/share/opencode（含 XDG/HOME 覆盖）。 */
    databasePaths?: readonly string[];
  }): Promise<ZCodeImportableSessionCandidate[]> {
    const workspaceKey = params.workspacePath
      ? normalizePathForComparison(params.workspacePath)
      : null;
    const candidates: ZCodeImportableSessionCandidate[] = [];

    for (const dbPath of params.databasePaths ?? this.getNativeDatabasePaths()) {
      const db = this.openDatabase(dbPath);
      if (!db) {
        continue;
      }

      try {
        const rows = db
          .prepare(
            [
              "SELECT id, directory, title, parent_id, time_archived, time_created, time_updated FROM session",
              // 子代理会话（parent_id 非空）是 sidechain，与 Claude 的 isSidechain 过滤同语义；
              // 已归档会话对用户不可见，都不进入迁移候选。
              "WHERE parent_id IS NULL AND time_archived IS NULL",
              ...(params.modifiedSince !== undefined ? ["AND time_updated >= ?"] : []),
              "ORDER BY time_updated DESC",
            ].join(" "),
          )
          .all(...(params.modifiedSince !== undefined ? [params.modifiedSince] : [])) as unknown as (
          | OpenCodeSessionRow
          | undefined
        )[];

        for (const row of rows) {
          if (!row) {
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
        logger.warn(undefined, `扫描 OpenCode 原生库失败 path=${dbPath}`, error);
      } finally {
        db.close();
      }
    }

    candidates.sort((left, right) => right.updatedAt - left.updatedAt);
    const limited =
      typeof params.limit === "number" && params.limit > 0
        ? candidates.slice(0, params.limit)
        : candidates;

    logger.info(
      undefined,
      `OpenCode 原生 session 扫描完成 workspaceFilter=${params.workspacePath ?? "all"} candidateCount=${limited.length}`,
    );
    return limited;
  }

  async findImportableSession(params: {
    workspacePath?: string;
    sessionId: string;
    /** 测试/高级用法注入的来源库路径；缺省解析 ~/.local/share/opencode（含 XDG/HOME 覆盖）。 */
    databasePaths?: readonly string[];
  }): Promise<ZCodeImportableSessionCandidate | null> {
    const workspaceKey = params.workspacePath
      ? normalizePathForComparison(params.workspacePath)
      : null;

    for (const dbPath of params.databasePaths ?? this.getNativeDatabasePaths()) {
      const db = this.openDatabase(dbPath);
      if (!db) {
        continue;
      }

      try {
        const row = this.readSessionRow(db, params.sessionId);
        if (!row) {
          continue;
        }
        if (
          workspaceKey !== null &&
          normalizePathForComparison(row.directory ?? "") !== workspaceKey
        ) {
          continue;
        }
        return this.toCandidate(row, dbPath);
      } finally {
        db.close();
      }
    }

    return null;
  }

  /** 读取单个 session 的完整转录（V1 优先，V2 兜底）；只读、按需打开。 */
  async readSessionTranscript(params: {
    sessionId: string;
    sourcePath: string;
  }): Promise<OpenCodeNativeTranscript> {
    const db = this.openDatabase(params.sourcePath);
    if (!db) {
      throw new Error(`[opencode-native] 无法打开 OpenCode 原生库: ${params.sourcePath}`);
    }

    try {
      const messages = (
        db
          .prepare(
            "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, rowid",
          )
          .all(params.sessionId) as Array<{ id: string; time_created: number | null; data: unknown }>
      ).map((row) => ({ id: row.id, timeCreated: row.time_created, data: row.data }));

      const partsByMessageId = new Map<string, OpenCodePartRow[]>();
      if (messages.length > 0) {
        const partRows = db
          .prepare(
            "SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, rowid",
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

      // V2（session_message）当前版本只承载 model-switched/agent-switched 等事件；
      // 读取出来供解析器过滤，未来版本把对话消息写入该表时同样能落到导入链路。
      let v2Rows: OpenCodeV2Row[] = [];
      if (messages.length === 0) {
        v2Rows = (
          db
            .prepare(
              "SELECT type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq, time_created, rowid",
            )
            .all(params.sessionId) as Array<{
            type: string;
            seq: number | null;
            time_created: number | null;
            data: unknown;
          }>
        ).map((row) => ({
          type: row.type,
          seq: row.seq,
          timeCreated: row.time_created,
          data: row.data,
        }));
      }

      return { messages, partsByMessageId, v2Rows };
    } finally {
      db.close();
    }
  }
}

export const opencodeNativeSessionImportRepo = new OpenCodeNativeSessionImportRepo();
