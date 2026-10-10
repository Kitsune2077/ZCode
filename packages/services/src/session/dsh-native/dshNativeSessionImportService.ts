import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { ZCodeImportSessionsResult, ZCodeTaskMeta } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { buildImportedDshTaskFile } from "#src/session/dsh-native/buildImportedDshTaskFile.js";
import { dshNativeSessionImportRepo } from "#src/session/dsh-native/dshNativeSessionImportRepo.js";
import { parseDshNativeSession } from "#src/session/dsh-native/dshNativeSessionImportParser.js";
import { readDshSessionLog } from "#src/session/dsh-native/dshSessionLogReader.js";
import type { DshNativeImportedSessionSource } from "#src/session/dsh-native/dshNativeSessionTypes.js";
import { buildSearchableTextFromMessages } from "#src/session/claude-native/persistImportedClaudeTask.js";
import {
  parseLegacyTaskSessionFile,
  writeImportedLegacyTaskSnapshot,
} from "#src/session/legacyTaskSessionFile.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const logger = createServiceLogger("dsh-native-import");

async function workspacePathExists(workspacePath: string): Promise<boolean> {
  try {
    await access(workspacePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function importDshNativeSessions(params: {
  taskIndexRepo: TaskIndexRepo;
  workspacePath?: string;
  workspaceIdentity?: string;
  sessionIds: string[];
  createImportedSession?: (source: DshNativeImportedSessionSource) => Promise<ZCodeTaskMeta>;
  onTaskImported: (meta: ZCodeTaskMeta) => void;
  /** 测试/高级用法注入的 sessions 根目录；缺省解析 ~/.dsh/sessions（含 HOME 覆盖）。 */
  sessionsRoots?: readonly string[];
}): Promise<ZCodeImportSessionsResult> {
  const normalizedSessionIds = [
    ...new Set(params.sessionIds.map((item) => item.trim()).filter(Boolean)),
  ];
  const result: ZCodeImportSessionsResult = {
    imported: [],
    skipped: [],
    failed: [],
  };

  logger.info(
    undefined,
    `开始导入 DSH 原生 session workspaceFilter=${params.workspacePath ?? "all"} count=${normalizedSessionIds.length}`,
  );

  // DSH 的 session id 在文件内部（目录名不可靠），一次扫描建索引后按 id 匹配，
  // 避免逐条导入时重复解压全部会话头部。
  const candidates = await dshNativeSessionImportRepo.scanImportableSessions({
    workspacePath: params.workspacePath,
    ...(params.sessionsRoots ? { sessionsRoots: params.sessionsRoots } : {}),
  });
  const candidatesById = new Map(candidates.map((candidate) => [candidate.sessionId, candidate]));

  for (const sessionId of normalizedSessionIds) {
    let importedWorkspacePath: string | undefined;
    try {
      const candidate = candidatesById.get(sessionId);
      if (!candidate) {
        result.skipped.push({
          provider: "deepseekHarness",
          sessionId,
          reason: "session_not_found_or_workspace_mismatch",
          ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
        });
        continue;
      }

      importedWorkspacePath = candidate.workspacePath;
      if (!(await workspacePathExists(importedWorkspacePath))) {
        result.skipped.push({
          provider: "deepseekHarness",
          sessionId,
          reason: "workspace_path_missing",
          workspacePath: importedWorkspacePath,
        });
        continue;
      }

      const records = await readDshSessionLog(candidate.sourcePath);
      const importedSource = parseDshNativeSession({
        sessionId,
        directory: candidate.workspacePath,
        sourcePath: candidate.sourcePath,
        fallbackCreatedAt: candidate.createdAt,
        fallbackUpdatedAt: candidate.updatedAt,
        records,
      });

      const targetWorkspaceIdentity = params.workspacePath ? params.workspaceIdentity : undefined;
      let meta: ZCodeTaskMeta;
      if (params.createImportedSession) {
        meta = await params.createImportedSession(importedSource);
        const sessionFile = buildImportedDshTaskFile(importedSource, undefined, meta.taskId);
        await writeImportedLegacyTaskSnapshot({
          sessionFile: {
            ...sessionFile,
            meta: {
              ...sessionFile.meta,
              ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
            },
          },
        });
        meta = await params.taskIndexRepo.syncTaskMeta({
          meta: {
            ...meta,
            migrationSource: "deepseekHarness",
            workspaceIdentity: targetWorkspaceIdentity ?? meta.workspaceIdentity,
          },
          searchableText: buildSearchableTextFromMessages(sessionFile.messages),
          // 已导入会话被删除/归档后再次导入，不能继承旧行隐藏状态（与 Claude/OpenCode 导入同因）。
          archived: false,
          deleted: false,
        });
      } else {
        // 无 RPC 回调的兜底路径（测试/legacy）：只落 legacy snapshot + 索引行。
        const sessionFile = buildImportedDshTaskFile(importedSource);
        await writeImportedLegacyTaskSnapshot({
          sessionFile: {
            ...sessionFile,
            meta: {
              ...sessionFile.meta,
              ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
            },
          },
        });
        const parsed = parseLegacyTaskSessionFile(sessionFile);
        meta = await params.taskIndexRepo.syncTaskMeta({
          meta: {
            ...parsed.meta,
            ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
            mode: parsed.meta.mode ?? "build",
          },
          searchableText: buildSearchableTextFromMessages(parsed.messages),
          archived: false,
          deleted: false,
        });
      }
      params.onTaskImported(meta);

      result.imported.push({
        provider: "deepseekHarness",
        sessionId,
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(undefined, `导入 DSH 原生 session 失败 session=${sessionId}`, error);
      result.failed.push({
        provider: "deepseekHarness",
        sessionId,
        reason,
        ...(importedWorkspacePath ? { workspacePath: importedWorkspacePath } : {}),
      });
    }
  }

  logger.info(
    undefined,
    `DSH 原生 session 导入完成 imported=${result.imported.length} skipped=${result.skipped.length} failed=${result.failed.length}`,
  );
  return result;
}
