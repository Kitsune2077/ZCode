import type { SkillDataSyncPayload } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { IDataSyncCategoryService } from "../data-sync/contract.js";

/**
 * 本仓库定制：本地 ZIP 技能包导入的结果。
 * 上游 3.17 把技能同步收敛到 IDataSyncCategoryService 并移除了旧的 SkillSyncImportResult，
 * 但 fork 的「从本地 ZIP 导入技能」入口仍沿用逐项结果，故在本地定义该形状。
 */
export interface SkillZipImportResultItem {
  name: string;
  directoryName: string;
  status: "synced" | "skipped" | "failed";
  path?: string;
  error?: string;
}

export interface SkillZipImportResult {
  results: SkillZipImportResultItem[];
}

/** 技能同步服务：数据同步弹窗使用 IDataSyncCategoryService 的统一形状。 */
export type ISkillSyncService = IDataSyncCategoryService<SkillDataSyncPayload> & {
  /** 本仓库定制：把本地 .zip 技能包导入到用户级 ~/.zcode/skills。 */
  importSkillsZipArchive(params: { filePath: string }): Promise<SkillZipImportResult>;
};

export const ISkillSyncService = createServiceDescriptor<ISkillSyncService>(
  ServiceChannels.SkillSync,
);
