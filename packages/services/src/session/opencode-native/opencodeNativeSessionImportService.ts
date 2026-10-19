import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { ZCodeImportSessionsResult, ZCodeTaskMeta } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { buildImportedOpenCodeTaskFile } from "#src/session/opencode-native/buildImportedOpenCodeTaskFile.js";
import { opencodeNativeSessionImportRepo } from "#src/session/opencode-native/opencodeNativeSessionImportRepo.js";
import { parseOpenCodeNativeSession } from "#src/session/opencode-native/opencodeNativeSessionImportParser.js";
import type { OpenCodeNativeImportedSessionSource } from "#src/session/opencode-native/opencodeNativeSessionTypes.js";
import { buildSearchableTextFromMessages } from "#src/session/claude-native/persistImportedClaudeTask.js";
import { writeImportedLegacyTaskSnapshot } from "#src/session/legacyTaskSessionFile.js";
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
  createImportedSession: (source: OpenCodeNativeImportedSessionSource) => Promise<ZCodeTaskMeta>;
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
      // 导入只能由 CLI 创建持久会话；备份文件不能成为第二个会话事实写者（与 Claude 导入同构）。
      const created = await params.createImportedSession(importedSource);
      const sessionFile = buildImportedOpenCodeTaskFile(importedSource, undefined, created.taskId);
      await writeImportedLegacyTaskSnapshot({
        sessionFile: {
          ...sessionFile,
          meta: {
            ...sessionFile.meta,
            ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
          },
        },
      });
      const meta = await params.taskIndexRepo.updateTaskPresentation({
        ...created,
        presentation: { migrationSource: "openCode" },
        searchableText: buildSearchableTextFromMessages(sessionFile.messages),
      });
      if (!meta) throw new Error("CLI import did not persist session facts");
      // 已导入会话被归档后再次导入，显式恢复可见，避免导入成功却进不了 active 列表。
      await params.taskIndexRepo.updateTaskState({ ...created, patch: { archived: false } });
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
