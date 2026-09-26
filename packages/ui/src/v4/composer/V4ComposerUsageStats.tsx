import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeTaskTokenUsageResult } from "@zcode/shared";
import { TID_V4_USAGE_STATS } from "@zcode/shared";
import type { V4ConversationUsageDetailResult } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  buildUsageStatusBarModel,
  formatCompactTokenCount,
  formatDurationMs,
  formatFullTokenCount,
  formatPercent,
  formatTokensPerSecond,
  hasUsageStatusBarContent,
  resolveGenerationSpeedTier,
  type UsageStatusBarModel,
} from "./usageStatusBarModel.js";

/** 轮询间隔：轮次结束后聚合落库通常在秒级，10s 足够“常驻但不吵”。 */
const USAGE_STATS_POLL_INTERVAL_MS = 10_000;

const SPEED_TIER_CLASS: Record<ReturnType<typeof resolveGenerationSpeedTier>, string> = {
  fast: "text-success",
  medium: "text-warning",
  slow: "text-destructive",
};

interface V4ComposerUsageStatsProps {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 草稿态为 null：只展示「今日」，不请求会话聚合。 */
  sessionId: string | null;
}

/**
 * Composer 用量状态栏：会话 / 今日累计 + 生成速率 + 当前轮次 + 工具调用。
 *
 * 数据全部来自既有服务面：会话与明细 = zcodeTaskService（协议直达 agent SQLite），
 * 今日 = usageStatsService.getAppUsageSnapshot({range:"today"})。上下文占比由既有
 * ChatContextUsage 负责，这里不重复。产品规则见 packages/ui/docs/usage-status-bar.md。
 */
export function V4ComposerUsageStats({
  workspacePath,
  workspaceIdentity,
  sessionId,
}: V4ComposerUsageStatsProps) {
  const { intl, locale } = useZCodeIntl();
  const { zcodeTaskService, usageStatsService } = useServices();
  const [model, setModel] = useState<UsageStatusBarModel>({
    session: null,
    todayTotalTokens: null,
    turn: null,
    generation: null,
    tools: null,
    subagents: null,
  });
  const requestSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    type SessionReads = {
      usage: ZCodeTaskTokenUsageResult | null;
      detail: V4ConversationUsageDetailResult | null;
    };
    const sessionReads: Promise<SessionReads> = sessionId
      ? Promise.all([
          zcodeTaskService
            .getTaskTokenUsage({ taskId: sessionId, workspacePath, workspaceIdentity })
            .catch((error) => {
              logger.warn("[usage-status-bar] 读取会话用量失败", {
                sessionId,
                error: error instanceof Error ? error.message : String(error),
              });
              return null;
            }),
          zcodeTaskService
            .getTaskTokenUsageDetail({ taskId: sessionId, workspacePath, workspaceIdentity })
            .catch((error) => {
              logger.warn("[usage-status-bar] 读取会话用量明细失败", {
                sessionId,
                error: error instanceof Error ? error.message : String(error),
              });
              return null;
            }),
        ]).then(([usage, detail]) => ({ usage, detail }))
      : Promise.resolve({ usage: null, detail: null });

    const todayPromise = usageStatsService
      .getAppUsageSnapshot({ range: "today", timeZone })
      .then((snapshot) => snapshot.summary.totalTokens)
      .catch((error) => {
        logger.warn("[usage-status-bar] 读取今日用量失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });

    const [{ usage, detail }, todayTotalTokens] = await Promise.all([sessionReads, todayPromise]);
    if (requestSeqRef.current !== requestSeq) {
      return;
    }
    setModel(buildUsageStatusBarModel({ taskUsage: usage, todayTotalTokens, detail }));
  }, [sessionId, usageStatsService, workspaceIdentity, workspacePath, zcodeTaskService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      // 不可见时跳过轮询：后台标签页没有常驻指标的受众。
      if (document.visibilityState === "visible") {
        void refresh();
      }
    }, USAGE_STATS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const sessionTooltip = useMemo(() => {
    if (!model.session) return null;
    return intl.formatMessage(
      { id: "composer.usage.sessionTooltip" },
      {
        total: formatFullTokenCount(locale, model.session.totalTokens),
        requests: formatFullTokenCount(locale, model.session.modelRequestCount),
      },
    );
  }, [intl, locale, model.session]);

  const todayTooltip = useMemo(() => {
    if (model.todayTotalTokens === null) return null;
    return intl.formatMessage(
      { id: "composer.usage.todayTooltip" },
      { total: formatFullTokenCount(locale, model.todayTotalTokens) },
    );
  }, [intl, locale, model.todayTotalTokens]);

  const speedTooltip = useMemo(() => {
    if (!model.generation) return null;
    return intl.formatMessage(
      { id: "composer.usage.speedTooltip" },
      {
        model: model.generation.modelId,
        output: formatFullTokenCount(locale, model.generation.outputTokens),
        duration: formatDurationMs(locale, model.generation.generationMs) ?? "--",
      },
    );
  }, [intl, locale, model.generation]);

  const turnTooltip = useMemo(() => {
    if (!model.turn) return null;
    return intl.formatMessage(
      { id: "composer.usage.turnTooltip" },
      {
        input: formatFullTokenCount(locale, model.turn.inputTokens),
        output: formatFullTokenCount(locale, model.turn.outputTokens),
        cacheRead: formatFullTokenCount(locale, model.turn.cacheReadTokens),
        cacheWrite: formatFullTokenCount(locale, model.turn.cacheCreationTokens),
        reasoning: formatFullTokenCount(locale, model.turn.reasoningTokens),
        requests: formatFullTokenCount(locale, model.turn.modelRequestCount),
        duration: formatDurationMs(locale, model.turn.durationMs) ?? "--",
        ttft: formatDurationMs(locale, model.turn.timeToFirstTokenMs) ?? "--",
      },
    );
  }, [intl, locale, model.turn]);

  const toolsTooltip = useMemo(() => {
    if (!model.tools) return null;
    const breakdown = model.tools.items
      .slice(0, 8)
      .map((item) => `${item.toolName} ×${item.callCount}`)
      .join(", ");
    return intl.formatMessage(
      { id: "composer.usage.toolsTooltip" },
      {
        calls: formatFullTokenCount(locale, model.tools.toolCallCount),
        errors: formatFullTokenCount(locale, model.tools.toolErrorCount),
        breakdown: breakdown.length > 0 ? breakdown : "--",
      },
    );
  }, [intl, locale, model.tools]);

  const subagentsTooltip = useMemo(() => {
    if (!model.subagents) return null;
    const breakdown = model.subagents.items
      .slice(0, 6)
      .map((item) => `${item.childSessionId.slice(0, 8)} ×${item.totalTokens}`)
      .join(", ");
    return intl.formatMessage(
      { id: "composer.usage.subagentsTooltip" },
      {
        total: formatFullTokenCount(locale, model.subagents.totalTokens),
        sessions: formatFullTokenCount(locale, model.subagents.sessionCount),
        requests: formatFullTokenCount(locale, model.subagents.requestCount),
        breakdown: breakdown.length > 0 ? breakdown : "--",
      },
    );
  }, [intl, locale, model.subagents]);

  const speedTier = model.generation
    ? resolveGenerationSpeedTier(model.generation.tokensPerSecond)
    : null;
  const turnCacheHitRate = formatPercent(locale, model.turn?.cacheHitRate ?? null);

  if (!hasUsageStatusBarContent(model)) {
    return null;
  }

  return (
    <div
      data-testid={TID_V4_USAGE_STATS}
      className="flex shrink-0 items-center gap-2.5 text-ui-xs text-foreground-subtle"
    >
      {model.generation && speedTier ? (
        <span className={SPEED_TIER_CLASS[speedTier]} title={speedTooltip ?? undefined}>
          {formatTokensPerSecond(locale, model.generation.tokensPerSecond)}
          <span className="text-foreground-subtle"> tok/s</span>
        </span>
      ) : null}
      {model.turn ? (
        <span title={turnTooltip ?? undefined}>
          {intl.formatMessage({ id: "composer.usage.turn" })}
          &nbsp;{formatCompactTokenCount(locale, model.turn.totalTokens)}
          {turnCacheHitRate ? (
            <span className="text-foreground-subtlest"> · {turnCacheHitRate}</span>
          ) : null}
        </span>
      ) : null}
      {model.session ? (
        <span title={sessionTooltip ?? undefined}>
          {intl.formatMessage({ id: "composer.usage.session" })}
          &nbsp;{formatCompactTokenCount(locale, model.session.totalTokens)}
        </span>
      ) : null}
      {model.todayTotalTokens !== null ? (
        <span title={todayTooltip ?? undefined}>
          {intl.formatMessage({ id: "composer.usage.today" })}
          &nbsp;{formatCompactTokenCount(locale, model.todayTotalTokens)}
        </span>
      ) : null}
      {model.tools ? (
        <span title={toolsTooltip ?? undefined}>
          {intl.formatMessage({ id: "composer.usage.tools" })}
          &nbsp;{formatFullTokenCount(locale, model.tools.toolCallCount)}
          {model.tools.toolErrorCount > 0 ? (
            <span className="text-destructive"> !{model.tools.toolErrorCount}</span>
          ) : null}
        </span>
      ) : null}
      {model.subagents ? (
        <span title={subagentsTooltip ?? undefined}>
          {intl.formatMessage({ id: "composer.usage.subagents" })}
          &nbsp;{formatCompactTokenCount(locale, model.subagents.totalTokens)}
          <span className="text-foreground-subtlest"> ×{model.subagents.sessionCount}</span>
        </span>
      ) : null}
    </div>
  );
}
