import { useMemo } from "react";
import { TID_ASSISTANT_USAGE_LINE } from "@zcode/shared";
import { Separator } from "@/components/ui/separator.js";
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
 * 与输入框下方的状态条同源（v4/conversation/usageDetail），不额外引入协议字段；
 * 只在终态渲染，避免把进行中的半成品数字当成结论。产品规则见
 * packages/ui/docs/usage-status-bar.md。
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
  const ttft = formatDurationMs(locale, snapshot.timeToFirstTokenMs);
  const duration = formatDurationMs(locale, snapshot.durationMs);

  return (
    <div
      data-testid={TID_ASSISTANT_USAGE_LINE}
      className={
        compactForRemoteControl
          ? "mt-1 flex flex-wrap items-center gap-2 text-ui-xs text-foreground-subtle tabular-nums"
          : "mt-1 flex flex-wrap items-center gap-2 text-ui-xs text-foreground-subtle tabular-nums opacity-80"
      }
    >
      {speed !== null ? (
        <span className={speedTier ? SPEED_TIER_CLASS[speedTier] : undefined}>
          {intl.formatMessage({ id: "chat.message.usage.speed" }, { value: speed })}
        </span>
      ) : null}
      {snapshot.outputTokens > 0 ? (
        <>
          <Separator orientation="vertical" className="h-3" />
          <span>
            {intl.formatMessage(
              { id: "chat.message.usage.tokens" },
              { value: formatCompactTokenCount(locale, snapshot.outputTokens) },
            )}
          </span>
        </>
      ) : null}
      {ttft !== null ? (
        <>
          <Separator orientation="vertical" className="h-3" />
          <span>{intl.formatMessage({ id: "chat.message.usage.ttft" }, { value: ttft })}</span>
        </>
      ) : null}
      {duration !== null ? (
        <>
          <Separator orientation="vertical" className="h-3" />
          <span>
            {intl.formatMessage({ id: "chat.message.usage.duration" }, { value: duration })}
          </span>
        </>
      ) : null}
    </div>
  );
}
