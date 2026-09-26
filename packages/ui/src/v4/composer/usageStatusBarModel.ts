import type { ZCodeTaskTokenUsageResult } from "@zcode/shared";

/**
 * Composer 用量状态栏的纯派生逻辑（组件只做 IO 与渲染）。
 *
 * 口径（与 agent 侧 usage-stats-builder 一致）：totalTokens = input + output，
 * cacheRead 已含在 input 内，不重复累加。
 */

export interface UsageStatusBarSessionUsage {
  readonly totalTokens: number;
  readonly modelRequestCount: number;
}

export interface UsageStatusBarModel {
  /** 会话累计；null = 无会话（草稿态）或尚未取到。 */
  readonly session: UsageStatusBarSessionUsage | null;
  /** 今日（本地时区自然日）累计；null = 尚未取到。 */
  readonly todayTotalTokens: number | null;
}

export function buildUsageStatusBarModel(input: {
  taskUsage: ZCodeTaskTokenUsageResult | null;
  todayTotalTokens: number | null;
}): UsageStatusBarModel {
  const taskUsage = input.taskUsage && input.taskUsage.totalTokens > 0 ? input.taskUsage : null;
  return {
    session: taskUsage
      ? {
          totalTokens: taskUsage.totalTokens,
          modelRequestCount: taskUsage.modelRequestCount,
        }
      : null,
    todayTotalTokens:
      typeof input.todayTotalTokens === "number" && input.todayTotalTokens > 0
        ? input.todayTotalTokens
        : null,
  };
}

/** 无任何可展示数据时状态栏整体隐藏。 */
export function hasUsageStatusBarContent(model: UsageStatusBarModel): boolean {
  return model.session !== null || model.todayTotalTokens !== null;
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
