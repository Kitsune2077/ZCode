/**
 * NewAPI 账号信息读取。
 *
 * 连接（API 根 + 访问令牌）来自凭据服务；账号信息是派生只读投影，不写入任何 store。
 * 网络调用统一经 IProviderSettingsService.getNewApiAccountInfo 由 Host 发出。
 */
import { useCallback, useEffect, useState } from "react";
import type { NewApiAccountInfo } from "@zcode/services";
import { loadNewApiConnection, type NewApiConnection } from "@/lib/newApiConnection.js";
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
        setConnection(loaded);
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
  const { providerSettingsService } = useServices();
  const {
    connection,
    loading: connectionLoading,
    refresh: refreshConnection,
  } = useNewApiConnection();
  const [state, setState] = useState<NewApiAccountState>({ status: "idle" });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((current) => current + 1), []);

  useEffect(() => {
    if (!enabled || connectionLoading) {
      return;
    }
    if (!connection) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void providerSettingsService
      .getNewApiAccountInfo({
        accessToken: connection.accessToken,
        baseUrl: connection.baseUrl,
      })
      .then(
        (info) => {
          if (!cancelled) setState({ status: "ready", info });
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
  }, [connection, connectionLoading, enabled, providerSettingsService, revision]);

  return { connection, refresh, refreshConnection, state };
}
