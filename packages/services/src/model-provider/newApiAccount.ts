import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  NewApiProvisioningError,
  normalizeNewApiApiRoot,
  requestNewApiJson,
  type NewApiHttpNetwork,
} from "./newApiHttp.js";

/**
 * NewAPI 账号信息与用量读取。
 *
 * 用 NewAPI 访问令牌（登录拿到的 access_token）读取控制台 API：
 *   - GET /api/user/self  → 账号名/id/角色/余额/已用/请求次数（必需）
 *   - GET /api/status     → quota_per_unit、货币展示设置（公开，best-effort）
 *   - GET /api/data/self  → 按天聚合的消耗与请求次数，用于趋势（best-effort）
 *
 * 余额单位是 NewAPI 的整数 quota，换算金额 = quota / quota_per_unit（默认 500000 = 1 货币单位）。
 * 网络请求走注入的 fetch（Host 的 hostApiNetworkTransport）。
 */

export interface NewApiAccountInfoInput {
  readonly baseUrl: string;
  readonly accessToken: string;
}

export interface NewApiDailyUsagePoint {
  /** YYYY-MM-DD（按服务端返回的日桶时间戳转 UTC 日期）。 */
  readonly date: string;
  readonly quota: number;
  readonly count: number;
  readonly tokens: number;
}

export type NewApiRoleLabel = "common-user" | "admin" | "root" | "unknown";

export interface NewApiAccountInfo {
  readonly id?: number;
  readonly username: string;
  readonly displayName?: string;
  readonly role: number;
  readonly roleLabel: NewApiRoleLabel;
  readonly status?: number;
  readonly group?: string;
  readonly quota: number;
  readonly usedQuota: number;
  readonly requestCount: number;
  readonly quotaPerUnit: number;
  readonly displayInCurrency: boolean;
  readonly currencySymbol: string;
  readonly systemName?: string;
  readonly daily: readonly NewApiDailyUsagePoint[];
}

const DEFAULT_QUOTA_PER_UNIT = 500_000;
const DEFAULT_CURRENCY_SYMBOL = "$";
const USAGE_TREND_DAYS = 7;
const SECONDS_PER_DAY = 86_400;

const NEW_API_ROLE_ADMIN = 10;
const NEW_API_ROLE_ROOT = 100;

/**
 * 日志器必须在使用时才构造。
 *
 * 本模块经 providerFacadeServices 被 browser-safe 的 services 入口引用，而
 * createServiceLogger 会读 process.pid。若在模块作用域构造，Web 端会在 import 阶段
 * 抛 "process is not defined"，整个应用卡在启动页。账号读取由 Host 执行，
 * 因此延迟构造不会在浏览器里被真正调用。
 */
function logWarn(message: string): void {
  createServiceLogger("newapi-account").warn(undefined, message);
}

interface RemoteUserSelf {
  id?: number;
  username?: string;
  display_name?: string;
  role?: number;
  status?: number;
  group?: string;
  quota?: number;
  used_quota?: number;
  request_count?: number;
}

interface RemoteServerStatus {
  quota_per_unit?: number;
  display_in_currency?: boolean;
  custom_currency_symbol?: string;
  system_name?: string;
}

interface RemoteDailyUsageRow {
  created_at?: number;
  quota?: number;
  count?: number;
  token_used?: number;
}

export function resolveNewApiRoleLabel(role: number | undefined): NewApiRoleLabel {
  if (role === NEW_API_ROLE_ROOT) return "root";
  if (role === NEW_API_ROLE_ADMIN) return "admin";
  if (typeof role === "number" && Number.isFinite(role) && role >= 1) return "common-user";
  return "unknown";
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatDayBucket(createdAt: number | undefined): string | undefined {
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt <= 0) {
    return undefined;
  }
  return new Date(createdAt * 1_000).toISOString().slice(0, 10);
}

/** 把 /api/data/self 的「按天+按模型」行合并成按天汇总，日期升序。 */
export function aggregateNewApiDailyUsage(
  rows: readonly RemoteDailyUsageRow[],
): NewApiDailyUsagePoint[] {
  const byDate = new Map<string, NewApiDailyUsagePoint>();
  for (const row of rows) {
    const date = formatDayBucket(row.created_at);
    if (!date) continue;
    const current = byDate.get(date) ?? { count: 0, date, quota: 0, tokens: 0 };
    byDate.set(date, {
      count: current.count + readNumber(row.count),
      date,
      quota: current.quota + readNumber(row.quota),
      tokens: current.tokens + readNumber(row.token_used),
    });
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

async function readServerStatus(
  network: NewApiHttpNetwork,
  apiRoot: string,
): Promise<RemoteServerStatus | undefined> {
  try {
    return await requestNewApiJson<RemoteServerStatus>(network, {
      code: "account-info-failed",
      method: "GET",
      url: `${apiRoot}/api/status`,
    });
  } catch (error) {
    // 状态接口只影响金额换算和展示偏好，读不到时仍要能展示账号与额度。
    logWarn(`NewAPI /api/status 读取失败: ${String(error)}`);
    return undefined;
  }
}

async function readDailyUsage(
  network: NewApiHttpNetwork,
  apiRoot: string,
  accessToken: string,
  nowMs: number,
): Promise<NewApiDailyUsagePoint[]> {
  const endSeconds = Math.floor(nowMs / 1_000);
  const startSeconds = endSeconds - USAGE_TREND_DAYS * SECONDS_PER_DAY;
  try {
    const rows = await requestNewApiJson<RemoteDailyUsageRow[]>(network, {
      authorization: `Bearer ${accessToken}`,
      code: "usage-data-failed",
      method: "GET",
      url: `${apiRoot}/api/data/self?start_timestamp=${startSeconds}&end_timestamp=${endSeconds}`,
    });
    return aggregateNewApiDailyUsage(rows ?? []);
  } catch (error) {
    // 趋势是可选数据面：接口在旧版本可能不存在，账号总额度仍应正常展示。
    logWarn(`NewAPI /api/data/self 读取失败: ${String(error)}`);
    return [];
  }
}

/** 读取 NewAPI 账号信息 + 近 7 天用量趋势。账号信息读取失败即整体失败。 */
export async function fetchNewApiAccountInfo(
  network: NewApiHttpNetwork,
  input: NewApiAccountInfoInput,
  nowMs: number = Date.now(),
): Promise<NewApiAccountInfo> {
  const accessToken = input.accessToken.trim();
  if (!accessToken) {
    throw new NewApiProvisioningError("invalid-access-token", "NewAPI access token is required.");
  }
  const apiRoot = normalizeNewApiApiRoot(input.baseUrl);

  const [self, status, daily] = await Promise.all([
    requestNewApiJson<RemoteUserSelf>(network, {
      authorization: `Bearer ${accessToken}`,
      code: "account-info-failed",
      method: "GET",
      url: `${apiRoot}/api/user/self`,
    }),
    readServerStatus(network, apiRoot),
    readDailyUsage(network, apiRoot, accessToken, nowMs),
  ]);

  const username = self?.username?.trim() ?? "";
  if (!self || !username) {
    throw new NewApiProvisioningError(
      "account-info-failed",
      "NewAPI did not return the current user.",
    );
  }
  const displayName = self.display_name?.trim();
  return {
    quota: readNumber(self.quota),
    usedQuota: readNumber(self.used_quota),
    requestCount: readNumber(self.request_count),
    ...(typeof self.id === "number" ? { id: self.id } : {}),
    username,
    ...(displayName ? { displayName } : {}),
    role: readNumber(self.role),
    roleLabel: resolveNewApiRoleLabel(self.role),
    ...(typeof self.status === "number" ? { status: self.status } : {}),
    ...(self.group?.trim() ? { group: self.group.trim() } : {}),
    quotaPerUnit:
      readNumber(status?.quota_per_unit, DEFAULT_QUOTA_PER_UNIT) || DEFAULT_QUOTA_PER_UNIT,
    displayInCurrency: status?.display_in_currency === true,
    currencySymbol: status?.custom_currency_symbol?.trim() || DEFAULT_CURRENCY_SYMBOL,
    ...(status?.system_name?.trim() ? { systemName: status.system_name.trim() } : {}),
    daily,
  };
}
