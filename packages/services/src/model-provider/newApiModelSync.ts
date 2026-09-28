import { filterNewApiChatModels } from "./newApiModelFilter.js";
import type { NewApiHttpNetwork } from "./newApiHttp.js";
import {
  listModelIds,
  NewApiProvisioningError,
  normalizeNewApiApiRoot,
  readModelEndpointTypes,
} from "./newApiProvisioning.js";

/**
 * NewAPI Provider 的冷启动模型同步。
 *
 * 契约与设计见 docs/newapi-provider-provisioning.md「冷启动模型同步」。要点：
 * - 数据源与登录同源：Provider 自身 `personalConfig` 里的 baseUrl + `sk-` Key，
 *   不使用凭据里的访问令牌（同步不需要 token 管理权限）；
 * - 比对基准是 `personalModelIds`（登录时导入的集合），不是 resolved 视图；
 * - 成员只能由领域操作更新（`withModelMembershipFrom` 不拥有成员变更），
 *   因此先 delete 后 add，保留用户已有排序、按服务端顺序追加新模型；
 * - 服务端目录为空或全被过滤时抛 `no-chat-models`：这更像异常信号（网络劫持 /
 *   部署故障），绝不能用空列表清掉用户已有模型；
 * - Provider 已被用户删除时 no-op：连接凭据与 Provider 生命周期本就解耦
 *   （断开连接不删 Provider），冷启动发现两者不一致时以"无事发生"收场。
 */

export interface NewApiModelSyncInput {
  readonly providerId: string;
}

export interface NewApiModelSyncResult {
  /** 本次是否真正改写了模型成员；false 时零写入。 */
  readonly changed: boolean;
  readonly addedModelIds: readonly string[];
  readonly removedModelIds: readonly string[];
  /** 同步后的全量模型 id（changed=false 时为当前值）。 */
  readonly modelIds: readonly string[];
}

export interface NewApiPersonalProviderSnapshot {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly personalModelIds: readonly string[];
}

export interface NewApiModelSyncHost {
  /** 读 Provider 的 Personal 层快照；Provider 不存在或缺少 baseUrl/apiKey 时返回 undefined。 */
  readPersonalProvider(providerId: string): NewApiPersonalProviderSnapshot | undefined;
  addPersonalModel(providerId: string, modelId: string): Promise<void>;
  deletePersonalModel(providerId: string, modelId: string): Promise<void>;
}

/** 计算同步差异：added 按服务端顺序，removed 按本地顺序。 */
export function diffNewApiModelIds(
  currentModelIds: readonly string[],
  serverModelIds: readonly string[],
): { addedModelIds: string[]; removedModelIds: string[] } {
  const currentSet = new Set(currentModelIds);
  const serverSet = new Set(serverModelIds);
  return {
    addedModelIds: serverModelIds.filter((id) => !currentSet.has(id)),
    removedModelIds: currentModelIds.filter((id) => !serverSet.has(id)),
  };
}

export async function syncNewApiProviderModels(
  host: NewApiModelSyncHost,
  network: NewApiHttpNetwork,
  input: NewApiModelSyncInput,
): Promise<NewApiModelSyncResult> {
  const provider = host.readPersonalProvider(input.providerId);
  if (!provider) {
    return { changed: false, addedModelIds: [], removedModelIds: [], modelIds: [] };
  }
  const apiRoot = normalizeNewApiApiRoot(provider.baseUrl);
  const [endpointTypesByModel, allModelIds] = await Promise.all([
    readModelEndpointTypes(network, apiRoot),
    listModelIds(network, apiRoot, provider.apiKey),
  ]);
  const { chatModelIds } = filterNewApiChatModels(allModelIds, endpointTypesByModel);
  if (chatModelIds.length === 0) {
    throw new NewApiProvisioningError(
      "no-chat-models",
      `NewAPI 未返回可对话模型（已排除 ${allModelIds.length - chatModelIds.length} 个非对话模型），已跳过本地模型同步。`,
    );
  }

  const { addedModelIds, removedModelIds } = diffNewApiModelIds(
    provider.personalModelIds,
    chatModelIds,
  );
  if (addedModelIds.length === 0 && removedModelIds.length === 0) {
    return { changed: false, addedModelIds, removedModelIds, modelIds: provider.personalModelIds };
  }

  // 先删后加：删除保持剩余模型相对顺序，新增按服务端顺序追加；
  // 任一步失败即中断抛出，已应用的部分保持一致，下一次冷启动会重新收敛。
  for (const modelId of removedModelIds) {
    await host.deletePersonalModel(input.providerId, modelId);
  }
  for (const modelId of addedModelIds) {
    await host.addPersonalModel(input.providerId, modelId);
  }
  const modelIds = [
    ...provider.personalModelIds.filter((id) => !removedModelIds.includes(id)),
    ...addedModelIds,
  ];
  return { changed: true, addedModelIds, removedModelIds, modelIds };
}
