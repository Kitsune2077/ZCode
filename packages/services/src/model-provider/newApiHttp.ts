/**
 * NewAPI 控制台 API 的公共 HTTP 层。
 *
 * NewAPI 的 `/api/*` 统一返回 `{ success, message, data }` 信封；这里只负责发请求、
 * 解包 data、把失败归一成带稳定 code 的错误。调用方（provider 自动配置、账号信息读取）
 * 各自只描述自己的业务字段。
 *
 * 网络请求走注入的 fetch（Host 的 hostApiNetworkTransport），以便统一代理 / CA。
 */

export type NewApiProvisioningErrorCode =
  | "invalid-base-url"
  | "invalid-access-token"
  | "token-list-failed"
  | "token-create-failed"
  | "token-key-failed"
  | "model-list-failed"
  | "no-chat-models"
  | "provider-create-failed"
  | "account-info-failed"
  | "usage-data-failed"
  | "network-error";

export class NewApiProvisioningError extends Error {
  readonly code: NewApiProvisioningErrorCode;

  constructor(
    code: NewApiProvisioningErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "NewApiProvisioningError";
    this.code = code;
  }
}

export interface NewApiHttpNetwork {
  readonly fetch: typeof fetch;
}

export const NEW_API_REQUEST_TIMEOUT_MS = 30_000;
const JSON_CONTENT_TYPE = "application/json";

/** 归一化用户输入的 NewAPI 地址：去掉尾部斜杠与结尾的 `/v1`，得到 API 根。 */
export function normalizeNewApiApiRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new NewApiProvisioningError("invalid-base-url", "NewAPI base URL is required.");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new NewApiProvisioningError("invalid-base-url", `Invalid NewAPI base URL: ${trimmed}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NewApiProvisioningError(
      "invalid-base-url",
      "NewAPI base URL must use http or https.",
    );
  }
  const pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/u, "");
}

/** 提取 fetch 失败的底层原因（如 ENETUNREACH / CERT_HAS_EXPIRED），供 UI 诊断。 */
export function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
    const code = typeof cause?.code === "string" ? cause.code : undefined;
    const causeMessage = typeof cause?.message === "string" ? cause.message : undefined;
    return code ?? causeMessage ?? error.message;
  }
  return String(error);
}

interface RemoteEnvelope<T> {
  success?: boolean;
  message?: string;
  data?: T;
}

export interface NewApiJsonRequestOptions {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly authorization?: string;
  readonly body?: unknown;
  readonly code: NewApiProvisioningErrorCode;
  /** 部分部署的 System Access Token 需要 New-Api-User 头；登录令牌场景可省略。 */
  readonly extraHeaders?: Record<string, string>;
}

/** 发一次 NewAPI 请求并解包 `data`；失败一律抛 NewApiProvisioningError。 */
export async function requestNewApiJson<T>(
  network: NewApiHttpNetwork,
  options: NewApiJsonRequestOptions,
): Promise<T | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NEW_API_REQUEST_TIMEOUT_MS);
  // 逐项装配请求头：显式 Authorization 与调用方附加入口都要支持，
  // 但空值分支不能靠展开空对象表达，否则会引入无意义的 spread。
  const headers: Record<string, string> = { "Content-Type": JSON_CONTENT_TYPE };
  if (options.authorization) {
    headers.Authorization = options.authorization;
  }
  if (options.extraHeaders) {
    Object.assign(headers, options.extraHeaders);
  }
  let response: Response;
  try {
    response = await network.fetch(options.url, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      method: options.method,
      signal: controller.signal,
    });
  } catch (error) {
    throw new NewApiProvisioningError(
      "network-error",
      `Request to ${options.url} failed: ${describeNetworkError(error)}.`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new NewApiProvisioningError(
      options.code,
      `NewAPI request ${options.url} failed with HTTP ${response.status}.`,
    );
  }
  let parsed: RemoteEnvelope<T>;
  try {
    parsed = JSON.parse(text) as RemoteEnvelope<T>;
  } catch (error) {
    throw new NewApiProvisioningError(options.code, "NewAPI returned non-JSON response.", {
      cause: error,
    });
  }
  if (parsed.success === false) {
    throw new NewApiProvisioningError(
      options.code,
      parsed.message?.trim() || "NewAPI rejected the request.",
    );
  }
  return parsed.data;
}
