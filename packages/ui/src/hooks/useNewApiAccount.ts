/**
 * NewAPI 账号信息读取。
 *
 * 连接（API 根 + 访问令牌）来自凭据服务；账号信息是派生只读投影，不写入任何 store。
 * 网络调用统一经 IProviderSettingsService.getNewApiAccountInfo 由 Host 发出。
 */
import { useCallback, useEffect, useState } from "react";
import type { NewApiAccountInfo } from "@zcode/services";
import {
  loadNewApiConnection,
  loadNewApiRefreshCookie,
  resolveStableNewApiConnection,
  saveNewApiConnection,
  saveNewApiRefreshCookie,
  type NewApiConnection,
} from "@/lib/newApiConnection.js";
import { fetchNewApiAccountWithAutoRefresh } from "@/lib/newApiAccountRefresh.js";
import { useServices } from "./useServices.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

export interface NewApiConnectionState {
  readonly connection: NewApiConnection | null;
  readonly loading: boolean;
}

export interface NewApiConnectionResult extends NewApiConnectionState {
  /** 凭据被外部改写后（例如退出 NewAPI 登录）强制重读。 */
  readonly refresh: () => void;
}

/**
 * 读取当前 NewAPI 连接。只有凭据读写，不发网络请求。
 * 依赖 apiKeyLoginSuccessSeq：NewAPI 登录成功会自增该计数，避免登录后仍读到旧凭据。
 *
 * 引用稳定性：写入 state 前必须经 `resolveStableNewApiConnection` 收敛。否则每次重读凭据都会产生
 * 新对象，让 `useNewApiAccount` 以 `connection` 为依赖的账号读取 effect 反复重跑——令牌续期后的
 * `refreshConnection()` 会与它形成闭环，表现为左下角用户名与「NewAPI」来回闪烁、用量页读取失败。
 * 注意这只是收敛的必要条件之一；loading 标志翻转与无条件重读的另一条反馈边见
 * `useNewApiAccount` 内注释与 docs/newapi-account-usage.md。
 */
export function useNewApiConnection(): NewApiConnectionResult {
  const { credentialService } = useServices();
  const apiKeyLoginSuccessSeq = useZCodeStore((state) => state.apiKeyLoginSuccessSeq);
  const [connection, setConnection] = useState<NewApiConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((current) => current + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadNewApiConnection(credentialService).then(
      (loaded) => {
        if (cancelled) return;
        // 用函数式更新读取"本次落地时"的当前值再收敛：重读失败/并发完成时不会用旧快照覆盖新凭据。
        setConnection((previous) => resolveStableNewApiConnection(previous, loaded));
        setLoading(false);
      },
      () => {
        if (cancelled) return;
        setConnection(null);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [apiKeyLoginSuccessSeq, credentialService, revision]);

  return { connection, loading, refresh };
}

export type NewApiAccountState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly info: NewApiAccountInfo }
  | { readonly status: "error"; readonly message: string };

export interface NewApiAccountResult {
  readonly state: NewApiAccountState;
  readonly connection: NewApiConnection | null;
  /** 手动重试；令牌失效或网络失败后由 UI 触发。 */
  readonly refresh: () => void;
  /** 退出 NewAPI 登录后重读连接（连接为空会同时把账号状态归零）。 */
  readonly refreshConnection: () => void;
}

export function useNewApiAccount(options: { enabled?: boolean } = {}): NewApiAccountResult {
  const enabled = options.enabled !== false;
  const { credentialService, providerSettingsService } = useServices();
  const { connection, refresh: refreshConnection } = useNewApiConnection();
  const [state, setState] = useState<NewApiAccountState>({ status: "idle" });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((current) => current + 1), []);

  useEffect(() => {
    // 守卫不看 connectionLoading：loading 翻转不是凭据变化。它曾是本 effect 的依赖之一，
    // 每次 refreshConnection() 重读连接都会让 loading 走一轮 false→true→false，把一次
    // 成功的读取重新拉起，与「成功后无条件 refreshConnection」叠加成无限重跑闭环：
    // 左下角在真实用户名与「NewAPI」之间闪烁、每轮向 NewAPI 发 3 个请求，直到某次
    // 读取失败停在 error 态（用户名固定为「NewAPI」、用量页报读取失败）。
    // 「连接尚未加载完」由 `connection === null` 覆盖，无需第二个早退条件。
    if (!enabled) {
      return;
    }
    if (!connection) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void fetchNewApiAccountWithAutoRefresh({
      initialAccessToken: connection.accessToken,
      fetchAccount: (accessToken) =>
        providerSettingsService.getNewApiAccountInfo({
          accessToken,
          baseUrl: connection.baseUrl,
        }),
      loadRefreshCookie: () => loadNewApiRefreshCookie(credentialService, connection.providerId),
      exchangeSession: (refreshCookie) =>
        providerSettingsService.exchangeNewApiSession({
          baseUrl: connection.baseUrl,
          refreshCookie,
        }),
      persistRefreshedCredentials: async ({ accessToken, refreshCookie }) => {
        // 与登录落库同一路径写指针 + 令牌；cookie 走专门的键（服务端已轮换，旧值失效）。
        await saveNewApiConnection(credentialService, {
          providerId: connection.providerId,
          baseUrl: connection.baseUrl,
          accessToken,
        });
        await saveNewApiRefreshCookie(credentialService, {
          providerId: connection.providerId,
          refreshCookie,
        });
      },
    }).then(
      (result) => {
        if (cancelled) return;
        setState({ status: "ready", info: result.info });
        // 只有续期确实发生（新令牌已落库、连接快照仍持旧令牌）才重读指针；
        // 凭据未变的成功读取是终态，重读只会白费 IO 并重新触发本 effect。
        if (result.credentialsRenewed) {
          refreshConnection();
        }
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({
          message: error instanceof Error ? error.message : String(error),
          status: "error",
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    connection,
    credentialService,
    enabled,
    providerSettingsService,
    refreshConnection,
    revision,
  ]);

  return { connection, refresh, refreshConnection, state };
}
