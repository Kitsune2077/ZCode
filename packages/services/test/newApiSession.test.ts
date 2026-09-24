import assert from "node:assert/strict";
import test from "node:test";
import { NewApiProvisioningError } from "../src/model-provider/newApiHttp.js";
import {
  NEW_API_REFRESH_COOKIE_NAME,
  exchangeNewApiSessionForAccessToken,
  readSetCookieValue,
} from "../src/model-provider/newApiSession.js";

interface RecordedRequest {
  readonly cookie: string | undefined;
  readonly method: string;
  readonly origin: string | undefined;
  readonly url: string;
}

function createFetchMock(respond: () => Response): {
  fetch: typeof globalThis.fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    requests.push({
      cookie: headers.get("cookie") ?? undefined,
      method: init?.method ?? "GET",
      origin: headers.get("origin") ?? undefined,
      url,
    });
    return respond();
  };
  return { fetch: fetchImpl, requests };
}

test("exchanges the session cookie for an access token", async () => {
  const { fetch, requests } = createFetchMock(
    () =>
      new Response(
        JSON.stringify({
          data: { access_expires_at: 1_800_000_000, access_token: "session-token" },
          success: true,
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 },
      ),
  );

  const result = await exchangeNewApiSessionForAccessToken(
    { fetch },
    { baseUrl: "https://newapi.example.com/v1", refreshCookie: "cookie-value" },
  );

  assert.equal(result.accessToken, "session-token");
  assert.equal(result.accessTokenExpiresAt, 1_800_000_000);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://newapi.example.com/api/user/auth/refresh");
  assert.equal(requests[0]?.method, "POST");
  // 会话 cookie 与同源 Origin 缺一不可：端点带 SessionCookieOriginGuard。
  assert.equal(requests[0]?.cookie, `${NEW_API_REFRESH_COOKIE_NAME}=cookie-value`);
  assert.equal(requests[0]?.origin, "https://newapi.example.com");
});

test("captures the rotated refresh cookie because the old value is invalidated", async () => {
  const { fetch } = createFetchMock(
    () =>
      new Response(JSON.stringify({ data: { access_token: "session-token" }, success: true }), {
        headers: {
          "Content-Type": "application/json",
          "set-cookie": `${NEW_API_REFRESH_COOKIE_NAME}=rotated; Path=/; HttpOnly; SameSite=Lax`,
        },
        status: 200,
      }),
  );

  const result = await exchangeNewApiSessionForAccessToken(
    { fetch },
    { baseUrl: "https://newapi.example.com", refreshCookie: "cookie-value" },
  );

  assert.equal(result.rotatedRefreshCookie, "rotated");
});

test("translates a 401 into an actionable message about session binding", async () => {
  const { fetch } = createFetchMock(
    () =>
      new Response(JSON.stringify({ code: "AUTH_UNAUTHORIZED", success: false }), {
        headers: { "Content-Type": "application/json" },
        status: 401,
      }),
  );

  await assert.rejects(
    () =>
      exchangeNewApiSessionForAccessToken(
        { fetch },
        { baseUrl: "https://newapi.example.com", refreshCookie: "stale" },
      ),
    (error) => {
      assert.ok(error instanceof NewApiProvisioningError);
      assert.equal(error.code, "session-exchange-failed");
      // 过期与 IP/UA 绑定不匹配是两种不同的用户动作，提示必须提到后者。
      assert.match(error.message, /expired/i);
      assert.match(error.message, /IP\/User-Agent/);
      return true;
    },
  );
});

test("rejects an empty cookie and a response without an access token", async () => {
  const { fetch } = createFetchMock(() => new Response("{}", { status: 200 }));

  await assert.rejects(
    () =>
      exchangeNewApiSessionForAccessToken(
        { fetch },
        { baseUrl: "https://newapi.example.com", refreshCookie: "   " },
      ),
    (error) => error instanceof NewApiProvisioningError && error.code === "session-exchange-failed",
  );

  await assert.rejects(
    () =>
      exchangeNewApiSessionForAccessToken(
        { fetch },
        { baseUrl: "https://newapi.example.com", refreshCookie: "cookie-value" },
      ),
    (error) =>
      error instanceof NewApiProvisioningError &&
      error.code === "session-exchange-failed" &&
      /did not contain an access token/.test(error.message),
  );
});

test("readSetCookieValue keeps the last same-name cookie and ignores the others", () => {
  const headers = new Headers({
    "set-cookie": `${NEW_API_REFRESH_COOKIE_NAME}=first; Path=/`,
  });
  headers.append("set-cookie", "new_api_has_session=1; Path=/");
  headers.append("set-cookie", `${NEW_API_REFRESH_COOKIE_NAME}=second; Path=/; HttpOnly`);

  assert.equal(readSetCookieValue(headers, NEW_API_REFRESH_COOKIE_NAME), "second");
  assert.equal(readSetCookieValue(headers, "absent"), undefined);
});

test("readSetCookieValue falls back when getSetCookie is unavailable", () => {
  // 某些 fetch 实现只提供合并后的 set-cookie 头；此时按首个 name=value 段解析。
  const headers = {
    get: (name: string) =>
      name === "set-cookie" ? `${NEW_API_REFRESH_COOKIE_NAME}=single; Path=/; HttpOnly` : null,
  } as unknown as Headers;

  assert.equal(readSetCookieValue(headers, NEW_API_REFRESH_COOKIE_NAME), "single");
});
