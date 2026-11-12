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
}

/** 从 snapshot.rows.window 尾部找当前 streaming 的 assistantText 行。 */
export function findStreamingAssistantText(
  rows: readonly ConversationRow[] | undefined,
): StreamingAssistantText | null {
  if (!rows || rows.length === 0) return null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.kind !== "assistantText" || row.state !== "streaming") continue;
    return { turnId: row.turnId, rowId: row.rowId, text: row.text };
  }
  return null;
}

/**
 * 最近一轮的生成状态（rows 升序，取尾部最后一个 turnHeader）。
 *
 * turnHeader 是 projection 的权威轮次边界：已终态的主轮不会被同轮后台工具/子代理行
 * 重新推成 running。会话级 `control.phase` 还会被 goal verifier 等非本轮工作占住，
 * 单独用它判断“本轮结束”会让上一轮估算长期停在「生成中」。
 * executionKind=controlOnly 的轮次没有模型生成，恒为 false。
 */
export interface TurnActivity {
  readonly turnId: string;
  readonly running: boolean;
}

export function findLatestTurnActivity(
  rows: readonly ConversationRow[] | undefined,
): TurnActivity | null {
  if (!rows) return null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.kind !== "turnHeader") continue;
    return {
      turnId: row.turnId,
      running: row.executionKind !== "controlOnly" && row.state === "running",
    };
  }
  return null;
}

/**
 * 生成中估算的时钟锚点，全部取渲染进程本地时钟（Date.now）。
 *
 * 不能用 row.createdAt：远程 workspace 的 row 时间来自 agent 侧时钟，与本地时钟存在
 * 未知偏差；两边混用会把 TTFT 算成负数或巨大值（实测远程会话）。
 */
export interface StreamingLiveAnchor {
  readonly turnId: string;
  /** 当前正文段的 rowId：工具调用会把一轮切成多段，速率必须按段计算。 */
  readonly rowId: number;
  /** 本轮首次观察时刻：TTFT 与时长从这里起算。 */
  readonly turnStartedAt: number;
  /** 本轮首个 token 的本地时刻。 */
  readonly firstTokenAt: number | null;
  /** 当前段首个 token 的本地时刻：速率分母只含本段生成时间。 */
  readonly segmentFirstTokenAt: number | null;
}

/**
 * 推进流式锚点：新轮重建，同轮新段保留 TTFT 但重置速率起点，首个非空正文记录 token 时刻。
 *
 * 同轮多段是常态（正文 → 工具 → 正文）；若沿用上一段锚点，速率分子只含本段 token、
 * 分母却跨过工具执行时间，数字会被系统性算低（实测多段轮次速率明显偏低）。
 */
export function advanceStreamingAnchor(
  previous: StreamingLiveAnchor | null,
  row: StreamingAssistantText,
  now: number,
): StreamingLiveAnchor {
  const hasText = row.text.trim().length > 0;
  if (!previous || previous.turnId !== row.turnId) {
    return {
      turnId: row.turnId,
      rowId: row.rowId,
      turnStartedAt: now,
      firstTokenAt: hasText ? now : null,
      segmentFirstTokenAt: hasText ? now : null,
    };
  }
  const segmentFirstTokenAt =
    previous.rowId === row.rowId
      ? (previous.segmentFirstTokenAt ?? (hasText ? now : null))
      : (hasText ? now : null);
  return {
    ...previous,
    rowId: row.rowId,
    firstTokenAt: previous.firstTokenAt ?? (hasText ? now : null),
    segmentFirstTokenAt,
  };
}

export interface StreamingLiveValues {
  /** 当前段速率；首 token 后样本不足 minGenerationMs 时为 null（避免数字剧烈跳动）。 */
  readonly tokensPerSecond: number | null;
  /** 本轮累计输出估算（含已完成段），不会因工具调用回退。 */
  readonly outputTokens: number;
  readonly timeToFirstTokenMs: number | null;
  readonly durationMs: number;
  readonly generationMs: number | null;
}

export function buildStreamingLiveValues(input: {
  text: string;
  turnOutputTokens: number;
  anchor: StreamingLiveAnchor;
  now: number;
  minGenerationMs: number;
}): StreamingLiveValues {
  const { text, turnOutputTokens, anchor, now, minGenerationMs } = input;
  const segmentTokens = estimateStreamingOutputTokens(text);
  const segmentGenerationMs =
    anchor.segmentFirstTokenAt === null ? null : Math.max(0, now - anchor.segmentFirstTokenAt);
  return {
    tokensPerSecond:
      segmentGenerationMs !== null && segmentGenerationMs >= minGenerationMs && segmentTokens > 0
        ? segmentTokens / (segmentGenerationMs / 1000)
        : null,
    outputTokens: turnOutputTokens,
    timeToFirstTokenMs:
      anchor.firstTokenAt === null ? null : Math.max(0, anchor.firstTokenAt - anchor.turnStartedAt),
    durationMs: Math.max(0, now - anchor.turnStartedAt),
    generationMs: anchor.firstTokenAt === null ? null : Math.max(0, now - anchor.firstTokenAt),
  };
}

/**
 * 本轮累计输出估算：窗口内同 turnId 的 assistantText 全部计入。
 *
 * 输出量按轮累计而不是只看当前段，否则每次工具返回后数字会从 0 重新上涨（实测观感）；
 * 窗口滚动导致更早的段不在 window 内时可能低估，完成后由权威 outputTokens 覆盖。
 */
export function estimateTurnOutputTokens(
  rows: readonly ConversationRow[] | undefined,
  turnId: string,
): number {
  if (!rows) return 0;
  let total = 0;
  for (const row of rows) {
    if (row.kind === "assistantText" && row.turnId === turnId) {
      total += estimateStreamingOutputTokens(row.text);
    }
  }
  return total;
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
