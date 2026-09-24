/**
 * NewAPI 浏览器登录窗口。
 *
 * 职责只有一个：打开用户填写的 NewAPI 地址，等 dashboard 登录写回会话 cookie，把它取出来。
 * 设计见 packages/services/docs/newapi-browser-login.md。
 *
 * 安全约束（改动前请先读 spec）：
 * - 使用**不带 `persist:` 的内存分区**：cookie 只存在于内存，随窗口销毁而不落盘，
 *   因此不需要"用完清理"，也不会有残留凭据被其它窗口读到；
 * - 不注入任何 preload，不开启 nodeIntegration，窗口内只有普通网页能力；
 * - 只读取约定名称的 cookie，不遍历、不导出其它 cookie；
 * - 返回值经 IPC 直接进入凭据仓库，不参与日志与遥测。
 */

import { BrowserWindow, session } from "electron";
import {
  NEW_API_REFRESH_COOKIE_NAME,
  resolveNewApiLoginUrl,
  type NewApiBrowserLoginRequest,
  type NewApiBrowserLoginResult,
} from "@zcode/shared";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const COOKIE_POLL_INTERVAL_MS = 500;
const WINDOW_WIDTH = 520;
const WINDOW_HEIGHT = 760;

interface NewApiLoginWindowLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface OpenNewApiLoginWindowOptions {
  readonly logger: NewApiLoginWindowLogger;
}

interface ResolvedLoginTarget {
  readonly loginUrl: string;
  readonly origin: string;
}

function resolveLoginTarget(request: NewApiBrowserLoginRequest): ResolvedLoginTarget {
  const loginUrl = resolveNewApiLoginUrl(request);
  const parsed = new URL(loginUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("NewAPI base URL must use http or https.");
  }
  return { loginUrl: parsed.toString(), origin: parsed.origin };
}

/**
 * 打开登录窗口并等待会话 cookie。
 *
 * 用轮询而不是 `cookies.on("changed")`：登录跳转可能在任何一次导航里写 cookie，
 * 事件监听需要同时在多处补"我在监听之前就已经写入了"的竞态处理；500ms 轮询在 5 分钟窗口内
 * 只有几百次内存查询，代价可忽略，而行为更可预测。
 */
export async function openNewApiLoginWindow(
  request: NewApiBrowserLoginRequest,
  options: OpenNewApiLoginWindowOptions,
): Promise<NewApiBrowserLoginResult> {
  let target: ResolvedLoginTarget;
  try {
    target = resolveLoginTarget(request);
  } catch (error) {
    return {
      status: "failed",
      code: "invalid-base-url",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // 每次登录一个独立的内存分区，避免上一次登录的会话影响这一次。
  const partition = `newapi-login-${Date.now()}`;
  const loginSession = session.fromPartition(partition);
  const timeoutMs =
    request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_TIMEOUT_MS;

  const loginWindow = new BrowserWindow({
    autoHideMenuBar: true,
    height: WINDOW_HEIGHT,
    title: "NewAPI 登录",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition,
      sandbox: true,
    },
    width: WINDOW_WIDTH,
  });

  options.logger.info("[newapi-login] window opened", { origin: target.origin });

  const readCookie = async (): Promise<string | undefined> => {
    const cookies = await loginSession.cookies.get({
      name: NEW_API_REFRESH_COOKIE_NAME,
      url: target.origin,
    });
    const value = cookies.at(-1)?.value?.trim();
    return value ? value : undefined;
  };

  let closed = false;
  const onClosed = () => {
    closed = true;
  };
  loginWindow.on("closed", onClosed);

  let pollTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;

  const waitForCookieOrClose = () =>
    new Promise<NewApiBrowserLoginResult>((resolve) => {
      let settled = false;
      const finish = (result: NewApiBrowserLoginResult) => {
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve(result);
      };

      timeoutTimer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);
      pollTimer = setInterval(() => {
        if (closed) {
          finish({ status: "cancelled" });
          return;
        }
        void readCookie().then(
          (value) => {
            if (value) {
              finish({ status: "completed", cookieValue: value, origin: target.origin });
            }
          },
          (error: unknown) => {
            options.logger.warn("[newapi-login] reading cookies failed", error);
          },
        );
      }, COOKIE_POLL_INTERVAL_MS);
    });

  try {
    // 先挂等待，再导航：避免导航极快完成时错过已完成的状态。
    const resultPromise = waitForCookieOrClose();
    await loginWindow.loadURL(target.loginUrl);
    const result = await resultPromise;

    if (result.status === "completed") {
      options.logger.info("[newapi-login] session cookie captured", { origin: target.origin });
    } else {
      options.logger.info("[newapi-login] finished without a session cookie", {
        status: result.status,
      });
    }
    return result;
  } catch (error) {
    return {
      status: "failed",
      code: "load-failed",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (pollTimer) clearInterval(pollTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    loginWindow.removeListener("closed", onClosed);
    if (!loginWindow.isDestroyed()) {
      loginWindow.destroy();
    }
    // 内存分区随窗口销毁；这里再清一次，确保 cookie 不留在进程里。
    void loginSession.clearStorageData().catch(() => {
      // 清理失败不影响结果：分区本身不持久化，进程退出即消失。
    });
  }
}
