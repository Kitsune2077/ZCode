import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeTaskTokenUsageResult } from "@zcode/shared";
import { TID_V4_USAGE_STATS } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  buildUsageStatusBarModel,
  formatCompactTokenCount,
  formatFullTokenCount,
  hasUsageStatusBarContent,
  type UsageStatusBarModel,
} from "./usageStatusBarModel.js";

/** 轮询间隔：轮次结束后聚合落库通常在秒级，10s 足够“常驻但不吵”。 */
const USAGE_STATS_POLL_INTERVAL_MS = 10_000;

interface V4ComposerUsageStatsProps {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 草稿态为 null：只展示「今日」，不请求会话聚合。 */
  sessionId: string | null;
}

/**
 * Composer 用量状态栏（一期）：会话累计 + 今日累计。
 *
 * 数据全部来自既有服务面：会话 = zcodeTaskService.getTaskTokenUsage（协议直达 agent
 * SQLite），今日 = usageStatsService.getAppUsageSnapshot({range:"today"})。上下文占比
 * 由既有 ChatContextUsage 负责，这里不重复。产品规则见
 * packages/ui/docs/usage-status-bar.md。
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
  });
  const requestSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const sessionPromise: Promise<ZCodeTaskTokenUsageResult | null> = sessionId
      ? zcodeTaskService
          .getTaskTokenUsage({ taskId: sessionId, workspacePath, workspaceIdentity })
          .catch((error) => {
            // 会话聚合失败静默降级（warn 可检索），不影响「今日」与输入区。
            logger.warn("[usage-status-bar] 读取会话用量失败", {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          })
      : Promise.resolve(null);

    const todayPromise = usageStatsService
      .getAppUsageSnapshot({ range: "today", timeZone })
      .then((snapshot) => snapshot.summary.totalTokens)
      .catch((error) => {
        logger.warn("[usage-status-bar] 读取今日用量失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });

    const [taskUsage, todayTotalTokens] = await Promise.all([sessionPromise, todayPromise]);
    if (requestSeqRef.current !== requestSeq) {
      return;
    }
    setModel(buildUsageStatusBarModel({ taskUsage, todayTotalTokens }));
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

  if (!hasUsageStatusBarContent(model)) {
    return null;
  }

  return (
    <div
      data-testid={TID_V4_USAGE_STATS}
      className="flex shrink-0 items-center gap-2.5 text-ui-xs text-foreground-subtle"
    >
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
    </div>
  );
}
