import type { NewApiAccountInfo } from "@zcode/services";

/**
 * NewAPI 账号读取的自动续期编排（纯函数，IO 全部注入）。
 *
 * bug 背景：浏览器登录时保存的 refresh cookie 注释写明"存下来是为了 access token
 * 过期时能自动续期"，但这条链路从未实现——访问令牌一旦过期/被服务端轮换，
 * `/api/user/self` 返回未授权，左下角回落「连接使用」而菜单仍显示「断开连接」，
 * 用量页 NewAPI 标签同步失败。该状态与安装版/便携版无关，任何版本令牌过期都会触发。
 *
 * 策略（对应 newapi-browser-login.md 验收场景 F）：
 * 1. 用当前令牌读取账号；成功即返回。
 * 2. 失败时读 refresh cookie；没有 cookie 直接抛原始错误。
 * 3. 用 cookie 兑换新令牌；服务端会**轮换** cookie，必须连同新令牌一起回写凭据。
 * 4. 用新令牌重读一次；仍失败则抛出重读的错误（此时续期本身已成功，不应再吞掉）。
 *
 * 兑换失败（cookie 也过期）抛出原始读取错误，让 UI 呈现"请重新登录"而不是
 * 把"续期失败"误报成"网络故障"。全程只尝试一次续期，避免循环。
 */
export interface NewApiAccountAutoRefreshInput {
  readonly initialAccessToken: string;
  fetchAccount: (accessToken: string) => Promise<NewApiAccountInfo>;
  loadRefreshCookie: () => Promise<string | null>;
  exchangeSession: (refreshCookie: string) => Promise<{
    accessToken: string;
    rotatedRefreshCookie?: string;
  }>;
  /** 回写续期产物：新访问令牌 + 轮换后的 refresh cookie（无轮换值则沿用旧值）。 */
  persistRefreshedCredentials: (input: {
    accessToken: string;
    refreshCookie: string;
  }) => Promise<void>;
}

export async function fetchNewApiAccountWithAutoRefresh(
  input: NewApiAccountAutoRefreshInput,
): Promise<NewApiAccountInfo> {
  try {
    return await input.fetchAccount(input.initialAccessToken);
  } catch (originalError) {
    const refreshCookie = await input.loadRefreshCookie();
    if (!refreshCookie) {
      throw originalError;
    }

    let exchanged: { accessToken: string; rotatedRefreshCookie?: string };
    try {
      exchanged = await input.exchangeSession(refreshCookie);
    } catch {
      // cookie 同样失效：抛原始读取错误——它才是用户需要知道的事（令牌已过期）。
      throw originalError;
    }

    const nextRefreshCookie = exchanged.rotatedRefreshCookie ?? refreshCookie;
    await input.persistRefreshedCredentials({
      accessToken: exchanged.accessToken,
      refreshCookie: nextRefreshCookie,
    });

    // 续期已成功并落库；重读失败就抛重读的错误，不再回退到原始错误，
    // 否则会把"新令牌仍被拒"（服务端账号状态异常）误报成"旧令牌过期"。
    return input.fetchAccount(exchanged.accessToken);
  }
}
