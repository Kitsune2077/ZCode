import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ZCodeSessionFile, ZCodeTaskMeta } from "@zcode/shared";
import { zcodeSessionFileSchema, zcodeTaskMetaSchema, zcodeTaskModeSchema } from "@zcode/shared";
import { getLegacyTaskSessionSnapshotPath } from "#src/paths.js";

export type LegacyTaskSessionFile = Omit<ZCodeSessionFile, "meta"> & {
  meta: Omit<ZCodeTaskMeta, "mode"> & { mode?: ZCodeTaskMeta["mode"] };
};

const legacyTaskSessionFileSchema = zcodeSessionFileSchema.extend({
  // Claude 原生迁移会按清洗路径删除 meta.mode。
  // legacy snapshot 读取/写入仍要校验其它必需字段，但不能再强制把被过滤字段补回文件。
  meta: zcodeTaskMetaSchema.extend({
    mode: zcodeTaskModeSchema.optional(),
  }),
});

export function parseLegacyTaskSessionFile(input: unknown): LegacyTaskSessionFile {
  return legacyTaskSessionFileSchema.parse(input);
}

export function safeParseLegacyTaskSessionFile(input: unknown) {
  return legacyTaskSessionFileSchema.safeParse(input);
}

async function writeSessionFileAtomic(
  filePath: string,
  sessionFile: LegacyTaskSessionFile,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
  const serialized = JSON.stringify(sessionFile, null, 2);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tempPath, `${serialized}\n`, "utf-8");
  await rename(tempPath, filePath);
}

/**
 * 把外部导入的会话写成 legacy task snapshot（~/.zcode/v2/sessions/{hash}/{taskId}.json）。
 * 真实 ZCode session 承担续聊，legacy snapshot 只保存过滤后的迁移备份；
 * Claude 与 OpenCode 导入共用这一条写入路径，避免各来源自行复制原子写逻辑。
 */
export async function writeImportedLegacyTaskSnapshot(params: {
  sessionFile: LegacyTaskSessionFile;
}): Promise<void> {
  const parsed = parseLegacyTaskSessionFile(params.sessionFile);
  const filePath = getLegacyTaskSessionSnapshotPath(
    parsed.meta.workspacePath,
    parsed.meta.taskId,
    parsed.meta.workspaceIdentity,
  );
  await writeSessionFileAtomic(filePath, parsed);
}
