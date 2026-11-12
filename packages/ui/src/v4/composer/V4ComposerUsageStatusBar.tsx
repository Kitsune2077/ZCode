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
/**
 * 生成中的走表节奏：数字只按该节奏更新（进入 state），流式 delta 不驱动显示——
 * 否则每个文本 chunk 都重算一次，视觉上“每秒刷很多次”。
 */
const STREAMING_TICK_MS = 1_000;
/** 流结束后等待权威落库的重试节奏；全部失败则由 10s 轮询兜底。 */
const HANDOFF_REFRESH_DELAYS_MS = [1_000, 3_000, 8_000] as const;

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

/** 权威快照 + 本地到达时间：handoff 期用它判断“新权威是否已接管”。 */
interface CompletedUsage {
  snapshot: UsageStatusBarSnapshot;
  arrivedAt: number;
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
 * 数据源与节奏：
 * - 生成中：投影 snapshot 的 streaming assistantText 行做本地估算，**每 1s 快照进
 *   state**（流式 delta 只更新 ref，不驱动数字），避免显示频率过高。
 * - 流结束 handoff：估算值冻结显示（不带「生成中」标记），并按 1s/3s/8s 重试拉
 *   权威 usage；新请求落库（requestId 变化）即接管。只刷一次不够——落库常慢于
 *   流式行消失，冻结值会长时间停在「生成中」（实测 bug）。
 * - 权威轮询失败时保留上一次成功值（见 useUsageDetail），不闪烁清空。
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

  // ---- 生成中估算：ref 收集最新流式行，tick 时快照进 state ----
  const streamingRowRef = useRef(streamingRow);
  streamingRowRef.current = streamingRow;
  const lastLiveRef = useRef<UsageRowValues | null>(null);
  const [liveValues, setLiveValues] = useState<UsageRowValues | null>(null);
  useEffect(() => {
    if (!isStreaming) return;
    const compute = () => {
      const row = streamingRowRef.current;
      if (!row) return;
      const values = buildLiveValues(row, liveAnchorRef.current);
      lastLiveRef.current = values;
      setLiveValues(values);
    };
    compute();
    const timer = window.setInterval(compute, STREAMING_TICK_MS);
    return () => window.clearInterval(timer);
  }, [isStreaming]);

  // ---- 流结束 handoff：冻结估算（去掉「生成中」标记）+ 重试拉权威 ----
  const [frozen, setFrozen] = useState<{ values: UsageRowValues; endedAt: number } | null>(null);
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      if (lastLiveRef.current) {
        // 流式行已消失 = 生成已结束：冻结值不再标「生成中」。
        setFrozen({ values: { ...lastLiveRef.current, running: false }, endedAt: Date.now() });
      }
      void refresh();
      const timers = HANDOFF_REFRESH_DELAYS_MS.map((delay) =>
        window.setTimeout(() => void refresh(), delay),
      );
      wasStreamingRef.current = isStreaming;
      return () => {
        for (const timer of timers) window.clearTimeout(timer);
      };
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, refresh]);

  // ---- 权威快照：requestId 不变不刷新到达时间，handoff 才能分辨新旧 ----
  const [completed, setCompleted] = useState<CompletedUsage | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const lastSessionIdRef = useRef(sessionId);
  useEffect(() => {
    // 会话切换必须清空：新会话数据未到（以及切到无记录的新任务）时不能沿用
    // 上一个任务的指标。“!latest 直接 return 保留旧值”只属于**同一会话**的轮询
    // 失败防闪烁语义，两者必须分开（实测 bug：切换后指标停留在旧任务）。
    const sessionChanged = lastSessionIdRef.current !== sessionId;
    lastSessionIdRef.current = sessionId;
    if (sessionChanged || !sessionId) {
      setCompleted(null);
      setIsRunning(false);
      return;
    }
    const latest = model.latest;
    if (!latest) return;
    setIsRunning(isUsageSnapshotRunning(latest));
    if (latest.tokensPerSecond === null && isUsageSnapshotRunning(latest)) {
      return; // 请求进行中且速率不可算：保留上一份权威
    }
    setCompleted((prev) =>
      prev?.snapshot.requestId === latest.requestId
        ? prev
        : { snapshot: latest, arrivedAt: Date.now() },
    );
  }, [model.latest, sessionId]);

  // 会话切换：清掉上一会话的估算与冻结值。
  useEffect(() => {
    setLiveValues(null);
    setFrozen(null);
    lastLiveRef.current = null;
  }, [sessionId]);

  // ---- 合成展示值 ----
  const authorityValues = completed
    ? {
        tokensPerSecond: completed.snapshot.tokensPerSecond,
        outputTokens: completed.snapshot.outputTokens,
        timeToFirstTokenMs: completed.snapshot.timeToFirstTokenMs,
        durationMs: completed.snapshot.durationMs,
        generationMs: completed.snapshot.generationMs,
        modelId: completed.snapshot.modelId,
        running: isRunning,
      }
    : null;
  const values = isStreaming
    ? liveValues
    : frozen && completed && completed.arrivedAt >= frozen.endedAt
      ? authorityValues
      : frozen
        ? frozen.values
        : authorityValues;

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
    // 首 token 后不足一个 tick 时样本太短，先不显示速率，避免数字剧烈跳动。
    tokensPerSecond:
      generationMs !== null && generationMs >= STREAMING_TICK_MS
        ? outputTokens / (generationMs / 1000)
        : null,
    outputTokens,
    timeToFirstTokenMs: firstTokenAt === null ? null : Math.max(0, firstTokenAt - startedAt),
    durationMs: Math.max(0, now - startedAt),
    generationMs,
    modelId: "",
    running: true,
  };
}
