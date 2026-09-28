import type { NewApiAccountInfo } from "@zcode/services";
import type { NewApiConnection } from "./newApiConnection.js";

/**
 * NewAPI 展示层的「最近已知」种子（stale-while-revalidate）。
 *
 * footer 被主界面与设置页分别挂载，每个实例的连接/账号状态各自独立；没有种子时
 * 新实例从 null/idle 起步，打开设置页的瞬间左下角会闪回「连接使用」再恢复用户名。
 * 这里在 renderer 内存里保留最近一次落定的连接快照与账号读取结果，只用于新实例
 * 挂载时的首帧渲染；事实源仍是凭据服务（连接）与服务端（账号），挂载后照常刷新。
 *
 * 写点与凭据同生命周期：saveNewApiConnection / clearNewApiConnection（唯二写路径）
 * 同步更新；账号读取成功时按连接字段精确关联。断开清空两者；续期换 token 后旧
 * 账号种子因字段失配自动作废——宁可回落中性「NewAPI」也不显示可能过期的账号名。
 */

let knownConnection: NewApiConnection | null = null;
let knownAccount:
  | {
      readonly providerId: string;
      readonly baseUrl: string;
      readonly accessToken: string;
      readonly info: NewApiAccountInfo;
    }
  | null = null;

function isNewApiConnectionFieldsEqual(
  connection: NewApiConnection,
  other: NewApiConnection,
): boolean {
  return (
    connection.providerId === other.providerId &&
    connection.baseUrl === other.baseUrl &&
    connection.accessToken === other.accessToken
  );
}

/** 记录最近已知的连接快照；null 表示未连接，同时清空账号种子。 */
export function rememberKnownNewApiConnection(connection: NewApiConnection | null): void {
  knownConnection = connection;
  if (!connection) {
    knownAccount = null;
    return;
  }
  // 同值新引用时保持账号种子关联（引用漂移不构成失效依据，字段才是）。
  if (knownAccount && !isNewApiConnectionFieldsEqual(asConnection(knownAccount), connection)) {
    knownAccount = null;
  }
}

/** 新实例挂载时的连接初始值；renderer 内共享同一引用（与 resolveStable 收敛配合）。 */
export function readKnownNewApiConnection(): NewApiConnection | null {
  return knownConnection;
}

/** 记录「该连接下的账号读取结果」；连接字段变化后自动失配。 */
export function rememberKnownNewApiAccount(
  connection: NewApiConnection,
  info: NewApiAccountInfo,
): void {
  knownAccount = {
    providerId: connection.providerId,
    baseUrl: connection.baseUrl,
    accessToken: connection.accessToken,
    info,
  };
}

/** 三字段精确匹配才命中；命中返回上次读取的账号信息，否则 null。 */
export function readKnownNewApiAccount(connection: NewApiConnection): NewApiAccountInfo | null {
  if (!knownAccount) {
    return null;
  }
  return isNewApiConnectionFieldsEqual(asConnection(knownAccount), connection)
    ? knownAccount.info
    : null;
}

function asConnection(
  account: NonNullable<typeof knownAccount>,
): Pick<NewApiConnection, "providerId" | "baseUrl" | "accessToken"> {
  return account;
}

/** 仅供测试在用例之间隔离模块状态。 */
export function resetNewApiKnownStateForTests(): void {
  knownConnection = null;
  knownAccount = null;
}
