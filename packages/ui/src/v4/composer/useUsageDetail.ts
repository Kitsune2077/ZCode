import { useCallback, useEffect, useRef, useState } from "react";
import type { V4ConversationUsageDetailResult } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export interface UseUsageDetailOptions {
  sessionId: string | null | undefined;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 轮询间隔；省略或 0 表示只在挂载与 refreshKey 变化时取一次。 */
  pollIntervalMs?: number;
  /** 变化即重新拉取（回复尾行用 turnId，保证新一轮完成后刷新）。 */
  refreshKey?: string | number;
}

/**
 * 读取 v4/conversation/usageDetail（协议直达 agent SQLite）。
 *
 * 状态条与回复尾行共用同一份查询；查询失败只 warn 并**保留上一次成功值**——
 * 轮询失败的瞬间把指标清空会让状态行闪烁消失（实测 bug），降级语义是冻结而不是清零。
 */
export interface UseUsageDetailResult {
  detail: V4ConversationUsageDetailResult | null;
  /** 立即重取一次（生成结束、权威 usage 刚落库时用，避免等下一个轮询窗口）。 */
  refresh: () => Promise<void>;
}

export function useUsageDetail({
  sessionId,
  workspacePath,
  workspaceIdentity,
  pollIntervalMs = 0,
  refreshKey,
}: UseUsageDetailOptions): UseUsageDetailResult {
  const { zcodeTaskService } = useServices();
  const [detail, setDetail] = useState<V4ConversationUsageDetailResult | null>(null);
  const requestSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;

    // undefined = 查询失败（保留旧值）；null = 权威无数据（草稿态等，正常清空）。
    const next: V4ConversationUsageDetailResult | null | undefined = sessionId
      ? await zcodeTaskService
          .getTaskTokenUsageDetail({ taskId: sessionId, workspacePath, workspaceIdentity })
          .catch((error) => {
            logger.warn("[usage-status-bar] 读取会话用量明细失败", {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
            return undefined;
          })
      : null;

    if (requestSeqRef.current !== requestSeq || next === undefined) {
      return;
    }
    setDetail(next);
  }, [sessionId, workspaceIdentity, workspacePath, zcodeTaskService]);

  useEffect(() => {
    // 会话切换瞬间丢弃旧会话数据：refresh 是异步的，不清的话新数据到达前
    // （以及切到无记录的新任务时）会一直显示上一个任务的指标（实测 bug）。
    // 与“轮询失败保留旧值”不冲突：失败走 undefined 哨兵，不经过这里。
    setDetail(null);
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  useEffect(() => {
    if (!pollIntervalMs || pollIntervalMs <= 0) return;
    const timer = window.setInterval(() => {
      // 不可见时跳过轮询：后台标签页没有常驻指标的受众。
      if (document.visibilityState === "visible") {
        void refresh();
      }
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [pollIntervalMs, refresh]);

  return { detail, refresh };
}
