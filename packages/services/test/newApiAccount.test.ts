import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateNewApiDailyUsage,
  fetchNewApiAccountInfo,
  resolveNewApiRoleLabel,
} from "../src/model-provider/newApiAccount.js";
import { NewApiProvisioningError } from "../src/model-provider/newApiHttp.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function createFetchMock(routes: {
  self?: () => Response;
  status?: () => Response;
  data?: () => Response;
}): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    if (url.includes("/api/user/self")) {
      return (routes.self ?? (() => jsonResponse({ success: true, data: {} })))();
    }
    if (url.includes("/api/status")) {
      return (routes.status ?? (() => jsonResponse({ success: true, data: {} })))();
    }
    if (url.includes("/api/data/self")) {
      return (routes.data ?? (() => jsonResponse({ success: true, data: [] })))();
    }
    return jsonResponse({ success: false, message: "not found" }, 404);
  };
  return { fetch: fetchImpl, urls };
}

const NOW_MS = Date.UTC(2026, 0, 10, 12, 0, 0);

test("resolveNewApiRoleLabel maps new-api role values", () => {
  assert.equal(resolveNewApiRoleLabel(100), "root");
  assert.equal(resolveNewApiRoleLabel(10), "admin");
  assert.equal(resolveNewApiRoleLabel(1), "common-user");
  assert.equal(resolveNewApiRoleLabel(undefined), "unknown");
  assert.equal(resolveNewApiRoleLabel(0), "unknown");
});

test("aggregateNewApiDailyUsage merges per-model rows by day and sorts ascending", () => {
  const day1 = Math.floor(Date.UTC(2026, 0, 8) / 1000);
  const day2 = Math.floor(Date.UTC(2026, 0, 9) / 1000);
  const points = aggregateNewApiDailyUsage([
    { count: 2, created_at: day2, quota: 300, token_used: 30 },
    { count: 1, created_at: day1, quota: 100, token_used: 10 },
    { count: 3, created_at: day2, quota: 50, token_used: 5 },
  ]);

  assert.deepEqual(points, [
    { count: 1, date: "2026-01-08", quota: 100, tokens: 10 },
    { count: 5, date: "2026-01-09", quota: 350, tokens: 35 },
  ]);
});

test("fetchNewApiAccountInfo returns account, currency settings and daily trend", async () => {
  const { fetch } = createFetchMock({
    data: () =>
      jsonResponse({
        success: true,
        data: [
          {
            count: 4,
            created_at: Math.floor(Date.UTC(2026, 0, 9) / 1000),
            quota: 250,
            token_used: 20,
          },
        ],
      }),
    self: () =>
      jsonResponse({
        success: true,
        data: {
          display_name: "Fixture User",
          group: "vip",
          id: 42,
          quota: 5_000_000,
          request_count: 1234,
          role: 10,
          status: 1,
          used_quota: 2_500_000,
          username: "fixture-user",
        },
      }),
    status: () =>
      jsonResponse({
        success: true,
        data: {
          custom_currency_symbol: "¥",
          display_in_currency: true,
          quota_per_unit: 500_000,
          system_name: "Fixture Relay",
        },
      }),
  });

  const info = await fetchNewApiAccountInfo(
    { fetch },
    { accessToken: "token", baseUrl: "https://relay.example.com/v1" },
    NOW_MS,
  );

  assert.equal(info.id, 42);
  assert.equal(info.username, "fixture-user");
  assert.equal(info.displayName, "Fixture User");
  assert.equal(info.role, 10);
  assert.equal(info.roleLabel, "admin");
  assert.equal(info.group, "vip");
  assert.equal(info.status, 1);
  assert.equal(info.quota, 5_000_000);
  assert.equal(info.usedQuota, 2_500_000);
  assert.equal(info.requestCount, 1234);
  assert.equal(info.quotaPerUnit, 500_000);
  assert.equal(info.currencySymbol, "¥");
  assert.equal(info.displayInCurrency, true);
  assert.equal(info.systemName, "Fixture Relay");
  assert.deepEqual(info.daily, [{ count: 4, date: "2026-01-09", quota: 250, tokens: 20 }]);
});

test("fetchNewApiAccountInfo degrades when optional endpoints fail", async () => {
  const { fetch } = createFetchMock({
    data: () => jsonResponse({ message: "not found" }, 404),
    self: () =>
      jsonResponse({
        success: true,
        data: { id: 7, quota: 500_000, request_count: 3, username: "solo" },
      }),
    status: () => jsonResponse({ message: "boom" }, 500),
  });

  const info = await fetchNewApiAccountInfo(
    { fetch },
    { accessToken: "token", baseUrl: "https://relay.example.com" },
    NOW_MS,
  );

  assert.equal(info.username, "solo");
  assert.equal(info.roleLabel, "unknown");
  assert.equal(info.daily.length, 0);
  assert.equal(info.quotaPerUnit, 500_000);
  assert.equal(info.currencySymbol, "$");
  assert.equal(info.displayInCurrency, false);
});

test("fetchNewApiAccountInfo fails when the current user cannot be read", async () => {
  const { fetch } = createFetchMock({
    self: () => jsonResponse({ message: "Unauthorized", success: false }, 401),
  });

  await assert.rejects(
    () =>
      fetchNewApiAccountInfo(
        { fetch },
        { accessToken: "bad", baseUrl: "https://relay.example.com" },
        NOW_MS,
      ),
    (error) => error instanceof NewApiProvisioningError && error.code === "account-info-failed",
  );
});

test("fetchNewApiAccountInfo rejects an empty access token before any request", async () => {
  const { fetch, urls } = createFetchMock({});

  await assert.rejects(
    () =>
      fetchNewApiAccountInfo({ fetch }, { accessToken: "  ", baseUrl: "https://x.example.com" }),
    (error) => error instanceof NewApiProvisioningError && error.code === "invalid-access-token",
  );
  assert.equal(urls.length, 0);
});
