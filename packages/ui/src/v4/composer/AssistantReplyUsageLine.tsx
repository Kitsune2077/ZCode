import { useEffect, useMemo, useState } from "react";
import { TID_ASSISTANT_USAGE_LINE } from "@zcode/shared";
import { Zap } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildUsageStatusBarModel,
  formatCompactTokenCount,
  formatDurationMs,
  formatTokensPerSecond,
  isUsageSnapshotRunning,
  resolveGenerationSpeedTier,
} from "./usageStatusBarModel.js";
import { useUsageDetail } from "./useUsageDetail.js";

/** 轮次刚结束时 usage 行可能还在落库：首屏没拿到就按该节奏重试（最多三次）。 */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;

const SPEED_TIER_CLASS: Record<ReturnType<typeof resolveGenerationSpeedTier>, string> = {
  fast: "text-success",
  medium: "text-warning",
  slow: "text-destructive",
};

/** 与插件回答末尾统计行同款弱分隔：中文用 ·，保持单行轻量。 */
function Dot() {
  return (
    <span aria-hidden="true" className="text-foreground-subtlest">
      ·
    </span>
  );
}

interface AssistantReplyUsageLineProps {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null | undefined;
  /** 轮次完成时变化（turnId），用于完成后刷新一次。 */
  refreshKey: string;
  compactForRemoteControl?: boolean;
}

/**
 * 回复末尾的用量统计行（仅最新轮）。
 *
 * 对齐社区插件的「回答末尾速率行」：⚡ 速率（本轮）· 首字 · 输出 token · 生成时长。
 * 与输入卡底部的状态条同源（v4/conversation/usageDetail），不引入新协议字段；
 * 只在终态渲染，避免把进行中的半成品数字当成结论。
 * 产品规则见 packages/ui/docs/usage-status-bar.md。
 */
export function AssistantReplyUsageLine({
  workspacePath,
  workspaceIdentity,
  sessionId,
  refreshKey,
  compactForRemoteControl = false,
}: AssistantReplyUsageLineProps) {
  const { intl, locale } = useZCodeIntl();
  const { detail, refresh } = useUsageDetail({
    sessionId,
    workspacePath,
    workspaceIdentity,
    refreshKey,
  });

  // 数据必须属于当前这一轮：usageDetail.latestRequest 只是“最近一次请求”，
  // 新轮刚结束时它可能仍是上一轮的记录；只看 latestRequest 会把上一轮的数字
  // 贴到本轮回答下面（且不会自行刷新）。turn_usage 的 turnId 是轮次归属的权威标识。
  // queue drain 会把同一 runtime turn 拆成多个 product turn（id 为 `<runtime>~qN`），
  // 这层前缀映射也要接受；其余不匹配一律视为尚未落库。
  // modelRequestCount = 0 的轮次（UserPromptSubmit hook 拦截等）没有本轮请求数据，
  // latestRequest 只可能是上一轮的，不能贴到本轮回复下面。
  const latestTurn = detail?.latestTurn ?? null;
  const usageReady =
    detail?.latestRequest != null &&
    (latestTurn === null ||
      (latestTurn.modelRequestCount > 0 &&
        (latestTurn.turnId === refreshKey || refreshKey.startsWith(`${latestTurn.turnId}~q`))));

  // 轮次刚结束时 usage 行可能还在落库：首屏没拿到就短重试 1s/3s/8s，最多三次。
  // 不能按 detail 变化无限续期：无 usage 记录的轮次会退化成每秒一次的永久轮询
  // （refresh 成功也会产生新的 detail 对象，effect 再次重排定时器，实测）。
  const [retryAttempt, setRetryAttempt] = useState(0);
  useEffect(() => {
    setRetryAttempt(0);
  }, [refreshKey]);
  useEffect(() => {
    if (usageReady || retryAttempt >= RETRY_DELAYS_MS.length) return;
    const timer = window.setTimeout(() => {
      setRetryAttempt((attempt) => attempt + 1);
      void refresh();
    }, RETRY_DELAYS_MS[retryAttempt]);
    return () => window.clearTimeout(timer);
  }, [usageReady, retryAttempt, refresh]);
  const model = useMemo(() => buildUsageStatusBarModel({ detail }), [detail]);
  const snapshot = model.latest;
  if (!usageReady || !snapshot || isUsageSnapshotRunning(snapshot)) return null;

  const speedTier =
    snapshot.tokensPerSecond != null
      ? resolveGenerationSpeedTier(snapshot.tokensPerSecond)
      : null;
  const speed =
    snapshot.tokensPerSecond != null
      ? formatTokensPerSecond(locale, snapshot.tokensPerSecond)
      : null;

  return (
    <div
      data-testid={TID_ASSISTANT_USAGE_LINE}
      className={
        compactForRemoteControl
          ? "mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ui-xs text-foreground-subtle tabular-nums"
          : "mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ui-xs text-foreground-subtle tabular-nums opacity-85"
      }
    >
      <Zap className="size-3 shrink-0 text-foreground-subtlest" aria-hidden="true" />
      {speed !== null ? (
        <span className={speedTier ? SPEED_TIER_CLASS[speedTier] : undefined}>
          {intl.formatMessage({ id: "chat.message.usage.speedInTurn" }, { value: speed })}
        </span>
      ) : null}
      {snapshot.timeToFirstTokenMs != null ? (
        <>
          <Dot />
          <span>
            {intl.formatMessage(
              { id: "chat.message.usage.ttft" },
              { value: formatDurationMs(locale, snapshot.timeToFirstTokenMs) ?? "--" },
            )}
          </span>
        </>
      ) : null}
      {snapshot.outputTokens > 0 ? (
        <>
          <Dot />
          <span>
            {intl.formatMessage(
              { id: "chat.message.usage.tokens" },
              { value: formatCompactTokenCount(locale, snapshot.outputTokens) },
            )}
          </span>
        </>
      ) : null}
      {snapshot.durationMs != null ? (
        <>
          <Dot />
          <span>
            {intl.formatMessage(
              { id: "chat.message.usage.duration" },
              { value: formatDurationMs(locale, snapshot.durationMs) ?? "--" },
            )}
          </span>
        </>
      ) : null}
    </div>
  );
}
