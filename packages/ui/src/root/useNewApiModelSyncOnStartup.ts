/**
 * 冷启动时同步 NewAPI Provider 的模型列表。
 *
 * 契约见 docs/newapi-provider-provisioning.md「冷启动模型同步」：
 * - 触发 = renderer 进程启动（Root 挂载）。最小化 / 托盘恢复不会重挂 Root，
 *   因此天然满足「完全退出后再打开」的用户语义；模块级标记保证同一 renderer
 *   （含 StrictMode 双挂载 / HMR）只执行一次。
 * - 无 NewAPI 连接时零请求；同步无差异时零提示；失败只记 warn 日志不打扰用户。
 * - 有差异时用 Toast 告知新增 / 移除数量，用户无需打开设置页就能感知列表已对齐。
 */
import { useEffect } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { loadNewApiConnection } from "@/lib/newApiConnection.js";
import { pickNewApiModelSyncToastMessageId } from "@/lib/newApiModelSyncToast.js";
import { logger } from "@/logger.js";

let modelSyncStartedInRenderer = false;

export function useNewApiModelSyncOnStartup(services: IServiceAccessor): void {
  const { intl } = useZCodeIntl();
  useEffect(() => {
    if (modelSyncStartedInRenderer) {
      return;
    }
    modelSyncStartedInRenderer = true;
    void (async () => {
      const connection = await loadNewApiConnection(services.credentialService);
      if (!connection) {
        return;
      }
      const result = await services.providerSettingsService.syncNewApiModels({
        providerId: connection.providerId,
      });
      const messageId = pickNewApiModelSyncToastMessageId(
        result.addedModelIds.length,
        result.removedModelIds.length,
      );
      if (!messageId) {
        return;
      }
      const values: Record<string, number> =
        messageId === "newapi.modelSync.toast.addedAndRemoved"
          ? { added: result.addedModelIds.length, removed: result.removedModelIds.length }
          : { count: Math.max(result.addedModelIds.length, result.removedModelIds.length) };
      toast(intl.formatMessage({ id: messageId }, values), { variant: "update" });
    })().catch((error: unknown) => {
      // 冷启动同步是 best-effort：网络失败 / 服务端目录为空（no-chat-models）/
      // Provider 已被删除都不该打扰用户，留给下一次启动重试。
      logger.warn("[Root] NewAPI 模型列表冷启动同步失败", { error });
    });
    // intl 只是闭包读取；once 标记已保证本 effect 的副作用只发生一次，
    // 语言切换触发的重跑不会重复同步。
  }, [intl, services]);
}
