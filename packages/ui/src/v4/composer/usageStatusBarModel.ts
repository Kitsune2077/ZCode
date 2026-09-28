import type { V4ConversationUsageDetailResult } from "@zcode/shared/zcode-protocol-v4";

/**
 * Composer 生成速率指标的纯派生逻辑（组件只做 IO 与渲染）。
 *
 * 速率按“首 token → 完成”的生成时长计算（与社区工具同口径），而不是整请求时长：
 * 后者包含排队与首 token 延迟，会把模型速度系统性算低。
 *
 * 用量类指标（会话/今日/轮次/工具/子代理累计）刻意不在状态栏展示：
 * 左侧用量圆环（ChatContextUsage）与设置 → 用量页已承担该职责；完整数据仍可经
 * v4/conversation/usageDetail 协议读取，供后续查询类入口（工具/命令）复用。
 */

export interface UsageStatusBarGeneration {
  /** tokens/秒；generationMs 缺失或为 0 时为 null。 */
  readonly tokensPerSecond: number;
  readonly outputTokens: number;
  readonly generationMs: number;
  readonly modelId: string;
}

export interface UsageStatusBarModel {
  /** 最近一次请求的生成速率；null = 缺首 token/完成时间或尚无请求，无法计算。 */
  readonly generation: UsageStatusBarGeneration | null;
}

export function buildUsageStatusBarModel(input: {
  detail?: V4ConversationUsageDetailResult | null;
}): UsageStatusBarModel {
  return {
    generation: deriveGeneration(input.detail ?? null),
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

/** 生成速率三档（与社区工具一致的 70/40 分界）；上下文分档仍由既有 ChatContextUsage 负责。 */
export type GenerationSpeedTier = "fast" | "medium" | "slow";

export function resolveGenerationSpeedTier(tokensPerSecond: number): GenerationSpeedTier {
  if (tokensPerSecond >= 70) return "fast";
  if (tokensPerSecond >= 40) return "medium";
  return "slow";
}

/** 无速率可展示时状态栏整体隐藏。 */
export function hasUsageStatusBarContent(model: UsageStatusBarModel): boolean {
  return model.generation !== null;
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
