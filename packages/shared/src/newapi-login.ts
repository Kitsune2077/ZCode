/**
 * NewAPI 浏览器登录的跨端契约。
 *
 * 设计见 packages/services/docs/newapi-browser-login.md。这里的类型只描述
 * 「renderer 请求 main 打开登录窗口并取回会话 cookie」这一件事；cookie 换 access token
 * 的部分在 services 侧（newApiSession.ts）。
 *
 * cookie 名放在 shared 是为了单一所有者：main 侧要知道监听哪个 cookie，services 侧
 * 要知道用哪个名字发 Cookie 头，两边必须一致。
 */

/**
 * NewAPI 的会话 cookie 名。
 *
 * 注意：该名称随 NewAPI 版本可能变化（当前版本为 `new_api_refresh`）。这里集中一处，
 * 便于版本适配时单点调整；两种用途（main 监听、services 发送）都从这里取。
 */
export const NEW_API_REFRESH_COOKIE_NAME = "new_api_refresh";

/**
 * 会话 cookie 的 Path。
 *
 * NewAPI 把它限制在 `/api/user/auth`（见 service/auth_session.go 的 WriteRefreshCookie），
 * 不是 `/`。Electron 的 `session.cookies.get({ url })` 会同时按路径匹配，用根 URL 查询**永远拿不到**
 * 这个 cookie——第一次真机验证就卡在这里：登录成功、窗口停留、却一直读不到。
 */
export const NEW_API_REFRESH_COOKIE_PATH = "/api/user/auth";

/**
 * 读取用户会话 cookie 时应当使用的查询 URL。
 *
 * 用带路径的 URL 而不是根 URL：带路径的查询既能命中 `Path=/api/user/auth` 的 cookie，
 * 也能命中 `Path=/` 的同名 cookie，因此 NewAPI 将来把 Path 改回根路径时无需再改这里。
 */
export function resolveNewApiSessionCookieLookupUrl(origin: string): string {
  return `${origin.replace(/\/+$/u, "")}${NEW_API_REFRESH_COOKIE_PATH}`;
}

export interface NewApiBrowserLoginRequest {
  /** NewAPI 根地址（用户填写，可能带 `/v1` 或尾部斜杠）。 */
  readonly baseUrl: string;
  /**
   * 可选的 OAuth provider 名（如 `tinyauth`）。给定时直接打开 `{baseUrl}/oauth/<provider>`，
   * 省去在 NewAPI 登录页里再选一次；留空则落在 `{baseUrl}/login`，由用户自行选择登录方式。
   */
  readonly provider?: string;
  /** 登录窗口等待会话 cookie 的上限（毫秒）；缺省由 main 侧决定。 */
  readonly timeoutMs?: number;
}

/**
 * 登录窗口的结果。
 *
 * 分成显式状态而不是抛错，是因为「用户主动取消」与「失败」对 UI 的含义完全不同：
 * 前者不该报错，后者要给出可操作的原因。
 */
export type NewApiBrowserLoginResult =
  | { readonly status: "completed"; readonly cookieValue: string; readonly origin: string }
  | { readonly status: "cancelled" }
  | { readonly status: "timeout" }
  | { readonly status: "failed"; readonly code: string; readonly message: string };

export function isNewApiBrowserLoginCompleted(
  result: NewApiBrowserLoginResult,
): result is Extract<NewApiBrowserLoginResult, { status: "completed" }> {
  return result.status === "completed";
}

/** 按 provider 存在与否决定登录窗口的落脚页。 */
export function resolveNewApiLoginUrl(request: NewApiBrowserLoginRequest): string {
  const trimmed = request.baseUrl.trim();
  const provider = request.provider?.trim();
  if (!trimmed) {
    throw new Error("NewAPI base URL is required.");
  }
  // 归一化与 services 的 normalizeNewApiApiRoot 保持一致：去掉尾部斜杠与结尾的 /v1，
  // 但这里不校验协议，交给 main 侧统一用 URL 解析（失败即 failed）。
  const normalized = trimmed.replace(/\/+$/u, "").replace(/\/v1$/u, "");
  return provider ? `${normalized}/oauth/${encodeURIComponent(provider)}` : `${normalized}/login`;
}
