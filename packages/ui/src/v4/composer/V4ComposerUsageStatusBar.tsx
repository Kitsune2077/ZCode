import { useEffect, useMemo, useState } from "react";
import { TID_V4_USAGE_STATUS_BAR } from "@zcode/shared";
import { Clock, Hash, Timer, Zap } from "lucide-react";
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

/** 段间分隔：与插件一致用细分隔线，而不是圆点/竖线字符。 */
function SegmentDivider() {
  return <span aria-hidden="true" className="h-3 w-px shrink-0 self-center bg-border/70" />;
}

interface V4ComposerUsageStatusBarProps {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
}

/**
 * 嵌在输入卡底部的用量状态行（与社区插件形态对齐）。
 *
 * 指标：速率（首 token → 完成口径）/ 输出 token / TTFT / 生成时长，每段带弱化
 * 图标；无快照（草稿态、新会话）时整行不渲染，避免出现 `-- tok/s | -- | --` 的噪声。
 * 请求进行中保留上一轮已完成指标并标注「生成中」。
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

  if (!snapshot) return null;

  const speedTier =
    snapshot.tokensPerSecond != null
      ? resolveGenerationSpeedTier(snapshot.tokensPerSecond)
      : null;
  const speed = formatTokensPerSecond(locale, snapshot.tokensPerSecond ?? 0);
  const tooltip = intl.formatMessage(
    { id: "composer.usage.statusBar.tooltip" },
    {
      model: snapshot.modelId,
      output: formatFullTokenCount(locale, snapshot.outputTokens),
      ttft: formatDurationMs(locale, snapshot.timeToFirstTokenMs) ?? "--",
      duration: formatDurationMs(locale, snapshot.durationMs) ?? "--",
      generation: formatDurationMs(locale, snapshot.generationMs) ?? "--",
    },
  );

  return (
    <div
      data-testid={TID_V4_USAGE_STATUS_BAR}
      title={tooltip}
      className="flex min-w-0 items-center gap-2.5 text-ui-xs text-foreground-subtle tabular-nums"
    >
      {snapshot.tokensPerSecond != null ? (
        <span
          className={`flex shrink-0 items-center gap-1 ${SPEED_TIER_CLASS[speedTier!]}`}
        >
          <Zap className="size-3 shrink-0" aria-hidden="true" />
          <span>{speed}</span>
          <span className="text-foreground-subtlest">
            {intl.formatMessage({ id: "composer.usage.speedUnit" })}
          </span>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1 text-foreground-subtlest">
          <Zap className="size-3 shrink-0" aria-hidden="true" />
          <span>{intl.formatMessage({ id: "composer.usage.statusBar.empty" })}</span>
        </span>
      )}

      <SegmentDivider />
      <span className="flex shrink-0 items-center gap-1">
        <Hash className="size-3 shrink-0 text-foreground-subtlest" aria-hidden="true" />
        <span>
          {intl.formatMessage(
            { id: "composer.usage.statusBar.tokens" },
            { value: formatCompactTokenCount(locale, snapshot.outputTokens) },
          )}
        </span>
      </span>

      <SegmentDivider />
      <span className="flex shrink-0 items-center gap-1">
        <Timer className="size-3 shrink-0 text-foreground-subtlest" aria-hidden="true" />
        <span>
          {intl.formatMessage(
            { id: "composer.usage.statusBar.ttft" },
            { value: formatDurationMs(locale, snapshot.timeToFirstTokenMs) ?? "--" },
          )}
        </span>
      </span>

      <SegmentDivider />
      <span className="flex shrink-0 items-center gap-1">
        <Clock className="size-3 shrink-0 text-foreground-subtlest" aria-hidden="true" />
        <span>
          {intl.formatMessage(
            { id: "composer.usage.statusBar.duration" },
            { value: formatDurationMs(locale, snapshot.durationMs) ?? "--" },
          )}
        </span>
      </span>

      {isRunning ? (
        <span className="ml-0.5 flex shrink-0 items-center gap-1 text-foreground-subtlest">
          <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />
          {intl.formatMessage({ id: "composer.usage.statusBar.running" })}
        </span>
      ) : null}
    </div>
  );
}
