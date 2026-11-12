import type {
  ConversationRow,
  V4ConversationUsageDetailResult,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * Composer 用量状态条的纯派生逻辑（组件只做 IO 与渲染）。
 *
 * 速率按“首 token → 完成”的生成时长计算（与社区工具同口径），而不是整请求时长：
 * 后者包含排队与首 token 延迟，会把模型速度系统性算低。
 *
 * 状态条只承担“模型此刻多快 + 这次生成了多少”（速率/输出 token/TTFT/时长）；
 * 会话/今日/轮次/工具/子代理累计仍由左侧用量圆环（ChatContextUsage）与设置 → 用量页
 * 承担，完整数据经 v4/conversation/usageDetail 协议读取。
 *
 * 产品规则见 packages/ui/docs/usage-status-bar.md。
 */

export interface UsageStatusBarSnapshot {
  /** 请求唯一标识：handoff 期用它分辨“新权威是否已落库接管”。 */
  readonly requestId: string;
  /** tokens/秒；生成时长缺失、为 0 或请求仍在跑时为 null。 */
  readonly tokensPerSecond: number | null;
  readonly outputTokens: number;
  /** 首 token → 完成的生成时长；null 表示无法计算（未完成或首 token 缺失）。 */
  readonly generationMs: number | null;
  /** 整请求耗时（含排队与首 token 延迟）。 */
  readonly durationMs: number | null;
  /** 首字延迟。 */
  readonly timeToFirstTokenMs: number | null;
  readonly modelId: string;
  readonly status: string;
}

export interface UsageStatusBarModel {
  /** 最近一条请求的快照；null = 无会话/无请求记录（草稿态）。 */
  readonly latest: UsageStatusBarSnapshot | null;
}

export function buildUsageStatusBarModel(input: {
  detail?: V4ConversationUsageDetailResult | null;
}): UsageStatusBarModel {
  return {
    latest: deriveSnapshot(input.detail?.latestRequest ?? null),
  };
}

function deriveSnapshot(
  request: V4ConversationUsageDetailResult["latestRequest"],
): UsageStatusBarSnapshot | null {
  if (!request) return null;
  // 生成时长缺失（进行中请求）时速率不可算，但其它指标仍是有效事实，不能整条丢弃。
  const hasGenerationWindow = request.generationMs !== null && request.generationMs > 0;
  return {
    requestId: request.requestId,
    tokensPerSecond: hasGenerationWindow
      ? request.outputTokens / (request.generationMs! / 1000)
      : null,
    outputTokens: request.outputTokens,
    generationMs: request.generationMs,
    durationMs: request.durationMs,
    timeToFirstTokenMs: request.timeToFirstTokenMs,
    modelId: request.modelId,
    status: request.status,
  };
}

/** 生成速率三档（与社区工具一致的 70/40 分界）；上下文分档仍由既有 ChatContextUsage 负责。 */
export type GenerationSpeedTier = "fast" | "medium" | "slow";

export function resolveGenerationSpeedTier(tokensPerSecond: number): GenerationSpeedTier {
  if (tokensPerSecond >= 70) return "fast";
  if (tokensPerSecond >= 40) return "medium";
  return "slow";
}

/** 有请求快照即可渲染（含进行中与缺速率的情况）；null 表示草稿态，渲染占位。 */
export function hasUsageStatusBarContent(model: UsageStatusBarModel): boolean {
  return model.latest !== null;
}

/** 请求仍在进行中：状态条保留上一轮已完成指标并标注「生成中」。 */
export function isUsageSnapshotRunning(snapshot: UsageStatusBarSnapshot): boolean {
  return snapshot.status === "running";
}


/** 生成中的流式行（投影 snapshot 尾部），用于实时估算，不写入任何事实。 */
export interface StreamingAssistantText {
  readonly turnId: string;
  readonly rowId: number;
  readonly text: string;
  /** 行创建时间（= 本轮开始），作为 TTFT/耗时的锚点。 */
  readonly startedAt: number;
}

/** 从 snapshot.rows.window 尾部找当前 streaming 的 assistantText 行。 */
export function findStreamingAssistantText(
  rows: readonly ConversationRow[] | undefined,
): StreamingAssistantText | null {
  if (!rows || rows.length === 0) return null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.kind !== "assistantText" || row.state !== "streaming") continue;
    return { turnId: row.turnId, rowId: row.rowId, text: row.text, startedAt: row.createdAt };
  }
  return null;
}

const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;

/**
 * 由流式正文估算输出 token（仅用于生成中的实时展示）。
 *
 * 口径：CJK 约 1 字 1 token，其余非空白字符约 4 字符 1 token——启发式估算，
 * 不含思考 token 与工具调用；完成后由 usageDetail 的真实 outputTokens 覆盖。
 */
export function estimateStreamingOutputTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_PATTERN.test(char)) cjk += 1;
    else if (!/\s/.test(char)) other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** tooltip 用完整值。 */
export function formatFullTokenCount(locale: string, value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  return new Intl.NumberFormat(locale).format(safe);
}

/** 状态条用短单位：1000 → 1K，1_200_000 → 1.2M（与社区工具默认口径一致）。 */
export function formatCompactTokenCount(locale: string, value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  if (safe < 1000) return new Intl.NumberFormat(locale).format(safe);
  if (safe < 1_000_000) return `${trimTrailingZero(safe / 1000)}K`;
  if (safe < 1_000_000_000) return `${trimTrailingZero(safe / 1_000_000)}M`;
  return `${trimTrailingZero(safe / 1_000_000_000)}B`;
}

function trimTrailingZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
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
