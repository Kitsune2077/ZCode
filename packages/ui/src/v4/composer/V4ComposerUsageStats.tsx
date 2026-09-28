import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TID_V4_USAGE_STATS } from "@zcode/shared";
import type { V4ConversationUsageDetailResult } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  buildUsageStatusBarModel,
  formatDurationMs,
  formatFullTokenCount,
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
  /** 草稿态为 null：无会话即无请求记录，速率项自然隐藏。 */
  sessionId: string | null;
}

/**
 * Composer 生成速率指标：最近完成请求的 tokens/s。
 *
 * 用量类累计（会话/今日/轮次/工具/子代理）刻意不在这里展示——左侧用量圆环
 * （ChatContextUsage）与设置 → 用量页已承担该职责，状态栏只补圆环没有的“模型此刻多快”。
 * 数据经 zcodeTaskService.getTaskTokenUsageDetail（协议直达 agent SQLite）读取；
 * 产品规则见 packages/ui/docs/usage-status-bar.md。
 */
export function V4ComposerUsageStats({
  workspacePath,
  workspaceIdentity,
  sessionId,
}: V4ComposerUsageStatsProps) {
  const { intl, locale } = useZCodeIntl();
  const { zcodeTaskService } = useServices();
  const [model, setModel] = useState<UsageStatusBarModel>({ generation: null });
  const requestSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;

    const detail: V4ConversationUsageDetailResult | null = sessionId
      ? await zcodeTaskService
          .getTaskTokenUsageDetail({ taskId: sessionId, workspacePath, workspaceIdentity })
          .catch((error) => {
            // 速率是纯增益展示：读不到就隐藏，不打扰输入区（warn 可检索）。
            logger.warn("[usage-status-bar] 读取会话用量明细失败", {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          })
      : null;

    if (requestSeqRef.current !== requestSeq) {
      return;
    }
    setModel(buildUsageStatusBarModel({ detail }));
  }, [sessionId, workspaceIdentity, workspacePath, zcodeTaskService]);

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

  const speedTier = model.generation
    ? resolveGenerationSpeedTier(model.generation.tokensPerSecond)
    : null;

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
    </div>
  );
}
