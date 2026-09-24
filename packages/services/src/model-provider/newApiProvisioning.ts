import type { ProviderConfigObject } from "@zcode/provider";
import { filterNewApiChatModels } from "./newApiModelFilter.js";
import {
  NewApiProvisioningError,
  normalizeNewApiApiRoot,
  requestNewApiJson,
  type NewApiHttpNetwork,
} from "./newApiHttp.js";

/**
 * NewAPI Provider 自动配置。
 *
 * 用户在欢迎页 / 设置页粘贴 NewAPI 访问令牌后，Host 侧用该令牌换取（必要时创建）
 * NewAPI 的 `sk-` API Key，再拉取模型列表，最终复用 ProviderConfigService 落成一个
 * 个人 Provider。持久化的只有 `sk-` Key；访问令牌是否留存由调用方（凭据服务）决定。
 *
 * NewAPI 接口约定参考其 token 管理 API：/api/token、/api/token/{id}/key、/v1/models。
 */

export { NewApiProvisioningError, normalizeNewApiApiRoot };
export type { NewApiProvisioningErrorCode } from "./newApiHttp.js";

export type NewApiApiFormat = "openai-chat-completions" | "anthropic-messages";

export interface ProvisionNewApiProviderInput {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly apiFormat: NewApiApiFormat;
  readonly providerName?: string;
  /**
   * 上一次 NewAPI 登录落下的 Provider id。存在且仍然有效时先删除再创建，
   * 避免每次重新登录都堆出 NewAPI2 / NewAPI3。
   *
   * 该 id 由凭据侧的替换指针给出，**跨「断开连接」保留**，所以换域名（同一台 NewAPI
   * 迁到新域名）或换账号重登也会替换，而不是留下上一个账号的模型列表。
   * 替换判断以这个 id 为准，不能只依赖 endpoint：同一台 NewAPI 换域名后 endpoint 就不同了，
   * 只比 endpoint 会漏掉该删的旧 Provider。endpoint 规则仅作兜底（见下方实现）。
   *
   * 先删后建可以复用同一个 providerId：基础 id（`new-provider`）被删除后重新空闲，
   * 下一次创建会再次拿到它，因此用户已保存的模型选择不会因为 id 变化而失效。
   */
  readonly replaceProviderId?: string;
}

export interface ProvisionNewApiProviderResult {
  readonly providerId: string;
  readonly modelIds: readonly string[];
  readonly baseUrl: string;
}

export type NewApiProvisioningNetwork = NewApiHttpNetwork;

export interface NewApiProvisioningHost {
  createPersonalProvider(input: {
    readonly providerName?: string;
    readonly initialConfig: ProviderConfigObject;
  }): Promise<{ readonly providerId: string }>;
  /** 当前个人 Provider 及其 endpoint；用于收敛同一 NewAPI 服务上的重复 Provider。 */
  listPersonalProviders?(): Promise<
    readonly { readonly providerId: string; readonly baseUrl?: string }[]
  >;
  deletePersonalProvider?(providerId: string): Promise<void>;
}

const DEFAULT_PROVIDER_NAME = "NewAPI";
const ZCODE_API_KEY_NAME = "zcode-api-key";

function ensureSkPrefix(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith("sk-") ? trimmed : `sk-${trimmed}`;
}

interface RemoteTokenSummary {
  id?: number;
  name?: string;
  key?: string;
}

interface RemoteTokenList {
  items?: RemoteTokenSummary[];
}

interface RemoteTokenKey {
  key?: string;
}

async function listTokens(
  network: NewApiHttpNetwork,
  apiRoot: string,
  accessToken: string,
): Promise<RemoteTokenSummary[]> {
  const data = await requestNewApiJson<RemoteTokenList>(network, {
    authorization: `Bearer ${accessToken}`,
    code: "token-list-failed",
    method: "GET",
    url: `${apiRoot}/api/token/?p=0&size=100`,
  });
  return data?.items ?? [];
}

async function createToken(
  network: NewApiHttpNetwork,
  apiRoot: string,
  accessToken: string,
): Promise<void> {
  await requestNewApiJson<unknown>(network, {
    authorization: `Bearer ${accessToken}`,
    body: {
      expired_time: -1,
      name: ZCODE_API_KEY_NAME,
      remain_quota: 0,
      unlimited_quota: true,
    },
    code: "token-create-failed",
    method: "POST",
    url: `${apiRoot}/api/token/`,
  });
}

async function readFullKey(
  network: NewApiHttpNetwork,
  apiRoot: string,
  accessToken: string,
  tokenId: number,
): Promise<string> {
  const data = await requestNewApiJson<RemoteTokenKey>(network, {
    authorization: `Bearer ${accessToken}`,
    code: "token-key-failed",
    method: "POST",
    url: `${apiRoot}/api/token/${tokenId}/key`,
  });
  return ensureSkPrefix(data?.key ?? "");
}

async function resolveNewApiKey(
  network: NewApiHttpNetwork,
  apiRoot: string,
  accessToken: string,
): Promise<string> {
  let tokens = await listTokens(network, apiRoot, accessToken);
  if (tokens.length === 0) {
    await createToken(network, apiRoot, accessToken);
    tokens = await listTokens(network, apiRoot, accessToken);
  }
  const tokenId = tokens[0]?.id;
  if (typeof tokenId !== "number") {
    throw new NewApiProvisioningError(
      "token-key-failed",
      "NewAPI did not return a usable API token.",
    );
  }
  const key = await readFullKey(network, apiRoot, accessToken, tokenId);
  if (!key) {
    throw new NewApiProvisioningError("token-key-failed", "NewAPI returned an empty API key.");
  }
  return key;
}

async function listModelIds(
  network: NewApiHttpNetwork,
  apiRoot: string,
  apiKey: string,
): Promise<string[]> {
  // OpenAI 兼容的 /v1/models 直接返回 `{ object, data: [{ id }] }`，
  // requestNewApiJson 解包 `data` 后即模型数组，不再套一层 NewAPI 业务信封。
  const entries = await requestNewApiJson<Array<{ id?: string }>>(network, {
    authorization: `Bearer ${apiKey}`,
    code: "model-list-failed",
    method: "GET",
    url: `${apiRoot}/v1/models`,
  });
  const ids = (entries ?? [])
    .map((entry) => entry.id?.trim())
    .filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

interface RemotePricingEntry {
  model_name?: string;
  supported_endpoint_types?: unknown;
}

/**
 * 读取 /api/pricing 的端点类型，用于区分对话模型与非对话模型。
 *
 * 该接口在多数部署上是公开的，读不到时返回空表：模型分类会退回按名字判定，
 * 不能因为一个可选元数据源不可用就让整个导入失败。
 */
async function readModelEndpointTypes(
  network: NewApiHttpNetwork,
  apiRoot: string,
): Promise<Map<string, string[]>> {
  const byModel = new Map<string, string[]>();
  try {
    const entries = await requestNewApiJson<RemotePricingEntry[]>(network, {
      code: "model-list-failed",
      method: "GET",
      url: `${apiRoot}/api/pricing`,
    });
    for (const entry of entries ?? []) {
      const name = entry.model_name?.trim();
      const types = Array.isArray(entry.supported_endpoint_types)
        ? entry.supported_endpoint_types.filter((type): type is string => typeof type === "string")
        : [];
      if (name && types.length > 0) {
        byModel.set(name, types);
      }
    }
  } catch {
    // 端点类型只用于提高分类准确度，缺失时仍按模型名过滤。
  }
  return byModel;
}

export interface ResolvedNewApiConnection {
  readonly apiRoot: string;
  readonly apiKey: string;
  /** 仅可对话模型，按 NewAPI 返回顺序。 */
  readonly modelIds: string[];
  /** 被判为非对话模型而排除的 id，供调用方观测/提示。 */
  readonly filteredModelIds: string[];
}

/** 用访问令牌换取 API Key 并拉取"可对话"模型列表；不写任何持久化状态。 */
export async function resolveNewApiConnection(
  network: NewApiHttpNetwork,
  input: Pick<ProvisionNewApiProviderInput, "baseUrl" | "accessToken">,
): Promise<ResolvedNewApiConnection> {
  const accessToken = input.accessToken.trim();
  if (!accessToken) {
    throw new NewApiProvisioningError("invalid-access-token", "NewAPI access token is required.");
  }
  const apiRoot = normalizeNewApiApiRoot(input.baseUrl);
  // 端点类型与 API Key 互不依赖，并发取；类型表是 best-effort。
  const [apiKey, endpointTypesByModel] = await Promise.all([
    resolveNewApiKey(network, apiRoot, accessToken),
    readModelEndpointTypes(network, apiRoot),
  ]);
  const allModelIds = await listModelIds(network, apiRoot, apiKey);
  const { chatModelIds, filteredModelIds } = filterNewApiChatModels(
    allModelIds,
    endpointTypesByModel,
  );
  if (chatModelIds.length === 0) {
    throw new NewApiProvisioningError(
      "no-chat-models",
      `NewAPI 未返回可对话模型（已排除 ${filteredModelIds.length} 个非对话模型）。`,
    );
  }
  return { apiKey, apiRoot, filteredModelIds, modelIds: chatModelIds };
}

/** 完整流程：换取 Key + 拉模型 + 落成个人 Provider（必要时替换上次的 NewAPI Provider）。 */
export async function provisionNewApiProvider(
  host: NewApiProvisioningHost,
  network: NewApiHttpNetwork,
  input: ProvisionNewApiProviderInput,
): Promise<ProvisionNewApiProviderResult> {
  const connection = await resolveNewApiConnection(network, input);
  const baseUrl = `${connection.apiRoot}/v1`;
  let providerId: string;
  try {
    await removePreviousNewApiProvider(host, input.replaceProviderId, baseUrl);
    const created = await host.createPersonalProvider({
      providerName: input.providerName?.trim() || DEFAULT_PROVIDER_NAME,
      initialConfig: {
        access: { apiKey: connection.apiKey, type: "api-key" },
        api: { baseUrl, type: input.apiFormat },
        modelOrder: connection.modelIds,
        personalModelIds: connection.modelIds,
      },
    });
    providerId = created.providerId;
  } catch (error) {
    throw new NewApiProvisioningError(
      "provider-create-failed",
      "Failed to save the NewAPI provider.",
      { cause: error },
    );
  }
  return { baseUrl, modelIds: connection.modelIds, providerId };
}

/**
 * 删除该 NewAPI 服务上遗留的 Provider。
 *
 * 命中两类目标：
 *   1. 凭据里记录的上一次 Provider id（**主路径**，跨「断开连接」保留，与域名无关）；
 *   2. endpoint 与本服务相同的个人 Provider（兜底：凭据被清掉而 Provider 配置仍在时，
 *      历史版本每次登录都新建，只按记录 id 删除会留下 `NewAPI` / `NewAPI2`）。
 *
 * 按 endpoint 精确匹配（只归一化尾部斜杠），因此另一台自建 NewAPI 不受影响。
 * 凭据指针只由本流程写入，用户手工删除后自动跳过；Host 未提供删除能力时退回只创建。
 */
async function removePreviousNewApiProvider(
  host: NewApiProvisioningHost,
  replaceProviderId: string | undefined,
  targetBaseUrl: string,
): Promise<void> {
  if (!host.deletePersonalProvider || !host.listPersonalProviders) {
    return;
  }
  const existing = await host.listPersonalProviders();
  const recorded = replaceProviderId?.trim();
  const normalizedTarget = normalizeEndpoint(targetBaseUrl);
  const targets = existing.filter(
    (provider) =>
      provider.providerId === recorded ||
      (provider.baseUrl !== undefined && normalizeEndpoint(provider.baseUrl) === normalizedTarget),
  );
  for (const provider of targets) {
    await host.deletePersonalProvider(provider.providerId);
  }
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}
