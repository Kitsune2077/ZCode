import { useEffect, useMemo, useState } from "react";
import { TID_V4_USAGE_STATUS_BAR } from "@zcode/shared";
import { Separator } from "@/components/ui/separator.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildUsageStatusBarModel,
  formatCompactTokenCount,
  formatDurationMs,
  formatFullTokenCount,
  formatTokensPerSecond,
  isUsageSnapshotRunning,
  resolveGenerationSpeedTier,
  type UsageStatusBarSnapshot,
} from "./usageStatusBarModel.js";
import { useUsageDetail } from "./useUsageDetail.js";

/** 轮询间隔：轮次结束后聚合落库通常在秒级，10s 足够“常驻但不吵”。 */
const USAGE_STATUS_BAR_POLL_INTERVAL_MS = 10_000;

const SPEED_TIER_CLASS: Record<ReturnType<typeof resolveGenerationSpeedTier>, string> = {
  fast: "text-success",
  medium: "text-warning",
  slow: "text-destructive",
};

interface V4ComposerUsageStatusBarProps {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 草稿态为 null：无会话时保留占位，不隐藏。 */
  sessionId: string | null;
}

/**
 * 输入框下方的常驻用量状态条（药丸形态）。
 *
 * 指标：速率（首 token → 完成口径）/ 输出 token / TTFT / 生成时长。会话与今日等累计
 * 刻意不在这里展示——左侧 ChatContextUsage 圆环与设置 → 用量页已承担该职责。
 * 请求进行中保留上一轮已完成指标并标注「生成中」，不会闪退成空。
 * 产品规则见 packages/ui/docs/usage-status-bar.md。
 */
export function V4ComposerUsageStatusBar({
  workspacePath,
  workspaceIdentity,
  sessionId,
}: V4ComposerUsageStatusBarProps) {
  const { intl, locale } = useZCodeIntl();
  const detail = useUsageDetail({
    sessionId,
    workspacePath,
    workspaceIdentity,
    pollIntervalMs: USAGE_STATUS_BAR_POLL_INTERVAL_MS,
  });
  const model = useMemo(() => buildUsageStatusBarModel({ detail }), [detail]);

  // 进行中的请求没有生成时长（速率不可算）：保留上一轮已完成快照，避免状态条抖动。
  const [snapshot, setSnapshot] = useState<UsageStatusBarSnapshot | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  useEffect(() => {
    const latest = model.latest;
    if (!latest) {
      setSnapshot(null);
      setIsRunning(false);
      return;
    }
    setIsRunning(isUsageSnapshotRunning(latest));
    if (latest.tokensPerSecond === null && isUsageSnapshotRunning(latest)) {
      return; // 保留上一轮
    }
    setSnapshot(latest);
  }, [model.latest]);

  const speedTier =
    snapshot?.tokensPerSecond != null
      ? resolveGenerationSpeedTier(snapshot.tokensPerSecond)
      : null;
  const empty = intl.formatMessage({ id: "composer.usage.statusBar.empty" });
  const speedText =
    snapshot?.tokensPerSecond != null
      ? formatTokensPerSecond(locale, snapshot.tokensPerSecond)
      : empty;
  const tokenText =
    snapshot && snapshot.outputTokens > 0
      ? intl.formatMessage(
          { id: "composer.usage.statusBar.tokens" },
          { value: formatCompactTokenCount(locale, snapshot.outputTokens) },
        )
      : empty;
  const ttftText =
    snapshot?.timeToFirstTokenMs != null
      ? intl.formatMessage(
          { id: "composer.usage.statusBar.ttft" },
          { value: formatDurationMs(locale, snapshot.timeToFirstTokenMs) ?? empty },
        )
      : empty;
  const durationText =
    snapshot?.durationMs != null
      ? intl.formatMessage(
          { id: "composer.usage.statusBar.duration" },
          { value: formatDurationMs(locale, snapshot.durationMs) ?? empty },
        )
      : empty;

  const tooltip = snapshot
    ? intl.formatMessage(
        { id: "composer.usage.statusBar.tooltip" },
        {
          model: snapshot.modelId,
          output: formatFullTokenCount(locale, snapshot.outputTokens),
          ttft: formatDurationMs(locale, snapshot.timeToFirstTokenMs) ?? empty,
          duration: formatDurationMs(locale, snapshot.durationMs) ?? empty,
          generation: formatDurationMs(locale, snapshot.generationMs) ?? empty,
        },
      )
    : undefined;

  return (
    <div
      data-testid={TID_V4_USAGE_STATUS_BAR}
      className="mt-1.5 flex w-full justify-center"
      title={tooltip}
    >
      <div className="inline-flex h-6 max-w-full items-center gap-2 overflow-hidden rounded-full border border-border/70 bg-surface/60 px-3 text-ui-xs text-foreground-subtle tabular-nums">
        <span className={speedTier ? SPEED_TIER_CLASS[speedTier] : undefined}>
          {speedText}
          <span className="ml-1 text-foreground-subtlest">
            {intl.formatMessage({ id: "composer.usage.speedUnit" })}
          </span>
        </span>
        <Separator orientation="vertical" className="h-3" />
        <span className="shrink-0">{ttftText}</span>
        <Separator orientation="vertical" className="hidden h-3 sm:block" />
        <span className="hidden shrink-0 sm:inline">{tokenText}</span>
        <Separator orientation="vertical" className="hidden h-3 md:block" />
        <span className="hidden shrink-0 md:inline">{durationText}</span>
        {isRunning ? (
          <span className="shrink-0 text-foreground-subtlest">
            {intl.formatMessage({ id: "composer.usage.statusBar.running" })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
