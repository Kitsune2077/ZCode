import { useEffect, useMemo, useRef, useState } from "react";
import { TID_V4_USAGE_STATUS_BAR } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { Clock, Hash, Timer, Zap } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  advanceStreamingAnchor,
  buildStreamingLiveValues,
  buildUsageStatusBarModel,
  estimateTurnOutputTokens,
  findLatestTurnActivity,
  findStreamingAssistantText,
  formatCompactTokenCount,
  formatDurationMs,
  formatFullTokenCount,
  formatTokensPerSecond,
  isUsageSnapshotRunning,
  resolveGenerationSpeedTier,
  type StreamingAssistantText,
  type StreamingLiveAnchor,
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

/** 生成中的本地估算：带会话/轮次归属，切换会话或进入下一轮时旧值立即失效。 */
interface LiveUsage {
  sessionId: string | null;
  turnId: string;
  values: UsageRowValues;
}

/** 本轮结束瞬间冻结的估算：保留最后数字但去掉「生成中」，等权威值接管。 */
interface FrozenUsage {
  sessionId: string | null;
  values: UsageRowValues;
  endedAt: number;
}

/** 权威快照 + 本地到达时间：handoff 期用它判断“新权威是否已接管”。 */
interface CompletedUsage {
  sessionId: string | null;
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
 *   state**（流式 delta 只更新 ref，不驱动数字），避免显示频率过高。时钟锚点全部
 *   用渲染进程本地时间，不混用 row.createdAt（远程会话两侧时钟有偏差）。
 * - 工具调用把一轮切成多段正文：输出量按轮累计，速率只按当前段计算；工具执行期间
 *   沿用本轮最后一次估算并保持「生成中」，不冻结、不重复拉权威。
 * - 本轮结束以本轮 turnHeader.state 离开 running 为准（header 不在窗口时退回会话
 *   phase），而不是“流式行消失”（工具调用期间同样没有流式行）。
 * - 结束后估算值冻结（不带「生成中」），并按 1s/3s/8s 重试拉权威 usage；新请求落库
 *   （requestId 变化）即接管。只刷一次不够——落库常慢于流式行消失，冻结值会长时间
 *   停在「生成中」（实测 bug）。
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

  const rows = conversationSnapshot?.rows.window;
  const streamingRow = findStreamingAssistantText(rows);
  const isStreaming = streamingRow !== null;

  const liveAnchorRef = useRef<StreamingLiveAnchor | null>(null);
  if (streamingRow) {
    liveAnchorRef.current = advanceStreamingAnchor(liveAnchorRef.current, streamingRow, Date.now());
  }
  // 工具调用空窗期沿用本轮的估算值；本轮结束时（freeze）锚点会被清空。
  const activeTurnId = streamingRow?.turnId ?? liveAnchorRef.current?.turnId ?? null;

  // 本轮是否仍在生成：优先用本轮 turnHeader（投影的轮次边界），header 不在窗口或
  // 不属于当前轮时退回会话 phase。工具调用期间没有流式正文行、但 header 仍是 running。
  const latestTurn = findLatestTurnActivity(rows);
  const turnRunning =
    latestTurn !== null && activeTurnId !== null && latestTurn.turnId === activeTurnId
      ? latestTurn.running
      : conversationSnapshot?.control.phase === "running";

  // ---- 生成中估算：ref 收集最新流式行，tick 时快照进 state ----
  const streamingRowRef = useRef<StreamingAssistantText | null>(streamingRow);
  streamingRowRef.current = streamingRow;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const lastLiveRef = useRef<UsageRowValues | null>(null);
  const wasTurnActiveRef = useRef(false);
  const [live, setLive] = useState<LiveUsage | null>(null);
  const [frozen, setFrozen] = useState<FrozenUsage | null>(null);
  const [completed, setCompleted] = useState<CompletedUsage | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const lastSessionIdRef = useRef(sessionId);

  // ---- 会话切换：所有派生展示值同步失效，绝不沿用上一任务的指标 ----
  // 必须先于 freeze/估算 effect 执行：否则会用上一会话的最后估算按新会话冻结一次。
  useEffect(() => {
    if (lastSessionIdRef.current === sessionId) return;
    lastSessionIdRef.current = sessionId;
    liveAnchorRef.current = null;
    lastLiveRef.current = null;
    wasTurnActiveRef.current = false;
    setLive(null);
    setFrozen(null);
    setCompleted(null);
    setIsRunning(false);
  }, [sessionId]);

  useEffect(() => {
    if (!isStreaming) return;
    const compute = () => {
      const row = streamingRowRef.current;
      const anchor = liveAnchorRef.current;
      if (!row || !anchor) return;
      const next = buildStreamingLiveValues({
        text: row.text,
        turnOutputTokens: estimateTurnOutputTokens(rowsRef.current, row.turnId),
        anchor,
        now: Date.now(),
        minGenerationMs: STREAMING_TICK_MS,
      });
      const values: UsageRowValues = {
        ...next,
        // 同一轮的新正文段首秒样本不足：沿用上一段最后速率，避免速率段闪空一下
        // 导致整行宽度跳动。新段满 1s 后自然切换为本段实测值。
        tokensPerSecond: next.tokensPerSecond ?? lastLiveRef.current?.tokensPerSecond ?? null,
        modelId: "",
        running: true,
      };
      lastLiveRef.current = values;
      setLive({ sessionId, turnId: row.turnId, values });
    };
    compute();
    const timer = window.setInterval(compute, STREAMING_TICK_MS);
    return () => window.clearInterval(timer);
  }, [isStreaming, sessionId]);

  // ---- 流结束 handoff：冻结估算（去掉「生成中」标记）+ 重试拉权威 ----
  useEffect(() => {
    const turnActive = isStreaming || turnRunning;
    if (wasTurnActiveRef.current && !turnActive) {
      if (lastLiveRef.current) {
        // 本轮结束：冻结值不再标「生成中」。
        setFrozen({
          sessionId,
          values: { ...lastLiveRef.current, running: false },
          endedAt: Date.now(),
        });
      }
      // 清掉锚点：下一轮若以工具调用开场（尚无正文行），不能复用上一轮的估算。
      liveAnchorRef.current = null;
      lastLiveRef.current = null;
      void refresh();
      const timers = HANDOFF_REFRESH_DELAYS_MS.map((delay) =>
        window.setTimeout(() => void refresh(), delay),
      );
      wasTurnActiveRef.current = false;
      return () => {
        for (const timer of timers) window.clearTimeout(timer);
      };
    }
    wasTurnActiveRef.current = turnActive;
  }, [isStreaming, turnRunning, refresh, sessionId]);

  // ---- 权威快照：requestId 不变不刷新到达时间，handoff 才能分辨新旧 ----
  useEffect(() => {
    const latest = model.latest;
    if (!latest) {
      setIsRunning(false);
      return;
    }
    setIsRunning(isUsageSnapshotRunning(latest));
    if (latest.tokensPerSecond === null && isUsageSnapshotRunning(latest)) {
      return; // 请求进行中且速率不可算：保留上一份权威
    }
    setCompleted((prev) =>
      prev?.sessionId === sessionId && prev.snapshot.requestId === latest.requestId
        ? prev
        : { sessionId, snapshot: latest, arrivedAt: Date.now() },
    );
  }, [model.latest, sessionId]);

  // ---- 合成展示值 ----
  const ownedLive =
    live && live.sessionId === sessionId && activeTurnId !== null && live.turnId === activeTurnId
      ? live.values
      : null;
  const liveValues = ownedLive && (isStreaming || turnRunning) ? ownedLive : null;

  const ownedFrozen = frozen && frozen.sessionId === sessionId ? frozen : null;
  const ownedCompleted = completed && completed.sessionId === sessionId ? completed : null;
  const authorityValues: UsageRowValues | null = ownedCompleted
    ? {
        tokensPerSecond: ownedCompleted.snapshot.tokensPerSecond,
        outputTokens: ownedCompleted.snapshot.outputTokens,
        timeToFirstTokenMs: ownedCompleted.snapshot.timeToFirstTokenMs,
        durationMs: ownedCompleted.snapshot.durationMs,
        generationMs: ownedCompleted.snapshot.generationMs,
        modelId: ownedCompleted.snapshot.modelId,
        // 会话已不在 running 时，即便权威记录里仍是 running 也不再标「生成中」
        // （落库滞后会把「生成完毕仍提示生成中」重现）。
        running: isRunning && turnRunning,
      }
    : null;

  let values: UsageRowValues | null;
  if (liveValues) {
    values = liveValues;
  } else if (ownedFrozen && (!ownedCompleted || ownedCompleted.arrivedAt < ownedFrozen.endedAt)) {
    values = ownedFrozen.values;
  } else {
    values = authorityValues ?? ownedFrozen?.values ?? null;
  }

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
