import assert from "node:assert/strict";
import test from "node:test";
import {
  clearNewApiConnection,
  loadNewApiConnection,
  loadNewApiReplaceProviderId,
  NEW_API_ACTIVE_PROVIDER_KEY,
  NEW_API_LAST_PROVIDER_KEY,
  newApiAccessTokenCredentialKey,
  newApiBaseUrlCredentialKey,
  newApiRefreshCookieCredentialKey,
  resolveStableNewApiConnection,
  saveNewApiConnection,
  saveNewApiRefreshCookie,
} from "../src/lib/newApiConnection.js";

/** 内存凭据仓库：ICredentialService 只要求 load / save / delete。 */
function createCredentialStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async load(key: string): Promise<string | null> {
      return values.get(key) ?? null;
    },
    async save(key: string, value: string): Promise<void> {
      values.set(key, value);
    },
    async delete(key: string): Promise<void> {
      values.delete(key);
    },
  };
}

test("saving a connection records both the active pointer and the replace target", async () => {
  const store = createCredentialStore();

  await saveNewApiConnection(store, {
    accessToken: "access-token",
    baseUrl: "https://newapi.example.com/v1",
    providerId: "new-provider",
  });

  assert.equal(store.values.get(NEW_API_ACTIVE_PROVIDER_KEY), "new-provider");
  assert.equal(store.values.get(NEW_API_LAST_PROVIDER_KEY), "new-provider");
  assert.equal(await loadNewApiReplaceProviderId(store), "new-provider");
});

test("disconnecting keeps the replace target so the next login still replaces the provider", async () => {
  const store = createCredentialStore();
  await saveNewApiConnection(store, {
    accessToken: "access-token",
    baseUrl: "https://old.example.com/v1",
    providerId: "new-provider",
  });
  await saveNewApiRefreshCookie(store, {
    providerId: "new-provider",
    refreshCookie: "refresh-cookie",
  });

  await clearNewApiConnection(store, "new-provider");

  // 凭据与活动指针必须清干净：断开后左下角与用量页要回到未连接状态。
  assert.equal(await loadNewApiConnection(store), null);
  assert.equal(await store.load(NEW_API_ACTIVE_PROVIDER_KEY), null);
  assert.equal(await store.load(newApiBaseUrlCredentialKey("new-provider")), null);
  assert.equal(await store.load(newApiAccessTokenCredentialKey("new-provider")), null);
  assert.equal(await store.load(newApiRefreshCookieCredentialKey("new-provider")), null);

  // 回归点：替换目标必须跨断开保留。此前它随活动指针一起删除，导致断开后换域名
  // （同一台 NewAPI 迁到新域名）或换账号重登时找不到该替换的旧 Provider，
  // 于是旧账号的模型继续留在模型列表里，新连接被挤成 NewAPI 2。
  assert.equal(store.values.get(NEW_API_LAST_PROVIDER_KEY), "new-provider");
  assert.equal(await loadNewApiReplaceProviderId(store), "new-provider");
});

test("the active pointer wins over the recorded replace target", async () => {
  const store = createCredentialStore({
    [NEW_API_ACTIVE_PROVIDER_KEY]: "new-provider-2",
    [NEW_API_LAST_PROVIDER_KEY]: "new-provider",
  });

  assert.equal(await loadNewApiReplaceProviderId(store), "new-provider-2");
});

test("re-login after a disconnect replaces the recorded provider and moves the target", async () => {
  const store = createCredentialStore();
  await saveNewApiConnection(store, {
    accessToken: "access-token",
    baseUrl: "https://old.example.com/v1",
    providerId: "new-provider",
  });
  await clearNewApiConnection(store, "new-provider");

  // 断开状态下重登（此处直接换了域名/账号）：替换目标仍是上一次落下的 Provider。
  assert.equal(await loadNewApiReplaceProviderId(store), "new-provider");

  await saveNewApiConnection(store, {
    accessToken: "access-token",
    baseUrl: "https://moved.example.com/v1",
    providerId: "new-provider-2",
  });

  // 落库后替换目标前移，下一次登录替换的是这个新 Provider。
  assert.equal(await loadNewApiReplaceProviderId(store), "new-provider-2");
});

test("without any record there is nothing to replace", async () => {
  const store = createCredentialStore();

  assert.equal(await loadNewApiReplaceProviderId(store), null);
});

test("re-reading unchanged credentials reuses the previous connection reference", async () => {
  const store = createCredentialStore();
  await saveNewApiConnection(store, {
    accessToken: "access-token",
    baseUrl: "http://203.0.113.10:3000",
    providerId: "new-provider",
  });

  // 回归点：useNewApiAccount 的账号读取 effect 以 connection 对象为依赖，而令牌续期成功后
  // 会 refreshConnection() 重读凭据。若这里返回新对象，effect 就会重跑并与续期形成闭环，
  // 表现为左下角用户名与「NewAPI」来回闪烁、用量页读取失败（与地址是 IPv4 还是域名无关）。
  const first = await loadNewApiConnection(store);
  const second = await loadNewApiConnection(store);

  assert.notEqual(first, second, "加载器本身仍会新建对象，稳定性必须由收敛函数保证");
  assert.equal(resolveStableNewApiConnection(first, second), first);
  assert.deepEqual(resolveStableNewApiConnection(first, second), first);
});

test("connection reference changes when the refreshed token changes", async () => {
  const store = createCredentialStore();
  await saveNewApiConnection(store, {
    accessToken: "stale-token",
    baseUrl: "https://newapi.example.com",
    providerId: "new-provider",
  });
  const before = await loadNewApiConnection(store);

  // 令牌续期：同一 provider、同一地址，但令牌已轮换，消费者必须读到新值。
  await saveNewApiConnection(store, {
    accessToken: "fresh-token",
    baseUrl: "https://newapi.example.com",
    providerId: "new-provider",
  });
  const after = await loadNewApiConnection(store);

  const resolved = resolveStableNewApiConnection(before, after);
  assert.equal(resolved, after);
  assert.equal(resolved?.accessToken, "fresh-token");
});

test("connection reference changes when the base url moves", async () => {
  const store = createCredentialStore();
  await saveNewApiConnection(store, {
    accessToken: "access-token",
    baseUrl: "http://203.0.113.10:3000",
    providerId: "new-provider",
  });
  const before = await loadNewApiConnection(store);

  await saveNewApiConnection(store, {
    accessToken: "access-token",
    baseUrl: "https://moved.example.com",
    providerId: "new-provider",
  });
  const after = await loadNewApiConnection(store);

  assert.equal(resolveStableNewApiConnection(before, after), after);
});

test("disconnect and first connect are never suppressed by the stable reference", async () => {
  const store = createCredentialStore();
  await saveNewApiConnection(store, {
    accessToken: "access-token",
    baseUrl: "https://newapi.example.com",
    providerId: "new-provider",
  });

  const connected = await loadNewApiConnection(store);
  assert.equal(resolveStableNewApiConnection(null, connected), connected);

  await clearNewApiConnection(store, "new-provider");
  const disconnected = await loadNewApiConnection(store);
  assert.equal(resolveStableNewApiConnection(connected, disconnected), null);
  assert.equal(resolveStableNewApiConnection(null, null), null);
});
