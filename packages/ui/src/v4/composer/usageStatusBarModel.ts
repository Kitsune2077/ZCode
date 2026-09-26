import type { ZCodeTaskTokenUsageResult } from "@zcode/shared";
import type { V4ConversationUsageDetailResult } from "@zcode/shared/zcode-protocol-v4";

/**
 * Composer 用量状态栏的纯派生逻辑（组件只做 IO 与渲染）。
 *
 * 口径（与 agent 侧 usage-stats-builder 一致）：totalTokens = input + output，
 * cacheRead 已含在 input 内，不重复累加。
 *
 * 生成速率按“首 token → 完成”的生成时长计算（与社区工具同口径），而不是整请求时长：
 * 后者包含排队与首 token 延迟，会把模型速度算低。
 */

export interface UsageStatusBarSessionUsage {
  readonly totalTokens: number;
  readonly modelRequestCount: number;
}

export interface UsageStatusBarTurnUsage {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheHitRate: number | null;
  readonly modelRequestCount: number;
  readonly durationMs: number | null;
  readonly timeToFirstTokenMs: number | null;
  readonly status: string;
}

export interface UsageStatusBarGeneration {
  /** tokens/秒；generationMs 缺失或为 0 时为 null。 */
  readonly tokensPerSecond: number;
  readonly outputTokens: number;
  readonly generationMs: number;
  readonly modelId: string;
}

export interface UsageStatusBarToolUsage {
  readonly toolCallCount: number;
  readonly toolErrorCount: number;
  readonly items: readonly {
    readonly toolName: string;
    readonly callCount: number;
    readonly errorCount: number;
  }[];
}

export interface UsageStatusBarModel {
  /** 会话累计；null = 无会话（草稿态）或尚未取到。 */
  readonly session: UsageStatusBarSessionUsage | null;
  /** 今日（本地时区自然日）累计；null = 尚未取到。 */
  readonly todayTotalTokens: number | null;
  /** 最近一轮；null = 该会话还没有完成的轮次。 */
  readonly turn: UsageStatusBarTurnUsage | null;
  /** 最近一次请求的生成速率；null = 缺首 token/完成时间，无法计算。 */
  readonly generation: UsageStatusBarGeneration | null;
  /** 会话级工具调用分布。 */
  readonly tools: UsageStatusBarToolUsage | null;
}

export function buildUsageStatusBarModel(input: {
  taskUsage: ZCodeTaskTokenUsageResult | null;
  todayTotalTokens: number | null;
  detail?: V4ConversationUsageDetailResult | null;
}): UsageStatusBarModel {
  const taskUsage = input.taskUsage && input.taskUsage.totalTokens > 0 ? input.taskUsage : null;
  return {
    session: taskUsage
      ? {
          totalTokens: taskUsage.totalTokens,
          modelRequestCount: taskUsage.modelRequestCount,
        }
      : null,
    todayTotalTokens: positiveOrNull(input.todayTotalTokens),
    turn: deriveTurn(input.detail ?? null),
    generation: deriveGeneration(input.detail ?? null),
    tools: deriveTools(input.detail ?? null),
  };
}

function deriveTurn(detail: V4ConversationUsageDetailResult | null): UsageStatusBarTurnUsage | null {
  const turn = detail?.latestTurn;
  if (!turn) return null;
  const cacheDenom =
    turn.inputTokens > 0 ? turn.inputTokens : turn.cacheCreationTokens + turn.cacheReadTokens;
  return {
    totalTokens: turn.totalTokens,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    reasoningTokens: turn.reasoningTokens,
    cacheReadTokens: turn.cacheReadTokens,
    cacheCreationTokens: turn.cacheCreationTokens,
    // 命中率分母不能叠加 cache 字段：inputTokens 已是 total input（历史上曾因此压低命中率）。
    cacheHitRate: cacheDenom > 0 ? turn.cacheReadTokens / cacheDenom : null,
    modelRequestCount: turn.modelRequestCount,
    durationMs: turn.durationMs,
    timeToFirstTokenMs: turn.timeToFirstTokenMs,
    status: turn.status,
  };
}

function deriveGeneration(
  detail: V4ConversationUsageDetailResult | null,
): UsageStatusBarGeneration | null {
  const request = detail?.latestRequest;
  if (!request || request.generationMs === null || request.generationMs <= 0) {
    return null;
  }
  return {
    tokensPerSecond: request.outputTokens / (request.generationMs / 1000),
    outputTokens: request.outputTokens,
    generationMs: request.generationMs,
    modelId: request.modelId,
  };
}

function deriveTools(detail: V4ConversationUsageDetailResult | null): UsageStatusBarToolUsage | null {
  if (!detail || detail.toolSummary.toolCallCount <= 0) {
    return null;
  }
  return {
    toolCallCount: detail.toolSummary.toolCallCount,
    toolErrorCount: detail.toolSummary.toolErrorCount,
    items: detail.toolSummary.items.map((item) => ({
      toolName: item.toolName,
      callCount: item.callCount,
      errorCount: item.errorCount,
    })),
  };
}

function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** 生成速率三档（与社区工具一致的 70/40 分界）；上下文分档仍由既有 ChatContextUsage 负责。 */
export type GenerationSpeedTier = "fast" | "medium" | "slow";

export function resolveGenerationSpeedTier(tokensPerSecond: number): GenerationSpeedTier {
  if (tokensPerSecond >= 70) return "fast";
  if (tokensPerSecond >= 40) return "medium";
  return "slow";
}

/** 无任何可展示数据时状态栏整体隐藏。 */
export function hasUsageStatusBarContent(model: UsageStatusBarModel): boolean {
  return (
    model.session !== null ||
    model.todayTotalTokens !== null ||
    model.turn !== null ||
    model.generation !== null ||
    model.tools !== null
  );
}

/** 紧凑计法（12.3k / 1.2M）；负值与 NaN 防御性归零。 */
export function formatCompactTokenCount(locale: string, value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(safe);
}

/** tooltip 用完整值。 */
export function formatFullTokenCount(locale: string, value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  return new Intl.NumberFormat(locale).format(safe);
}

/** 速率展示：一位小数；非有限值防御性归零。 */
export function formatTokensPerSecond(locale: string, value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(safe);
}

/** 百分比展示（0.42 → 42%）。 */
export function formatPercent(locale: string, ratio: number | null): string | null {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0, style: "percent" }).format(
    Math.min(Math.max(ratio, 0), 1),
  );
}

/** 时长展示（1234 → 1.2s；65000 → 1m5s）。 */
export function formatDurationMs(locale: string, value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  if (value < 60_000) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 1000)}s`;
  }
  const totalSeconds = Math.round(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds}s`;
}
