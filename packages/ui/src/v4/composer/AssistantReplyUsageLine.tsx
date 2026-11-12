import { useMemo } from "react";
import { TID_ASSISTANT_USAGE_LINE } from "@zcode/shared";
import { Zap } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildUsageStatusBarModel,
  formatCompactTokenCount,
  formatDurationMs,
  formatTokensPerSecond,
  isUsageSnapshotRunning,
  resolveGenerationSpeedTier,
} from "./usageStatusBarModel.js";
import { useUsageDetail } from "./useUsageDetail.js";

const SPEED_TIER_CLASS: Record<ReturnType<typeof resolveGenerationSpeedTier>, string> = {
  fast: "text-success",
  medium: "text-warning",
  slow: "text-destructive",
};

/** 与插件回答末尾统计行同款弱分隔：中文用 ·，保持单行轻量。 */
function Dot() {
  return (
    <span aria-hidden="true" className="text-foreground-subtlest">
      ·
    </span>
  );
}

interface AssistantReplyUsageLineProps {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null | undefined;
  /** 轮次完成时变化（turnId），用于完成后刷新一次。 */
  refreshKey: string;
  compactForRemoteControl?: boolean;
}

/**
 * 回复末尾的用量统计行（仅最新轮）。
 *
 * 对齐社区插件的「回答末尾速率行」：⚡ 速率（本轮）· 首字 · 输出 token · 生成时长。
 * 与输入卡底部的状态条同源（v4/conversation/usageDetail），不引入新协议字段；
 * 只在终态渲染，避免把进行中的半成品数字当成结论。
 * 产品规则见 packages/ui/docs/usage-status-bar.md。
 */
export function AssistantReplyUsageLine({
  workspacePath,
  workspaceIdentity,
  sessionId,
  refreshKey,
  compactForRemoteControl = false,
}: AssistantReplyUsageLineProps) {
  const { intl, locale } = useZCodeIntl();
  const detail = useUsageDetail({
    sessionId,
    workspacePath,
    workspaceIdentity,
    refreshKey,
  });
  const model = useMemo(() => buildUsageStatusBarModel({ detail }), [detail]);
  const snapshot = model.latest;
  if (!snapshot || isUsageSnapshotRunning(snapshot)) return null;

  const speedTier =
    snapshot.tokensPerSecond != null
      ? resolveGenerationSpeedTier(snapshot.tokensPerSecond)
      : null;
  const speed =
    snapshot.tokensPerSecond != null
      ? formatTokensPerSecond(locale, snapshot.tokensPerSecond)
      : null;

  return (
    <div
      data-testid={TID_ASSISTANT_USAGE_LINE}
      className={
        compactForRemoteControl
          ? "mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ui-xs text-foreground-subtle tabular-nums"
          : "mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ui-xs text-foreground-subtle tabular-nums opacity-85"
      }
    >
      <Zap className="size-3 shrink-0 text-foreground-subtlest" aria-hidden="true" />
      {speed !== null ? (
        <span className={speedTier ? SPEED_TIER_CLASS[speedTier] : undefined}>
          {intl.formatMessage({ id: "chat.message.usage.speedInTurn" }, { value: speed })}
        </span>
      ) : null}
      {snapshot.timeToFirstTokenMs != null ? (
        <>
          <Dot />
          <span>
            {intl.formatMessage(
              { id: "chat.message.usage.ttft" },
              { value: formatDurationMs(locale, snapshot.timeToFirstTokenMs) ?? "--" },
            )}
          </span>
        </>
      ) : null}
      {snapshot.outputTokens > 0 ? (
        <>
          <Dot />
          <span>
            {intl.formatMessage(
              { id: "chat.message.usage.tokens" },
              { value: formatCompactTokenCount(locale, snapshot.outputTokens) },
            )}
          </span>
        </>
      ) : null}
      {snapshot.durationMs != null ? (
        <>
          <Dot />
          <span>
            {intl.formatMessage(
              { id: "chat.message.usage.duration" },
              { value: formatDurationMs(locale, snapshot.durationMs) ?? "--" },
            )}
          </span>
        </>
      ) : null}
    </div>
  );
}
