import type { ICredentialService } from "@zcode/services";

/**
 * NewAPI 连接的凭据投影。
 *
 * 访问令牌与 API 根地址属于凭据，由凭据服务独占存储；provider 配置里只保留 `sk-` Key。
 * 这里只描述 key 约定与读写，不持有任何内存状态。
 */

export const NEW_API_ACTIVE_PROVIDER_KEY = "newapi:active_provider";

/**
 * 上一次成功登录落下的 Provider id。与活动指针分开存的原因是生命周期不同：
 *
 * 「断开连接」会删掉活动指针（否则重登前仍算已连接），但 NewAPI 连接的语义是“一次只保留一个”，
 * 下一次登录必须知道该替换哪一个 Provider。若替换目标随指针一起丢失，换域名（同一台 NewAPI
 * 迁到新域名）或换账号重登就会留下来旧的 Provider，把新连接挤成 `NewAPI 2`，旧账号的模型
 * 也会继续挂在模型列表里。所以这条记录跨断开保留。
 */
export const NEW_API_LAST_PROVIDER_KEY = "newapi:last_provider";

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

/**
 * 落库一次成功的 NewAPI 连接。
 *
 * 同时更新活动指针与 `last_provider`：任何一次成功登录都会把自己记为“上一个”，
 * 供下一次登录替换（见 `NEW_API_LAST_PROVIDER_KEY`）。本函数是这两条记录的唯一写入路径。
 */
export async function saveNewApiConnection(
  store: NewApiCredentialStore,
  connection: NewApiConnection,
): Promise<void> {
  await store.save(NEW_API_ACTIVE_PROVIDER_KEY, connection.providerId);
  await store.save(NEW_API_LAST_PROVIDER_KEY, connection.providerId);
  await store.save(newApiBaseUrlCredentialKey(connection.providerId), connection.baseUrl);
  await store.save(newApiAccessTokenCredentialKey(connection.providerId), connection.accessToken);
}

/**
 * 解析本次登录应当替换掉的 Provider id：活动指针优先，其次跨断开保留的 `last_provider`。
 *
 * 返回的 id 只是一个"候选"：它可能已被用户手工删除，或 Host 不支持删除，
 * 下游（`provisionNewApiProvider`）会跳过无效目标。
 */
export async function loadNewApiReplaceProviderId(
  store: Pick<NewApiCredentialStore, "load">,
): Promise<string | null> {
  const active = (await store.load(NEW_API_ACTIVE_PROVIDER_KEY))?.trim();
  if (active) {
    return active;
  }
  const last = (await store.load(NEW_API_LAST_PROVIDER_KEY))?.trim();
  return last ? last : null;
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
 *
 * 注意 `last_provider` **不在这里删除**：它是"下一个该被替换的 Provider"，与"是否已连接"
 * 无关。删掉它会让换域名/换账号重登时无从替换，从而堆出 `NewAPI 2`。
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
