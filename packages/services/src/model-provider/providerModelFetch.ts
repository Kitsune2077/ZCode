import { diffNewApiModelIds } from "./newApiModelSync.js";
import {
  listModelIds,
  NewApiProvisioningError,
  normalizeNewApiApiRoot,
} from "./newApiProvisioning.js";
import type { NewApiHttpNetwork } from "./newApiHttp.js";

/**
 * 个人 Provider 的「自动获取模型」：用 Provider 自身保存的 baseUrl + API Key 调
 * OpenAI 兼容的 `GET /v1/models`，把本地模型列表一次性收敛到服务端目录。
 *
 * 与 NewAPI 登录/冷启动同步（newApiProvisioning / newApiModelSync）的差异：
 * - 面向任意自定义供应商（OpenAI 兼容网关、自建中转等），不做 NewAPI 特有的
 *   `/api/pricing` 端点类型过滤——非 NewAPI 部署没有该接口，通用路径只信 `/v1/models`；
 * - 复用 newApiHttp 的请求层（信封解包兼容裸 OpenAI 响应、30s 超时、代理/CA 走
 *   Host 注入的 fetch），错误归一为带稳定 code 的 NewApiProvisioningError。
 *
 * 收敛语义与冷启动同步一致（2026-10-21 用户确认）：用户已保存的相对顺序保留，
 * 新增按服务端顺序追加，服务端目录里消失的 id 一并移除；新增与移除在
 * replacePersonalModelIds 的**单事务**内完成，设置页只收到一次变更回流，
 * 不再逐条刷新。服务端返回空列表视为异常（no-chat-models），不得清空本地列表。
 */

export interface ProviderModelFetchInput {
  readonly providerId: string;
}

export interface ProviderModelFetchResult {
  /** 服务端返回的全量模型 id（去重、保序）。 */
  readonly modelIds: readonly string[];
  /** 本次新增的模型 id（按服务端顺序）。 */
  readonly addedModelIds: readonly string[];
  /** 服务端已不存在而移除的模型 id（按本地顺序）。 */
  readonly removedModelIds: readonly string[];
}

export interface ProviderModelFetchHost {
  /**
   * 读 Provider 的 Personal 层连接快照；Provider 不存在、或尚未保存
   * baseUrl / API Key 时返回 undefined（调用方提示先保存连接信息）。
   */
  readPersonalProvider(
    providerId: string,
  ): { readonly baseUrl: string; readonly apiKey: string; readonly personalModelIds: readonly string[] } | undefined;
  /** 单事务收敛 Personal 模型成员（增删同事务）；零差异时调用方不调用。 */
  replacePersonalModelIds(providerId: string, modelIds: readonly string[]): Promise<void>;
}

export async function fetchProviderModelsFromEndpoint(
  host: ProviderModelFetchHost,
  network: NewApiHttpNetwork,
  input: ProviderModelFetchInput,
): Promise<ProviderModelFetchResult> {
  const provider = host.readPersonalProvider(input.providerId);
  if (!provider) {
    throw new NewApiProvisioningError(
      "provider-connection-missing",
      "Provider connection (baseUrl + API key) is not saved yet.",
    );
  }
  // normalizeNewApiApiRoot 兼容用户填写带/不带尾部 /v1 的两种习惯（剥尾部 /v1 后拼 /v1/models）。
  const apiRoot = normalizeNewApiApiRoot(provider.baseUrl);
  const modelIds = await listModelIds(network, apiRoot, provider.apiKey);
  if (modelIds.length === 0) {
    throw new NewApiProvisioningError(
      "no-chat-models",
      "The endpoint returned an empty model list.",
    );
  }
  const { addedModelIds, removedModelIds } = diffNewApiModelIds(
    provider.personalModelIds,
    modelIds,
  );
  if (addedModelIds.length > 0 || removedModelIds.length > 0) {
    // 收敛后的名单：保留成员维持本地顺序，新增按服务端顺序追加（与冷启动同步一致）。
    const serverSet = new Set(modelIds);
    await host.replacePersonalModelIds(input.providerId, [
      ...provider.personalModelIds.filter((id) => serverSet.has(id)),
      ...addedModelIds,
    ]);
  }
  return { modelIds, addedModelIds, removedModelIds };
}
