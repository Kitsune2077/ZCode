import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { ZCodeImportSessionsResult, ZCodeTaskMeta } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { buildImportedZCodeInstalledTaskFile } from "#src/session/zcode-installed-native/buildImportedZCodeInstalledTaskFile.js";
import { zcodeInstalledSessionImportRepo } from "#src/session/zcode-installed-native/zcodeInstalledSessionImportRepo.js";
import { parseZCodeInstalledSession } from "#src/session/zcode-installed-native/zcodeInstalledSessionImportParser.js";
import type { ZCodeInstalledImportedSessionSource } from "#src/session/zcode-installed-native/zcodeInstalledSessionTypes.js";
import { buildSearchableTextFromMessages } from "#src/session/claude-native/persistImportedClaudeTask.js";
import { writeImportedLegacyTaskSnapshot } from "#src/session/legacyTaskSessionFile.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const logger = createServiceLogger("zcode-installed-import");

async function workspacePathExists(workspacePath: string): Promise<boolean> {
  try {
    await access(workspacePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function importZCodeInstalledSessions(params: {
  taskIndexRepo: TaskIndexRepo;
  workspacePath?: string;
  workspaceIdentity?: string;
  sessionIds: string[];
  createImportedSession: (source: ZCodeInstalledImportedSessionSource) => Promise<ZCodeTaskMeta>;
  onTaskImported: (meta: ZCodeTaskMeta) => void;
  /** 测试/高级用法注入的安装版用户主目录；缺省取 os.homedir()。 */
  homeDir?: string;
  /** 测试/高级用法注入的来源库路径；缺省按 homeDir 解析。 */
  databasePath?: string;
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
    `开始导入 ZCode 安装版 session workspaceFilter=${params.workspacePath ?? "all"} count=${normalizedSessionIds.length}`,
  );

  for (const sessionId of normalizedSessionIds) {
    let importedWorkspacePath: string | undefined;
    try {
      const candidate = await zcodeInstalledSessionImportRepo.findImportableSession({
        workspacePath: params.workspacePath,
        sessionId,
        ...(params.homeDir ? { homeDir: params.homeDir } : {}),
        ...(params.databasePath ? { databasePath: params.databasePath } : {}),
      });
      if (!candidate) {
        result.skipped.push({
          provider: "zcodeInstalled",
          sessionId,
          reason: "session_not_found_or_workspace_mismatch",
          ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
        });
        continue;
      }

      importedWorkspacePath = candidate.workspacePath;
      if (!(await workspacePathExists(importedWorkspacePath))) {
        result.skipped.push({
          provider: "zcodeInstalled",
          sessionId,
          reason: "workspace_path_missing",
          workspacePath: importedWorkspacePath,
        });
        continue;
      }

      const transcript = await zcodeInstalledSessionImportRepo.readSessionTranscript({
        sessionId,
        sourcePath: candidate.sourcePath,
      });
      let importedSource: ZCodeInstalledImportedSessionSource;
      try {
        importedSource = parseZCodeInstalledSession({
          sessionId,
          directory: candidate.workspacePath,
          ...(candidate.previewTitle ? { title: candidate.previewTitle } : {}),
          timeCreated: candidate.createdAt ?? candidate.updatedAt,
          timeUpdated: candidate.updatedAt,
          sourcePath: candidate.sourcePath,
          messages: transcript.messages,
          partsByMessageId: transcript.partsByMessageId,
        });
      } catch {
        // 来源 session 没有任何可见文本（纯工具轮/空会话），计入 skipped 而不是 failed。
        result.skipped.push({
          provider: "zcodeInstalled",
          sessionId,
          reason: "no_visible_messages",
          workspacePath: importedWorkspacePath,
        });
        continue;
      }

      const targetWorkspaceIdentity = params.workspacePath ? params.workspaceIdentity : undefined;
      // 导入只能由 CLI 创建持久会话；备份文件不能成为第二个会话事实写者（与其它来源同构）。
      const created = await params.createImportedSession(importedSource);
      const sessionFile = buildImportedZCodeInstalledTaskFile(
        importedSource,
        undefined,
        created.taskId,
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
      const meta = await params.taskIndexRepo.updateTaskPresentation({
        ...created,
        presentation: { migrationSource: "zcodeInstalled" },
        searchableText: buildSearchableTextFromMessages(sessionFile.messages),
      });
      if (!meta) throw new Error("CLI import did not persist session facts");
      // 已导入会话被归档后再次导入，显式恢复可见，避免导入成功却进不了 active 列表。
      await params.taskIndexRepo.updateTaskState({ ...created, patch: { archived: false } });
      params.onTaskImported(meta);

      result.imported.push({
        provider: "zcodeInstalled",
        sessionId,
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(undefined, `导入 ZCode 安装版 session 失败 session=${sessionId}`, error);
      result.failed.push({
        provider: "zcodeInstalled",
        sessionId,
        reason,
        ...(importedWorkspacePath ? { workspacePath: importedWorkspacePath } : {}),
      });
    }
  }

  logger.info(
    undefined,
    `ZCode 安装版 session 导入完成 imported=${result.imported.length} skipped=${result.skipped.length} failed=${result.failed.length}`,
  );
  return result;
}
