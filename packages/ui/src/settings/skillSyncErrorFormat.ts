import {
  normalizeUnknownError,
  SKILL_SYNC_SIZE_LIMIT_ERROR_CODE,
  type RemoteTarget,
  type SkillSyncSizeLimitErrorData,
} from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";

/**
 * 本仓库定制：技能同步相关的两个纯格式化函数。
 *
 * 上游 3.17 用 data-sync 取代了 Remote*SyncDialog 并删除了 RemoteSkillSyncDialog.tsx，
 * 但 fork 的「本地 ZIP 导入」与 SkillsSection 仍需要这两个函数：把尺寸超限错误转成可
 * 操作文案、把远端目标拼成一行标题。这里单独保留，避免为了两个纯函数恢复整个弹窗。
 */

/** 把技能尺寸超限错误转成当前语言的提示；其它错误保留原始信息。 */
export function formatRemoteSkillSyncError(
  error: unknown,
  intl: Pick<IntlInstance, "formatMessage">,
): string {
  // RPC 原始错误里的字节数和阶段信息不能直接作为用户文案；
  // 这里只识别稳定错误码，按阶段和当前语言生成可操作提示，其它错误保留原始信息。
  const normalizedError = normalizeUnknownError(error);
  if (normalizedError.code !== SKILL_SYNC_SIZE_LIMIT_ERROR_CODE) {
    return normalizedError.message;
  }

  const data = readSkillSyncSizeLimitErrorData(error);
  if (!data) {
    return normalizedError.message;
  }

  const messageId = {
    "selected-content": "settings.skills.remoteSync.sizeLimit.selectedContent",
    archive: "settings.skills.remoteSync.sizeLimit.archive",
    "extracted-content": "settings.skills.remoteSync.sizeLimit.extractedContent",
  }[data.phase];
  return intl.formatMessage(
    { id: messageId },
    {
      actualSize: formatSkillSyncBytes(data.actualBytes),
      maxSize: formatSkillSyncBytes(data.maxBytes),
    },
  );
}

function readSkillSyncSizeLimitErrorData(error: unknown): SkillSyncSizeLimitErrorData | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    return null;
  }
  const candidate = data as Partial<SkillSyncSizeLimitErrorData>;
  if (
    typeof candidate.actualBytes !== "number" ||
    typeof candidate.maxBytes !== "number" ||
    (candidate.phase !== "selected-content" &&
      candidate.phase !== "archive" &&
      candidate.phase !== "extracted-content")
  ) {
    return null;
  }
  return candidate as SkillSyncSizeLimitErrorData;
}

function formatSkillSyncBytes(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return `${Number.isInteger(mebibytes) ? mebibytes : mebibytes.toFixed(1)} MiB`;
}

/** 远端技能同步目标的一行标题：`user@host:port · workspacePath` / `WSL distro · user · path`。 */
export function formatRemoteSkillSyncTarget(
  remoteTarget: RemoteTarget,
  workspacePath: string,
): string {
  const target =
    remoteTarget.kind === "ssh"
      ? `${remoteTarget.username}@${remoteTarget.host}${remoteTarget.port ? `:${remoteTarget.port}` : ""}`
      : remoteTarget.kind === "wsl"
        ? ["WSL", remoteTarget.distro, remoteTarget.user?.trim()].filter(Boolean).join(" · ")
        : remoteTarget.kind;
  return workspacePath ? `${target} · ${workspacePath}` : target;
}
