import assert from "node:assert/strict";
// 官方 v3.15.1 已把单测迁移到 vitest：root vitest 会收集所有 *.test.ts，
// node:test 风格的文件因为没有 vitest 套件而整体报 No test suite found。
import { test } from "vitest";
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
  const result = await h.run();
  assert.equal(result.info.username, "tester");
  // 鍑嵁鏈彉锛氳皟鐢ㄦ柟涓嶅緱鎹閲嶈杩炴帴锛屽惁鍒欎細鎶婁竴娆℃垚鍔熺殑璇诲彇閲嶆柊鎷夎捣銆?
  assert.equal(result.credentialsRenewed, false);
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
  const result = await h.run();
  assert.equal(result.info.username, "refreshed-user");
  // 缁湡纭疄鍙戠敓骞跺凡钀藉簱锛氳皟鐢ㄦ柟闇€瑕侀噸璇讳竴娆¤繛鎺ワ紝璁╁唴瀛樺揩鐓ф崲涓婃柊浠ょ墝銆?
  assert.equal(result.credentialsRenewed, true);
  assert.deepEqual(h.calls.fetchTokens, ["stale-token", "fresh-token"]);
  assert.deepEqual(h.calls.exchangedCookies, ["cookie-v1"]);
  // 鏈嶅姟绔疆鎹㈠悗鐨?cookie 蹇呴』杩炲悓鏂颁护鐗屼竴璧疯惤搴擄紱鏃?cookie 宸插け鏁堛€?
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
  // 缁湡鎴愬姛浣嗛噸璇讳粛澶辫触锛氭鏃跺嚟鎹凡鏇存柊锛屾姤閲嶈閿欒鎵嶄笉璇锛堜笉鏄棫浠ょ墝杩囨湡锛夈€?
  await assert.rejects(h.run(), /500 server error/);
  assert.deepEqual(h.calls.persisted, [{ accessToken: "fresh-token", refreshCookie: "rotated-cookie" }]);
});
