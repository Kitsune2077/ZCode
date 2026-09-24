/**
 * NewAPI 浏览器登录：用会话 cookie 换取访问令牌。
 *
 * 契约与设计见 packages/services/docs/newapi-browser-login.md。要点：
 * - 凭据是 cookie `new_api_refresh`，由 dashboard 登录写入浏览器（TinyAuth / GitHub / 密码… 均可）；
 * - `POST /api/user/auth/refresh` 用它换 `data.access_token`，并**轮换**该 cookie——
 *   旧值随即失效，所以必须把 Set-Cookie 里的新值取回并覆盖存储；
 * - 该端点带 SessionCookieOriginGuard，且服务端会把客户端 IP / User-Agent 纳入校验，
 *   因此请求要带同源 Origin；
 * - 不要改用 `POST /api/user/token`：它是重新生成，会覆盖用户既有 access token
 *   并让其它的客户端立即失效，且需要额外 security proof。
 */

import {
  NewApiProvisioningError,
  normalizeNewApiApiRoot,
  requestNewApiJson,
  type NewApiHttpNetwork,
} from "./newApiHttp.js";

export const NEW_API_REFRESH_COOKIE_NAME = "new_api_refresh";

/** 会话 cookie 名可能随 NewAPI 版本变化，实现里统一从这里取，便于单点调整。 */
export function resolveNewApiRefreshCookieName(): string {
  return NEW_API_REFRESH_COOKIE_NAME;
}

export interface NewApiSessionExchangeInput {
  readonly baseUrl: string;
  readonly refreshCookie: string;
}

export interface NewApiSessionExchangeResult {
  readonly accessToken: string;
  /** access token 的过期时间（Unix 秒）；缺失时调用方按"未知"处理。 */
  readonly accessTokenExpiresAt?: number;
  /** 服务端轮换后的 refresh cookie；有值时调用方必须覆盖旧凭据。 */
  readonly rotatedRefreshCookie?: string;
}

interface RefreshSessionPayload {
  access_token?: unknown;
  access_expires_at?: unknown;
}

/** 从 Set-Cookie 中取出指定 cookie 的值；同名多条时取最后一条（服务端最终写入的）。 */
export function readSetCookieValue(headers: Headers, cookieName: string): string | undefined {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const rawCookies =
    typeof getSetCookie === "function"
      ? getSetCookie.call(headers)
      : [headers.get("set-cookie")].filter((value): value is string => Boolean(value));

  let found: string | undefined;
  for (const rawCookie of rawCookies) {
    // 只取首个 `name=value` 段，忽略 Path/HttpOnly/SameSite 等属性。
    const firstSegment = rawCookie.split(";")[0] ?? "";
    const separatorIndex = firstSegment.indexOf("=");
    if (separatorIndex <= 0) continue;
    if (firstSegment.slice(0, separatorIndex).trim() !== cookieName) continue;
    found = firstSegment.slice(separatorIndex + 1).trim();
  }
  return found;
}

export async function exchangeNewApiSessionForAccessToken(
  network: NewApiHttpNetwork,
  input: NewApiSessionExchangeInput,
): Promise<NewApiSessionExchangeResult> {
  const apiRoot = normalizeNewApiApiRoot(input.baseUrl);
  const refreshCookie = input.refreshCookie.trim();
  if (!refreshCookie) {
    throw new NewApiProvisioningError("session-exchange-failed", "NewAPI session cookie is empty.");
  }

  const url = `${apiRoot}/api/user/auth/refresh`;
  let rotatedRefreshCookie: string | undefined;
  const payload = await requestNewApiJson<RefreshSessionPayload>(network, {
    captureResponseHeaders: (headers) => {
      rotatedRefreshCookie = readSetCookieValue(headers, NEW_API_REFRESH_COOKIE_NAME);
    },
    code: "session-exchange-failed",
    extraHeaders: {
      Cookie: `${NEW_API_REFRESH_COOKIE_NAME}=${refreshCookie}`,
      // 服务端按来源校验会话 cookie，缺 Origin 会被拒。
      Origin: new URL(apiRoot).origin,
    },
    method: "POST",
    url,
  }).catch((error: unknown) => {
    // 401 在真实部署里既可能是 cookie 过期，也可能是 IP/UA 绑定不匹配（例如浏览器走代理、
    // ZCode 直连）。这里把它翻译成可操作的提示，而不是笼统的"登录失败"。
    if (error instanceof NewApiProvisioningError && error.message.includes("HTTP 401")) {
      throw new NewApiProvisioningError(
        "session-exchange-failed",
        "NewAPI rejected the session cookie: it may have expired, or the deployment binds " +
          "sessions to the client IP/User-Agent. Sign in again from the same network environment.",
        { cause: error },
      );
    }
    throw error;
  });

  const accessToken = typeof payload?.access_token === "string" ? payload.access_token.trim() : "";
  if (!accessToken) {
    throw new NewApiProvisioningError(
      "session-exchange-failed",
      "NewAPI session response did not contain an access token.",
    );
  }
  const expiresAt =
    typeof payload?.access_expires_at === "number" && payload.access_expires_at > 0
      ? payload.access_expires_at
      : undefined;

  return {
    accessToken,
    ...(expiresAt ? { accessTokenExpiresAt: expiresAt } : {}),
    ...(rotatedRefreshCookie ? { rotatedRefreshCookie } : {}),
  };
}
