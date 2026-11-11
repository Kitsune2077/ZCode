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
 * 状态条与回复尾行共用同一份查询；查询失败只 warn 并返回 null，展示层如实降级，
 * 不阻塞输入区。
 */
export function useUsageDetail({
  sessionId,
  workspacePath,
  workspaceIdentity,
  pollIntervalMs = 0,
  refreshKey,
}: UseUsageDetailOptions): V4ConversationUsageDetailResult | null {
  const { zcodeTaskService } = useServices();
  const [detail, setDetail] = useState<V4ConversationUsageDetailResult | null>(null);
  const requestSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;

    const next: V4ConversationUsageDetailResult | null = sessionId
      ? await zcodeTaskService
          .getTaskTokenUsageDetail({ taskId: sessionId, workspacePath, workspaceIdentity })
          .catch((error) => {
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
    setDetail(next);
  }, [sessionId, workspaceIdentity, workspacePath, zcodeTaskService]);

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

  return detail;
}
