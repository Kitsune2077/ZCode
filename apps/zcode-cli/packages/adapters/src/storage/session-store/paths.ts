import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePath } from "../../config/file-config.adapter.js";

/**
 * usage 会话库的基目录：显式 `ZCODE_DATA_BASE_DIR`（桌面便携态由 main 下发）优先，
 * 否则为用户主目录。独立 CLI 不设该变量，行为不变；SSH 远端 CLI 不继承该变量，
 * 远端库仍在远端用户主目录。
 */
export function resolveSessionDbBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const baseDir = env.ZCODE_DATA_BASE_DIR?.trim();
  return baseDir && baseDir.length > 0 ? baseDir : homedir();
}

export function getDefaultSessionDbPath(): string {
  // 便携版（数据根 = exe 目录）下 usage 库必须随程序走，否则迁移时丢用量历史；
  // 此前裸用 homedir()，ZCODE_DATA_BASE_DIR 被无视，是便携数据目录功能的一致性缺口。
  return join(resolveSessionDbBaseDir(), ".zcode", "cli", "db", "db.sqlite");
}

/** CLI 存储根（storage.dir）的文档化默认值（contracts DefaultConfig 同字面量）。 */
const DEFAULT_STORAGE_DIR_CONFIG_VALUE = "~/.zcode";

/**
 * CLI 存储根（插件缓存 / 技能 / MCP / 执行产物等 `{storage.dir}` 的落点）：
 * 配置为默认字面量且宿主下发了 `ZCODE_DATA_BASE_DIR`（桌面便携态由 main 下发）时，
 * 存储根随数据根走（`{dataBaseDir}/.zcode`）；用户显式配置的其它路径不受影响。
 * 与 getSessionDbPath 的便携分支同一语义——此前各调用点裸 resolvePath，便携版下
 * 插件缓存等仍落在安装版主目录 `~/.zcode`，与便携数据根隔离承诺冲突。
 */
export function resolveStorageRootDir(
  configured: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (configured === DEFAULT_STORAGE_DIR_CONFIG_VALUE) {
    const baseDir = env.ZCODE_DATA_BASE_DIR?.trim();
    if (baseDir && baseDir.length > 0) {
      return join(baseDir, ".zcode");
    }
  }
  return resolvePath(configured);
}
