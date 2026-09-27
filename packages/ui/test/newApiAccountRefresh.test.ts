import assert from "node:assert/strict";
import test from "node:test";
import type { NewApiAccountInfo } from "@zcode/services";
import { fetchNewApiAccountWithAutoRefresh } from "../src/lib/newApiAccountRefresh.js";

function accountInfo(username = "tester"): NewApiAccountInfo {
  return {
    username,
    quota: 100,
    usedQuota: 10,
    requestCount: 5,
    role: 1,
    roleLabel: "user",
    quotaPerUnit: 500_000,
    displayInCurrency: true,
    currencySymbol: "$",
    daily: [],
  };
}

function harness(overrides: {
  fetchAccount?: (accessToken: string) => Promise<NewApiAccountInfo>;
  refreshCookie?: string | null;
  exchange?: (refreshCookie: string) => Promise<{ accessToken: string; rotatedRefreshCookie?: string }>;
}) {
  const calls: { fetchTokens: string[]; exchangedCookies: string[]; persisted: Array<{ accessToken: string; refreshCookie: string }> } = {
    fetchTokens: [],
    exchangedCookies: [],
    persisted: [],
  };
  return {
    calls,
    run: () =>
      fetchNewApiAccountWithAutoRefresh({
        initialAccessToken: "stale-token",
        fetchAccount: overrides.fetchAccount
          ? overrides.fetchAccount
          : async (accessToken) => {
              calls.fetchTokens.push(accessToken);
              return accountInfo();
            },
        loadRefreshCookie: async () => overrides.refreshCookie ?? null,
        exchangeSession: overrides.exchange
          ? overrides.exchange
          : async (refreshCookie) => {
              calls.exchangedCookies.push(refreshCookie);
              return { accessToken: "fresh-token", rotatedRefreshCookie: "rotated-cookie" };
            },
        persistRefreshedCredentials: async (input) => {
          calls.persisted.push(input);
        },
      }),
  };
}

test("valid token reads directly without touching the refresh cookie", async () => {
  const h = harness({});
  const info = await h.run();
  assert.equal(info.username, "tester");
  assert.deepEqual(h.calls.fetchTokens, ["stale-token"]);
  assert.equal(h.calls.exchangedCookies.length, 0);
  assert.equal(h.calls.persisted.length, 0);
});

test("expired token refreshes once, persists rotated credentials, then retries with the new token", async () => {
  const h = harness({
    fetchAccount: async (accessToken) => {
      h.calls.fetchTokens.push(accessToken);
      if (accessToken === "stale-token") {
        throw new Error("401 unauthorized");
      }
      return accountInfo("refreshed-user");
    },
    refreshCookie: "cookie-v1",
  });
  const info = await h.run();
  assert.equal(info.username, "refreshed-user");
  assert.deepEqual(h.calls.fetchTokens, ["stale-token", "fresh-token"]);
  assert.deepEqual(h.calls.exchangedCookies, ["cookie-v1"]);
  // 服务端轮换后的 cookie 必须连同新令牌一起落库；旧 cookie 已失效。
  assert.deepEqual(h.calls.persisted, [{ accessToken: "fresh-token", refreshCookie: "rotated-cookie" }]);
});

test("missing refresh cookie surfaces the original account-read error", async () => {
  const h = harness({
    fetchAccount: async () => {
      throw new Error("401 unauthorized");
    },
    refreshCookie: null,
  });
  await assert.rejects(h.run(), /401 unauthorized/);
  assert.equal(h.calls.exchangedCookies.length, 0);
});

test("dead refresh cookie also surfaces the original error, not the exchange failure", async () => {
  const h = harness({
    fetchAccount: async () => {
      throw new Error("401 unauthorized");
    },
    refreshCookie: "expired-cookie",
    exchange: async () => {
      throw new Error("AUTH_UNAUTHORIZED from refresh");
    },
  });
  await assert.rejects(h.run(), /401 unauthorized/);
});

test("a failed retry after a successful refresh reports the retry error", async () => {
  const h = harness({
    fetchAccount: async () => {
      throw new Error("500 server error");
    },
    refreshCookie: "cookie-v1",
  });
  // 续期成功但重读仍失败：此时凭据已更新，报重读错误才不误导（不是旧令牌过期）。
  await assert.rejects(h.run(), /500 server error/);
  assert.deepEqual(h.calls.persisted, [{ accessToken: "fresh-token", refreshCookie: "rotated-cookie" }]);
});
