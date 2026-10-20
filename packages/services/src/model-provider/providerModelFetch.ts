import {
  listModelIds,
  NewApiProvisioningError,
  normalizeNewApiApiRoot,
} from "./newApiProvisioning.js";
import type { NewApiHttpNetwork } from "./newApiHttp.js";

/**
 * 个人 Provider 的「自动获取模型」：用 Provider 自身保存的 baseUrl + API Key 调
 * OpenAI 兼容的 `GET /v1/models`，把服务端返回的模型 id **追加**进本地模型列表。
 *
 * 与 NewAPI 登录/冷启动同步（newApiProvisioning / newApiModelSync）的差异：
 * - 面向任意自定义供应商（OpenAI 兼容网关、自建中转等），不做 NewAPI 特有的
 *   `/api/pricing` 端点类型过滤——非 NewAPI 部署没有该接口，通用路径只信 `/v1/models`；
 * - 只增不删：用户已手动整理的列表（排序、禁用、元数据）是本地事实，服务端目录
 *   里消失的 id 不代表用户想移除；冷启动同步的"删除收敛"语义不适用于手动按钮；
 * - 复用 newApiHttp 的请求层（信封解包兼容裸 OpenAI 响应、30s 超时、代理/CA 走
 *   Host 注入的 fetch），错误归一为带稳定 code 的 NewApiProvisioningError。
 */

export interface ProviderModelFetchInput {
  readonly providerId: string;
}

export interface ProviderModelFetchResult {
  /** 服务端返回的全量模型 id（去重、保序）。 */
  readonly modelIds: readonly string[];
  /** 本次实际新增写入的模型 id（已存在的跳过，按服务端顺序）。 */
  readonly addedModelIds: readonly string[];
}

export interface ProviderModelFetchHost {
  /**
   * 读 Provider 的 Personal 层连接快照；Provider 不存在、或尚未保存
   * baseUrl / API Key 时返回 undefined（调用方提示先保存连接信息）。
   */
  readPersonalProvider(
    providerId: string,
  ): { readonly baseUrl: string; readonly apiKey: string; readonly personalModelIds: readonly string[] } | undefined;
  addPersonalModel(providerId: string, modelId: string): Promise<void>;
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
  const existing = new Set(provider.personalModelIds);
  const addedModelIds = modelIds.filter((modelId) => !existing.has(modelId));
  for (const modelId of addedModelIds) {
    await host.addPersonalModel(input.providerId, modelId);
  }
  return { modelIds, addedModelIds };
}
