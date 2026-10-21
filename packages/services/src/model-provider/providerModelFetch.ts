import { filterNewApiChatModels } from "./newApiModelFilter.js";
import { diffNewApiModelIds } from "./newApiModelSync.js";
import {
  listModelIds,
  NewApiProvisioningError,
  normalizeNewApiApiRoot,
  readModelEndpointTypes,
} from "./newApiProvisioning.js";
import type { NewApiHttpNetwork } from "./newApiHttp.js";

/**
 * 个人 Provider 的「自动获取模型」：用 Provider 自身保存的 baseUrl + API Key 调
 * OpenAI 兼容的 `GET /v1/models`，把本地模型列表一次性收敛到服务端目录。
 *
 * 与 NewAPI 登录/冷启动同步（newApiProvisioning / newApiModelSync）共用两条规则：
 * - **只导入会话模型**（2026-10-21 用户反馈补齐）：走同一个 `filterNewApiChatModels`
 *   ——`/api/pricing` 的端点类型是权威信号，best-effort 读取（非 NewAPI 部署没有
 *   该接口，读不到时退回按模型名兜底判定 embedding/rerank/图像/音频/视频家族），
 *   被过滤的模型不进列表、不计入收敛基准；
 * - 复用 newApiHttp 的请求层（信封解包兼容裸 OpenAI 响应、30s 超时、代理/CA 走
 *   Host 注入的 fetch），错误归一为带稳定 code 的 NewApiProvisioningError。
 *
 * 收敛语义与冷启动同步一致：用户已保存的相对顺序保留，新增按服务端顺序追加，
 * 服务端目录里消失的 id 一并移除；新增与移除在 replacePersonalModelIds 的
 * **单事务**内完成，设置页只收到一次变更回流，不再逐条刷新。服务端无会话模型
 * （空列表或全被过滤）视为异常（no-chat-models），不得清空本地列表。
 */

export interface ProviderModelFetchInput {
  readonly providerId: string;
}

export interface ProviderModelFetchResult {
  /** 服务端返回的会话模型 id（去重、保序；不含被过滤的非会话模型）。 */
  readonly modelIds: readonly string[];
  /** 本次新增的模型 id（按服务端顺序）。 */
  readonly addedModelIds: readonly string[];
  /** 服务端已不存在而移除的模型 id（按本地顺序）。 */
  readonly removedModelIds: readonly string[];
  /** 被会话模型规则排除的 id（embedding/rerank/图像/音频/视频等），仅供观测。 */
  readonly filteredModelIds: readonly string[];
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
  // 端点类型表与模型列表互不依赖，并发取；类型表 best-effort（非 NewAPI 部署 404 → 空表按名字判定）。
  const [endpointTypesByModel, allModelIds] = await Promise.all([
    readModelEndpointTypes(network, apiRoot),
    listModelIds(network, apiRoot, provider.apiKey),
  ]);
  const { chatModelIds, filteredModelIds } = filterNewApiChatModels(
    allModelIds,
    endpointTypesByModel,
  );
  if (chatModelIds.length === 0) {
    throw new NewApiProvisioningError(
      "no-chat-models",
      filteredModelIds.length > 0
        ? `The endpoint returned no chat models (${filteredModelIds.length} non-chat models filtered).`
        : "The endpoint returned an empty model list.",
    );
  }
  const { addedModelIds, removedModelIds } = diffNewApiModelIds(
    provider.personalModelIds,
    chatModelIds,
  );
  if (addedModelIds.length > 0 || removedModelIds.length > 0) {
    // 收敛后的名单：保留成员维持本地顺序，新增按服务端顺序追加（与冷启动同步一致）。
    const chatModelSet = new Set(chatModelIds);
    await host.replacePersonalModelIds(input.providerId, [
      ...provider.personalModelIds.filter((id) => chatModelSet.has(id)),
      ...addedModelIds,
    ]);
  }
  return { modelIds: chatModelIds, addedModelIds, removedModelIds, filteredModelIds };
}
