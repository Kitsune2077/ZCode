import type { ZCodePersistedMessage, ZCodeTaskPersistStatus } from "@zcode/shared";

/** 导入来源身份：ZCode Windows 便携版（另一份安装的只读数据），与 agent runtime 的 ZCodeProvider 无关。 */
export type ZCodeInstalledImportSourceProvider = "zcodeInstalled";

export interface ZCodeInstalledImportedSessionSource {
  provider: ZCodeInstalledImportSourceProvider;
  sessionId: string;
  workspacePath: string;
  sourcePath: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  model?: string;
  status?: ZCodeTaskPersistStatus;
  migrationSource?: "zcodeInstalled";
  messages: ZCodePersistedMessage[];
}
