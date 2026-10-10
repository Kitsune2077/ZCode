import type { ZCodePersistedMessage, ZCodeTaskPersistStatus } from "@zcode/shared";

/** 导入来源身份：外部原生 CLI（DeepSeek Harness），与 agent runtime 的 ZCodeProvider 无关。 */
export type DshNativeImportSourceProvider = "deepseekHarness";

export interface DshNativeImportedSessionSource {
  provider: DshNativeImportSourceProvider;
  sessionId: string;
  workspacePath: string;
  sourcePath: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  model?: string;
  status?: ZCodeTaskPersistStatus;
  migrationSource?: "deepseekHarness";
  messages: ZCodePersistedMessage[];
}
