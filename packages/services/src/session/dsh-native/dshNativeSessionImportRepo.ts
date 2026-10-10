import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import type { ZCodeImportableSessionCandidate } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { readDshSessionLogHead } from "#src/session/dsh-native/dshSessionLogReader.js";

const logger = createServiceLogger("dsh-native-import");

const SESSION_FILE_PATTERN = /^session\.v(\d+)\.jsonl\.zstd$/u;

function normalizePathForComparison(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

interface SessionHeadInfo {
  sessionId: string;
  workspacePath: string;
  createdAt?: number;
  previewTitle?: string;
}

/** 从头部记录提取 session 头（cwd/id/createdAt）与尽量早的标题/首条用户消息预览。 */
function extractSessionHeadInfo(
  records: readonly Record<string, unknown>[],
  fallbackSessionId: string,
): SessionHeadInfo | null {
  let sessionId: string | undefined;
  let workspacePath: string | undefined;
  let createdAt: number | undefined;
  let explicitTitle: string | undefined;
  let firstUserText: string | undefined;

  for (const record of records) {
    if (record.type === "session") {
      if (typeof record.id === "string" && record.id.trim()) {
        sessionId = record.id.trim();
      }
      if (typeof record.cwd === "string" && record.cwd.trim()) {
        workspacePath = record.cwd.trim();
      }
      if (typeof record.createdAt === "number" && Number.isFinite(record.createdAt)) {
        createdAt = Math.trunc(record.createdAt);
      }
      continue;
    }
    if (record.type === "session/title") {
      const data = record.data as Record<string, unknown> | undefined;
      if (data && typeof data.title === "string" && data.title.trim()) {
        explicitTitle = data.title.trim();
      }
      continue;
    }
    if (record.type === "user/message" && firstUserText === undefined) {
      const data = record.data as Record<string, unknown> | undefined;
      const content = data?.content;
      const blocks = Array.isArray(content) ? content : content ? [content] : [];
      for (const block of blocks) {
        if (
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          const text = ((block as Record<string, unknown>).text as string).trim();
          if (text) {
            firstUserText = text;
          }
          break;
        }
      }
    }
  }

  if (!workspacePath) {
    return null;
  }
  return {
    sessionId: sessionId ?? fallbackSessionId,
    workspacePath,
    ...(createdAt ? { createdAt } : {}),
    previewTitle: explicitTitle ?? firstUserText?.slice(0, 50),
  };
}

/** 目录内可能同时存在 v3/v4；高版本文件是该版本的完整日志，只读最高版本。 */
function pickLatestSessionFile(files: readonly string[]): { file: string; version: number } | null {
  let latest: { file: string; version: number } | null = null;
  for (const file of files) {
    const match = SESSION_FILE_PATTERN.exec(file);
    if (!match) {
      continue;
    }
    const version = Number.parseInt(match[1] ?? "0", 10);
    if (!latest || version > latest.version) {
      latest = { file, version };
    }
  }
  return latest;
}

/**
 * DeepSeek Harness 原生历史的只读仓库。
 *
 * 关键业务逻辑：DSH 把每个会话存成
 * ~/.dsh/sessions/<workspace-slug>/<session-dir>/session.v{N}.jsonl.zstd
 * （多 zstd frame 拼接的事件流）。扫描只解压头部若干帧拿 session 头（cwd 即 workspace 归属，
 * 不解析目录 slug）；导入时才全量解压。import-* 目录（dsh-chat-import 产物）按普通候选展示。
 */
class DshNativeSessionImportRepo {
  private getNativeSessionsRoots(): string[] {
    const roots = new Set<string>();
    roots.add(join(homedir(), ".dsh", "sessions"));

    const envHome = process.env.HOME?.trim();
    if (envHome) {
      roots.add(join(envHome, ".dsh", "sessions"));
    }

    return [...roots];
  }

  async scanImportableSessions(params: {
    workspacePath?: string;
    modifiedSince?: number;
    limit?: number;
    /** 测试/高级用法注入的 sessions 根目录；缺省解析 ~/.dsh/sessions（含 HOME 覆盖）。 */
    sessionsRoots?: readonly string[];
  }): Promise<ZCodeImportableSessionCandidate[]> {
    const workspaceKey = params.workspacePath
      ? normalizePathForComparison(params.workspacePath)
      : null;
    const candidates: ZCodeImportableSessionCandidate[] = [];

    for (const sessionsRoot of params.sessionsRoots ?? this.getNativeSessionsRoots()) {
      let workspaceDirs;
      try {
        workspaceDirs = await readdir(sessionsRoot, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const workspaceDir of workspaceDirs) {
        if (!workspaceDir.isDirectory()) {
          continue;
        }
        const workspacePath = join(sessionsRoot, workspaceDir.name);
        let sessionDirs;
        try {
          sessionDirs = await readdir(workspacePath, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const sessionDir of sessionDirs) {
          if (!sessionDir.isDirectory()) {
            continue;
          }
          const sessionDirPath = join(workspacePath, sessionDir.name);
          try {
            let files;
            try {
              files = await readdir(sessionDirPath);
            } catch {
              continue;
            }
            const latest = pickLatestSessionFile(files);
            if (!latest) {
              continue;
            }
            const filePath = join(sessionDirPath, latest.file);

            const fileStat = await stat(filePath);
            const updatedAt = Math.trunc(fileStat.mtimeMs);
            if (params.modifiedSince !== undefined && updatedAt < params.modifiedSince) {
              continue;
            }

            const headRecords = await readDshSessionLogHead(filePath);
            const head = extractSessionHeadInfo(headRecords, sessionDir.name);
            if (!head) {
              continue;
            }
            if (
              workspaceKey !== null &&
              normalizePathForComparison(head.workspacePath) !== workspaceKey
            ) {
              continue;
            }

            candidates.push({
              provider: "deepseekHarness",
              sessionId: head.sessionId,
              workspacePath: head.workspacePath,
              sourcePath: filePath,
              updatedAt,
              ...(head.createdAt ? { createdAt: head.createdAt } : {}),
              ...(head.previewTitle ? { previewTitle: head.previewTitle } : {}),
            });
          } catch (error) {
            logger.warn(
              undefined,
              `扫描 DSH 原生 session 失败 dir=${sessionDirPath}`,
              error,
            );
          }
        }
      }
    }

    candidates.sort((left, right) => right.updatedAt - left.updatedAt);
    const limited =
      typeof params.limit === "number" && params.limit > 0
        ? candidates.slice(0, params.limit)
        : candidates;

    logger.info(
      undefined,
      `DSH 原生 session 扫描完成 workspaceFilter=${params.workspacePath ?? "all"} candidateCount=${limited.length}`,
    );
    return limited;
  }

  async findImportableSession(params: {
    workspacePath?: string;
    sessionId: string;
    /** 测试/高级用法注入的 sessions 根目录。 */
    sessionsRoots?: readonly string[];
  }): Promise<ZCodeImportableSessionCandidate | null> {
    const all = await this.scanImportableSessions({
      workspacePath: params.workspacePath,
      sessionsRoots: params.sessionsRoots,
    });
    return all.find((candidate) => candidate.sessionId === params.sessionId) ?? null;
  }
}

export const dshNativeSessionImportRepo = new DshNativeSessionImportRepo();
