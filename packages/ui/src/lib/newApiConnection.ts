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

/**
 * 浏览器登录留下的会话 cookie（`new_api_refresh`）。
 *
 * 存下来是为了 access token 过期时能自动续期，而不必再让用户登录一次。
 * 服务端每次刷新都会轮换它（旧值随即失效），因此刷新后必须覆盖写入。
 */
export function newApiRefreshCookieCredentialKey(providerId: string): string {
  return `newapi:${providerId}:refresh_cookie`;
}

export interface NewApiConnection {
  readonly providerId: string;
  /** NewAPI API 根地址；允许带 `/v1`，读取方会自行归一化。 */
  readonly baseUrl: string;
  readonly accessToken: string;
}

export type NewApiCredentialStore = Pick<ICredentialService, "load" | "save">;
export type NewApiCredentialStoreWithDelete = Pick<ICredentialService, "load" | "save" | "delete">;

export async function saveNewApiConnection(
  store: NewApiCredentialStore,
  connection: NewApiConnection,
): Promise<void> {
  await store.save(NEW_API_ACTIVE_PROVIDER_KEY, connection.providerId);
  await store.save(newApiBaseUrlCredentialKey(connection.providerId), connection.baseUrl);
  await store.save(newApiAccessTokenCredentialKey(connection.providerId), connection.accessToken);
}

/** 保存浏览器登录得到的会话 cookie；空值不写入，避免把"没拿到"落成一条空凭据。 */
export async function saveNewApiRefreshCookie(
  store: NewApiCredentialStore,
  input: { readonly providerId: string; readonly refreshCookie: string },
): Promise<void> {
  const trimmed = input.refreshCookie.trim();
  if (!trimmed) {
    return;
  }
  await store.save(newApiRefreshCookieCredentialKey(input.providerId), trimmed);
}

export async function loadNewApiRefreshCookie(
  store: Pick<NewApiCredentialStore, "load">,
  providerId: string,
): Promise<string | null> {
  const value = (await store.load(newApiRefreshCookieCredentialKey(providerId)))?.trim();
  return value ? value : null;
}

/** 读取当前 NewAPI 连接；指针或任一字段缺失都按「未连接」处理。 */ export async function loadNewApiConnection(
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

/**
 * 断开 NewAPI 登录：删除访问令牌、会话 cookie、API 根地址与连接指针。
 *
 * 只清凭据，不删除 Provider —— 与 ZCode 账号退出登录一致：Provider 配置仍由用户拥有，
 * 已导入的模型继续可用（模型请求用的是 Provider 里的 `sk-` Key）。断开后左下角恢复
 * 「未登录」，用量页的 NewAPI 标签页与「使用 NewAPI」入口一并回到未连接状态。
 */
export async function clearNewApiConnection(
  store: NewApiCredentialStoreWithDelete,
  providerId: string,
): Promise<void> {
  const trimmedProviderId = providerId.trim();
  if (trimmedProviderId) {
    await store.delete(newApiBaseUrlCredentialKey(trimmedProviderId));
    await store.delete(newApiAccessTokenCredentialKey(trimmedProviderId));
    // 会话 cookie 同样必须清掉：留着它等于保留一份可续期的登录凭据，
    // 用户点"断开连接"时期望它一并失效。
    await store.delete(newApiRefreshCookieCredentialKey(trimmedProviderId));
  }
  await store.delete(NEW_API_ACTIVE_PROVIDER_KEY);
}
