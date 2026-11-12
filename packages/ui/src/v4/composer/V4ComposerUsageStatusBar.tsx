import { useEffect, useMemo, useRef, useState } from "react";
import { TID_V4_USAGE_STATUS_BAR } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { Clock, Hash, Timer, Zap } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildUsageStatusBarModel,
  estimateStreamingOutputTokens,
  findStreamingAssistantText,
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
/** 生成中的刷新节奏：只驱动本地估算，不额外请求后端。 */
const STREAMING_TICK_MS = 500;

const SPEED_TIER_CLASS: Record<ReturnType<typeof resolveGenerationSpeedTier>, string> = {
  fast: "text-success",
  medium: "text-warning",
  slow: "text-destructive",
};

/** 段间分隔：与插件一致用细分隔线，而不是圆点/竖线字符。 */
function SegmentDivider() {
  return <span aria-hidden="true" className="h-3 w-px shrink-0 self-center bg-border/70" />;
}

/** 状态行展示值；来源可以是“完成后的权威 value”或“生成中的本地估算”。 */
interface UsageRowValues {
  tokensPerSecond: number | null;
  outputTokens: number;
  timeToFirstTokenMs: number | null;
  durationMs: number | null;
  generationMs: number | null;
  modelId: string;
  running: boolean;
}

interface V4ComposerUsageStatusBarProps {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  /** v4 投影快照：生成中的 assistantText 行用于实时估算（只读，不写事实）。 */
  snapshot?: ConversationSnapshot | null;
}

/**
 * 嵌在输入卡底部的用量状态行（与社区插件形态对齐）。
 *
 * 两段数据源：
 * - 生成中：从投影 snapshot 的 streaming assistantText 行做本地估算（CJK 1 字≈1 token，
 *   其余 4 字符≈1 token），每 500ms 刷新一次；不含思考/工具 token。
 * - 完成后：切到 usageDetail 的权威值（outputTokens/generationMs/TTFT），并在流结束后
 *   立即触发一次刷新，避免等 10s 轮询。
 * 无数据（草稿/新会话且未生成）时整行不渲染。
 * 产品规则见 packages/ui/docs/usage-status-bar.md。
 */
export function V4ComposerUsageStatusBar({
  workspacePath,
  workspaceIdentity,
  sessionId,
  snapshot: conversationSnapshot,
}: V4ComposerUsageStatusBarProps) {
  const { intl, locale } = useZCodeIntl();
  const { detail, refresh } = useUsageDetail({
    sessionId,
    workspacePath,
    workspaceIdentity,
    pollIntervalMs: USAGE_STATUS_BAR_POLL_INTERVAL_MS,
  });
  const model = useMemo(() => buildUsageStatusBarModel({ detail }), [detail]);

  const streamingRow = findStreamingAssistantText(conversationSnapshot?.rows.window);
  const isStreaming = streamingRow !== null;

  // 生成中每 500ms 重渲染一次，驱动速率/耗时走表；仅本地计算。
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isStreaming) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), STREAMING_TICK_MS);
    return () => window.clearInterval(timer);
  }, [isStreaming]);

  // 每轮首次观察到的首 token 时间：TTFT 与生成速率的分母都从这里起算。
  const liveAnchorRef = useRef<{
    turnId: string;
    startedAt: number;
    firstTokenAt: number | null;
  } | null>(null);
  if (streamingRow) {
    const anchor = liveAnchorRef.current;
    if (!anchor || anchor.turnId !== streamingRow.turnId) {
      liveAnchorRef.current = {
        turnId: streamingRow.turnId,
        startedAt: streamingRow.startedAt,
        firstTokenAt: null,
      };
    }
    // 新锚点也要在同一轮渲染里记录首个 token，否则 TTFT 要等到下一次 tick。
    const current = liveAnchorRef.current;
    if (current && current.firstTokenAt === null && streamingRow.text.trim().length > 0) {
      current.firstTokenAt = Date.now();
    }
  }

  // 流结束立刻取一次权威用量，避免“刚完成时行消失、10s 后才回来”。
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      void refresh();
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, refresh]);

  // 完成后的权威快照：进行中的请求没有 generationMs，保留上一轮避免抖动。
  const [completedSnapshot, setCompletedSnapshot] = useState<UsageStatusBarSnapshot | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  useEffect(() => {
    // 草稿态（无会话）才清空；查询失败时 hook 已保留旧 detail，这里同样不清空，
    // 否则轮询失败的瞬间状态行会闪烁消失（实测 bug）。
    if (!sessionId) {
      setCompletedSnapshot(null);
      setIsRunning(false);
      return;
    }
    const latest = model.latest;
    if (!latest) return;
    setIsRunning(isUsageSnapshotRunning(latest));
    if (latest.tokensPerSecond === null && isUsageSnapshotRunning(latest)) {
      return; // 保留上一轮
    }
    setCompletedSnapshot(latest);
  }, [model.latest, sessionId]);

  // 流结束到权威 usage 落库之间有一个空窗（refresh 是异步的）：保留最后一份本地估算，
  // 冻结显示而不是把整行撤掉；权威数据到达后 completedSnapshot 自然接管。
  const lastLiveRef = useRef<UsageRowValues | null>(null);
  const liveValues = streamingRow
    ? buildLiveValues(streamingRow, liveAnchorRef.current)
    : null;
  if (liveValues) lastLiveRef.current = liveValues;
  useEffect(() => {
    if (!sessionId) lastLiveRef.current = null;
  }, [sessionId]);

  const values = liveValues
    ? liveValues
    : completedSnapshot
      ? {
          tokensPerSecond: completedSnapshot.tokensPerSecond,
          outputTokens: completedSnapshot.outputTokens,
          timeToFirstTokenMs: completedSnapshot.timeToFirstTokenMs,
          durationMs: completedSnapshot.durationMs,
          generationMs: completedSnapshot.generationMs,
          modelId: completedSnapshot.modelId,
          running: isRunning,
        }
      : lastLiveRef.current;

  if (!values) return null;

  const speedTier =
    values.tokensPerSecond != null
      ? resolveGenerationSpeedTier(values.tokensPerSecond)
      : null;
  const tooltip = intl.formatMessage(
    { id: "composer.usage.statusBar.tooltip" },
    {
      model: values.modelId || "--",
      output: formatFullTokenCount(locale, values.outputTokens),
      ttft: formatDurationMs(locale, values.timeToFirstTokenMs) ?? "--",
      duration: formatDurationMs(locale, values.durationMs) ?? "--",
      generation: formatDurationMs(locale, values.generationMs) ?? "--",
    },
  );

  return (
    <div
      data-testid={TID_V4_USAGE_STATUS_BAR}
      title={tooltip}
      className="flex min-w-0 items-center justify-center gap-2.5 text-ui-xs text-foreground-subtle tabular-nums"
    >
      {/* 首 token 到达前不渲染速率段：避免闪一帧 "-- tok/s"；首 token 后 500ms 内也留空。 */}
      {values.tokensPerSecond != null ? (
        <>
          <span
            className={`flex shrink-0 items-center gap-1 ${speedTier ? SPEED_TIER_CLASS[speedTier] : "text-foreground-subtlest"}`}
          >
            <Zap className="size-3 shrink-0" aria-hidden="true" />
            <span>{formatTokensPerSecond(locale, values.tokensPerSecond)}</span>
            <span className="text-foreground-subtlest">
              {intl.formatMessage({ id: "composer.usage.speedUnit" })}
            </span>
          </span>
          <SegmentDivider />
        </>
      ) : null}
      <span className="flex shrink-0 items-center gap-1">
        <Hash className="size-3 shrink-0 text-foreground-subtlest" aria-hidden="true" />
        <span>
          {intl.formatMessage(
            { id: "composer.usage.statusBar.tokens" },
            { value: formatCompactTokenCount(locale, values.outputTokens) },
          )}
        </span>
      </span>

      <SegmentDivider />
      <span className="flex shrink-0 items-center gap-1">
        <Timer className="size-3 shrink-0 text-foreground-subtlest" aria-hidden="true" />
        <span>
          {intl.formatMessage(
            { id: "composer.usage.statusBar.ttft" },
            { value: formatDurationMs(locale, values.timeToFirstTokenMs) ?? "--" },
          )}
        </span>
      </span>

      <SegmentDivider />
      <span className="flex shrink-0 items-center gap-1">
        <Clock className="size-3 shrink-0 text-foreground-subtlest" aria-hidden="true" />
        <span>
          {intl.formatMessage(
            { id: "composer.usage.statusBar.duration" },
            { value: formatDurationMs(locale, values.durationMs) ?? "--" },
          )}
        </span>
      </span>

      {values.running ? (
        <span className="ml-0.5 flex shrink-0 items-center gap-1 text-foreground-subtlest">
          <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />
          {intl.formatMessage({ id: "composer.usage.statusBar.running" })}
        </span>
      ) : null}
    </div>
  );
}

/** 生成中的本地估算：token 由正文长度推算，速率从首个 token 起算。 */
function buildLiveValues(
  row: { text: string; startedAt: number },
  anchor: { startedAt: number; firstTokenAt: number | null } | null,
): UsageRowValues {
  const now = Date.now();
  const outputTokens = estimateStreamingOutputTokens(row.text);
  const startedAt = anchor?.startedAt ?? row.startedAt;
  const firstTokenAt = anchor?.firstTokenAt ?? null;
  const generationMs = firstTokenAt === null ? null : Math.max(0, now - firstTokenAt);
  return {
    // 首 token 后不足 500ms 时样本太短，先不显示速率，避免数字剧烈跳动。
    tokensPerSecond:
      generationMs !== null && generationMs >= 500 ? outputTokens / (generationMs / 1000) : null,
    outputTokens,
    timeToFirstTokenMs: firstTokenAt === null ? null : Math.max(0, firstTokenAt - startedAt),
    durationMs: Math.max(0, now - startedAt),
    generationMs,
    modelId: "",
    running: true,
  };
}
