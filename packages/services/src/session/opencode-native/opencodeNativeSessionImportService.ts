import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { ZCodeImportSessionsResult, ZCodeTaskMeta } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { buildImportedOpenCodeTaskFile } from "#src/session/opencode-native/buildImportedOpenCodeTaskFile.js";
import { opencodeNativeSessionImportRepo } from "#src/session/opencode-native/opencodeNativeSessionImportRepo.js";
import { parseOpenCodeNativeSession } from "#src/session/opencode-native/opencodeNativeSessionImportParser.js";
import type { OpenCodeNativeImportedSessionSource } from "#src/session/opencode-native/opencodeNativeSessionTypes.js";
import { buildSearchableTextFromMessages } from "#src/session/claude-native/persistImportedClaudeTask.js";
import {
  parseLegacyTaskSessionFile,
  writeImportedLegacyTaskSnapshot,
} from "#src/session/legacyTaskSessionFile.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const logger = createServiceLogger("opencode-native-import");

async function workspacePathExists(workspacePath: string): Promise<boolean> {
  try {
    await access(workspacePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function importOpenCodeNativeSessions(params: {
  taskIndexRepo: TaskIndexRepo;
  workspacePath?: string;
  workspaceIdentity?: string;
  sessionIds: string[];
  createImportedSession?: (source: OpenCodeNativeImportedSessionSource) => Promise<ZCodeTaskMeta>;
  onTaskImported: (meta: ZCodeTaskMeta) => void;
  /** 测试/高级用法注入的来源库路径；缺省解析 ~/.local/share/opencode（含 XDG/HOME 覆盖）。 */
  databasePaths?: readonly string[];
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
    `开始导入 OpenCode 原生 session workspaceFilter=${params.workspacePath ?? "all"} count=${normalizedSessionIds.length}`,
  );

  for (const sessionId of normalizedSessionIds) {
    let importedWorkspacePath: string | undefined;
    try {
      const candidate = await opencodeNativeSessionImportRepo.findImportableSession({
        workspacePath: params.workspacePath,
        sessionId,
        ...(params.databasePaths ? { databasePaths: params.databasePaths } : {}),
      });
      if (!candidate) {
        result.skipped.push({
          provider: "openCode",
          sessionId,
          reason: "session_not_found_or_workspace_mismatch",
          ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
        });
        continue;
      }

      importedWorkspacePath = candidate.workspacePath;
      if (!(await workspacePathExists(importedWorkspacePath))) {
        result.skipped.push({
          provider: "openCode",
          sessionId,
          reason: "workspace_path_missing",
          workspacePath: importedWorkspacePath,
        });
        continue;
      }

      const transcript = await opencodeNativeSessionImportRepo.readSessionTranscript({
        sessionId,
        sourcePath: candidate.sourcePath,
      });
      const importedSource = parseOpenCodeNativeSession({
        sessionId,
        directory: candidate.workspacePath,
        ...(candidate.previewTitle ? { title: candidate.previewTitle } : {}),
        timeCreated: candidate.createdAt ?? candidate.updatedAt,
        timeUpdated: candidate.updatedAt,
        sourcePath: candidate.sourcePath,
        messages: transcript.messages,
        partsByMessageId: transcript.partsByMessageId,
        v2Rows: transcript.v2Rows,
      });

      const targetWorkspaceIdentity = params.workspacePath ? params.workspaceIdentity : undefined;
      let meta: ZCodeTaskMeta;
      if (params.createImportedSession) {
        meta = await params.createImportedSession(importedSource);
        const sessionFile = buildImportedOpenCodeTaskFile(
          importedSource,
          undefined,
          meta.taskId,
        );
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
            migrationSource: "openCode",
            workspaceIdentity: targetWorkspaceIdentity ?? meta.workspaceIdentity,
          },
          searchableText: buildSearchableTextFromMessages(sessionFile.messages),
          // 已导入会话被删除/归档后再次导入，不能继承旧行隐藏状态，
          // 否则导入结果成功但 active 列表查不到对应会话（与 Claude 导入同因）。
          archived: false,
          deleted: false,
        });
      } else {
        // 无 RPC 回调的兜底路径（测试/legacy）：只落 legacy snapshot + 索引行。
        const sessionFile = buildImportedOpenCodeTaskFile(importedSource);
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
        provider: "openCode",
        sessionId,
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(undefined, `导入 OpenCode 原生 session 失败 session=${sessionId}`, error);
      result.failed.push({
        provider: "openCode",
        sessionId,
        reason,
        ...(importedWorkspacePath ? { workspacePath: importedWorkspacePath } : {}),
      });
    }
  }

  logger.info(
    undefined,
    `OpenCode 原生 session 导入完成 imported=${result.imported.length} skipped=${result.skipped.length} failed=${result.failed.length}`,
  );
  return result;
}
