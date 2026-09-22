import type { ICredentialService } from "@zcode/services";

/**
 * NewAPI 连接的凭据投影。
 *
 * 访问令牌与 API 根地址属于凭据，由凭据服务独占存储；provider 配置里只保留 `sk-` Key。
 * 这里只描述 key 约定与读写，不持有任何内存状态。
 */

export const NEW_API_ACTIVE_PROVIDER_KEY = "newapi:active_provider";

export function newApiBaseUrlCredentialKey(providerId: string): string {
  return `newapi:${providerId}:base_url`;
}

export function newApiAccessTokenCredentialKey(providerId: string): string {
  return `newapi:${providerId}:access_token`;
}

export interface NewApiConnection {
  readonly providerId: string;
  /** NewAPI API 根地址；允许带 `/v1`，读取方会自行归一化。 */
  readonly baseUrl: string;
  readonly accessToken: string;
}

export type NewApiCredentialStore = Pick<ICredentialService, "load" | "save">;

export async function saveNewApiConnection(
  store: NewApiCredentialStore,
  connection: NewApiConnection,
): Promise<void> {
  await store.save(NEW_API_ACTIVE_PROVIDER_KEY, connection.providerId);
  await store.save(newApiBaseUrlCredentialKey(connection.providerId), connection.baseUrl);
  await store.save(newApiAccessTokenCredentialKey(connection.providerId), connection.accessToken);
}

/** 读取当前 NewAPI 连接；指针或任一字段缺失都按「未连接」处理。 */
export async function loadNewApiConnection(
  store: Pick<NewApiCredentialStore, "load">,
): Promise<NewApiConnection | null> {
  const providerId = (await store.load(NEW_API_ACTIVE_PROVIDER_KEY))?.trim();
  if (!providerId) {
    return null;
  }
  const [baseUrl, accessToken] = await Promise.all([
    store.load(newApiBaseUrlCredentialKey(providerId)),
    store.load(newApiAccessTokenCredentialKey(providerId)),
  ]);
  const trimmedBaseUrl = baseUrl?.trim();
  const trimmedAccessToken = accessToken?.trim();
  if (!trimmedBaseUrl || !trimmedAccessToken) {
    return null;
  }
  return { providerId, baseUrl: trimmedBaseUrl, accessToken: trimmedAccessToken };
}
