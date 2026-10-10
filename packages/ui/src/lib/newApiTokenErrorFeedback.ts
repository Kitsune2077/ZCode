/**
 * NewAPI 手动访问令牌（PAT）错误的稳定 code → 可操作文案映射（纯函数）。
 *
 * 背景：new-api v1.0.0-rc.41 起「安全与访问」的访问令牌改为具名 PAT——必须勾选
 * `resource:action` 作用域、默认 30 天过期，旧版令牌升级 30 天后退休。这些失败以
 * 稳定 code 随非 2xx 响应返回（HTTP 层已把它们保留进错误文本），若不在 UI 翻译，
 * 用户只会看到裸状态码，无从知道要去补勾作用域或重新生成令牌。
 *
 * 见 docs/newapi-provider-provisioning.md「访问令牌（PAT）兼容」。
 */
export type NewApiTokenErrorFeedbackMessageId =
  | "login.newApi.tokenError.scopeDenied"
  | "login.newApi.tokenError.expired";

/** 从错误文本中识别 PAT 相关稳定 code；未命中返回 null（调用方按原文展示）。 */
export function resolveNewApiTokenErrorFeedbackMessageId(
  errorText: string | null | undefined,
): NewApiTokenErrorFeedbackMessageId | null {
  const text = errorText ?? "";
  if (
    text.includes("ACCESS_TOKEN_SCOPE_DENIED") ||
    text.includes("ACCESS_TOKEN_ROUTE_UNDECLARED")
  ) {
    return "login.newApi.tokenError.scopeDenied";
  }
  if (
    text.includes("ACCESS_TOKEN_EXPIRED") ||
    text.includes("ACCESS_TOKEN_LEGACY_RETIRED")
  ) {
    return "login.newApi.tokenError.expired";
  }
  return null;
}
