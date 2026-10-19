/**
 * session-import 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 * 每个方法注释写清：前置/后置条件、幂等性、发出哪些事件、是否等待持久化。
 *
 * 模块聚合各外部 Agent（OpenCode / DeepSeek Harness）的原生会话导入源。每个来源提供两个意图：
 * 扫描候选与执行导入；具体实现文件是各 `*-native` 目录下的 `*SessionImportRepo.ts`
 * （扫描）与 `*SessionImportService.ts`（导入），协议命令与 UI hook 只依赖本契约描述的形状。
 */
import type {
  ZCodeImportableSessionCandidate,
  ZCodeImportSessionsResult,
  ZCodeTaskMeta,
} from "@zcode/shared";

/** 扫描参数：workspacePath 只做候选过滤，不决定能力可用性；limit/modifiedSince 可选收紧范围。 */
export interface SessionImportScanParams {
  workspacePath?: string;
  workspaceIdentity?: string;
  modifiedSince?: number;
  limit?: number;
}

/**
 * 导入参数：createImportedSession 必须由调用方提供（桌面端经适配器创建真实 ZCode session），
 * 服务侧只允许在其返回的索引行上补 presentation/searchable，不能凭空创建第二条会话事实。
 */
export interface SessionImportRunParams<Source> {
  sessionIds: string[];
  workspacePath?: string;
  workspaceIdentity?: string;
  createImportedSession: (source: Source) => Promise<ZCodeTaskMeta>;
  onTaskImported: (meta: ZCodeTaskMeta) => void;
}

export interface SessionImportSourceContract<Source> {
  /** 只读扫描来源库，不写任何状态；重复调用幂等，返回按 updatedAt 降序的候选。 */
  scanImportableSessions(params: SessionImportScanParams): Promise<ZCodeImportableSessionCandidate[]>;
  /**
   * 逐条导入：每条独立成功/失败，结果聚合为 imported/skipped/failed。
   * 持久化路径：createImportedSession 建会话 → legacy snapshot 备份 → task index 补事实，全部落盘后才计入 imported。
   */
  importSessions(params: SessionImportRunParams<Source>): Promise<ZCodeImportSessionsResult>;
}
