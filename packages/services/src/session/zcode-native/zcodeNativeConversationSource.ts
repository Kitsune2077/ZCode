import { access, copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ZCodeImportableSessionCandidate } from "@zcode/shared";
import { getDataBaseDir, getZCodeDataRootDir } from "#src/paths.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const logger = createServiceLogger("zcode-native-import");

/** 安装版对话来源的解析结果；三个路径都以安装版数据根为基准。 */
export interface ZcodeNativeConversationSource {
  sourceDataRoot: string;
  sourceSessionDbPath: string;
  sourceTasksIndexPath: string;
}

function normalizePathForComparison(path: string): string {
  const normalized = path.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 读取 setting.json 顶层 dataBaseDir 字段；文件缺失/解析失败一律视为无显式配置。 */
async function readConfiguredDataBaseDir(settingsFile: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(settingsFile, "utf8")) as {
      dataBaseDir?: unknown;
    };
    return typeof raw.dataBaseDir === "string" && raw.dataBaseDir.trim().length > 0
      ? raw.dataBaseDir.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * 解析本机安装版对话来源（见 specs/installed-conversation-import.md 第 2 节）。
 *
 * 安装版 settings 锚点恒在真实 HOME；其 setting.json 显式配置的 dataBaseDir 优先。
 * 与当前数据根同根（开发态/安装版内运行）或源会话库不存在时返回 null——
 * 前者表示"没有另一套安装版数据"，后者表示"安装版从未使用"，两者对 UI 同义。
 */
export async function resolveInstalledConversationSource(options?: {
  currentDataBaseDir?: string;
  homeDir?: string;
  readConfiguredDataBaseDir?: (settingsFile: string) => Promise<string | null>;
  pathExists?: (path: string) => Promise<boolean>;
}): Promise<ZcodeNativeConversationSource | null> {
  const home = options?.homeDir ?? homedir();
  const currentDataBaseDir = options?.currentDataBaseDir ?? getDataBaseDir();
  const readConfigured =
    options?.readConfiguredDataBaseDir ?? readConfiguredDataBaseDir;
  const exists = options?.pathExists ?? pathExists;

  const installedDataBaseDir =
    (await readConfigured(join(home, ".zcode", "v2", "setting.json"))) ?? home;
  const sourceDataRoot = join(installedDataBaseDir, ".zcode");
  const currentDataRoot = join(currentDataBaseDir, ".zcode");
  if (normalizePathForComparison(sourceDataRoot) === normalizePathForComparison(currentDataRoot)) {
    return null;
  }
  const sourceSessionDbPath = join(sourceDataRoot, "cli", "db", "db.sqlite");
  if (!(await exists(sourceSessionDbPath))) {
    return null;
  }
  return {
    sourceDataRoot,
    sourceSessionDbPath,
    sourceTasksIndexPath: join(sourceDataRoot, "v2", "tasks-index.sqlite"),
  };
}

/** 当前数据根下的 CLI 会话库路径（合并写入目标；agent CLI 运行期唯一写者，见 spec 第 3 节）。 */
export function getCurrentSessionDbPath(): string {
  return join(getZCodeDataRootDir(), "cli", "db", "db.sqlite");
}

/**
 * 把源会话库整文件拷贝（连同 -wal/-shm）到一次性临时目录并返回副本路径。
 * 源端保持零写入；副本打开时允许 WAL 恢复。安装版运行中时副本理论上可能撕裂，
 * 由上层按"关闭安装版后重试"提示。
 */
export async function copySessionDbToTemp(sourceSessionDbPath: string): Promise<string> {
  const tempDir = await mkdtemp(join(dirname(sourceSessionDbPath), "zcode-native-import-"));
  const copyPath = join(tempDir, "db.sqlite");
  await copyFile(sourceSessionDbPath, copyPath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidePath = `${sourceSessionDbPath}${suffix}`;
    if (await pathExists(sidePath)) {
      await copyFile(sidePath, `${copyPath}${suffix}`);
    }
  }
  return copyPath;
}

export async function disposeSessionDbCopy(copyPath: string): Promise<void> {
  await rm(dirname(copyPath), { recursive: true, force: true });
}

interface SourceSessionRow {
  id: string;
  title: string;
  directory: string;
  time_created: number;
  time_updated: number;
}

/**
 * 只读扫描安装版根会话。子代理（parent_id / session_task_link）、已删除会话不出现。
 * 源库可能缺 session_task_link 表（旧版本），缺表时跳过该过滤条件。
 * schema 漂移由列交集吸收：只 SELECT 两侧都存在的列，这里恰好全部是基线列。
 */
export async function scanImportableZcodeDesktopSessions(params: {
  source: ZcodeNativeConversationSource;
  workspacePath?: string;
  modifiedSince?: number;
  limit?: number;
}): Promise<ZCodeImportableSessionCandidate[]> {
  const limit = params.limit ?? 200;
  const copyPath = await copySessionDbToTemp(params.source.sourceSessionDbPath);
  try {
    const db = new DatabaseSync(copyPath);
    try {
      const hasLinkTable = db
        .prepare(
          `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'session_task_link'`,
        )
        .get() as { n: number };
      const linkFilter =
        hasLinkTable.n > 0
          ? `AND NOT EXISTS (SELECT 1 FROM session_task_link l WHERE l.child_session_id = s.id)`
          : "";
      const rows = db
        .prepare(
          `SELECT s.id, s.title, s.directory, s.time_created, s.time_updated
           FROM session s
           WHERE s.time_deleted IS NULL
             AND s.parent_id IS NULL
             ${linkFilter}
           ORDER BY s.time_updated DESC
           LIMIT ?`,
        )
        .all(limit * 4) as unknown as SourceSessionRow[];

      const workspaceFilter = params.workspacePath
        ? normalizePathForComparison(params.workspacePath)
        : null;
      const candidates: ZCodeImportableSessionCandidate[] = [];
      for (const row of rows) {
        if (!row?.id || !row.directory) continue;
        if (
          workspaceFilter &&
          normalizePathForComparison(row.directory) !== workspaceFilter
        ) {
          continue;
        }
        if (params.modifiedSince !== undefined && row.time_updated < params.modifiedSince) {
          continue;
        }
        candidates.push({
          provider: "zcodeDesktop",
          sessionId: row.id,
          workspacePath: row.directory,
          sourcePath: params.source.sourceSessionDbPath,
          createdAt: row.time_created,
          updatedAt: row.time_updated,
          previewTitle: row.title,
        });
        if (candidates.length >= limit) break;
      }
      return candidates;
    } finally {
      db.close();
    }
  } catch (error) {
    logger.warn(
      undefined,
      `扫描安装版会话库失败 source=${params.source.sourceSessionDbPath}`,
      error,
    );
    throw error;
  } finally {
    await disposeSessionDbCopy(copyPath);
  }
}

/**
 * 在源快照根里按 taskId 定位 legacy 快照（源 hash 目录约定未知，逐目录探测；
 * 目录数是 workspace 数量级，单次导入批量内只探测一次）。
 */
export async function findSourceLegacySnapshot(
  source: ZcodeNativeConversationSource,
  taskId: string,
): Promise<string | null> {
  const sessionsRoot = join(source.sourceDataRoot, "v2", "sessions");
  let hashDirs: string[];
  try {
    hashDirs = await readdir(sessionsRoot);
  } catch {
    return null;
  }
  for (const hashDir of hashDirs) {
    const candidate = join(sessionsRoot, hashDir, `${taskId}.json`);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}
