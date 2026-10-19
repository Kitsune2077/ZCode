import { copyFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getDataBaseDir } from "#src/paths.js";

const logger = createServiceLogger("zcode-installed-import");

/**
 * 安装版可迁移的配置清单：provider 配置、凭据与 CLI 用户配置。
 * 这些是 services/CLI 的活跃事实源文件（credentialService、model-provider
 * provisioning、CLI user config），逐文件按需复制；运行态/缓存/日志不在列。
 */
const INSTALLED_CONFIG_RELATIVE_PATHS = [
  ".zcode/v2/provider_config.json",
  ".zcode/v2/credentials.json",
  ".zcode/cli/config.json",
] as const;

export interface ZCodeInstalledConfigImportResult {
  /** 成功复制到当前数据根的配置文件相对路径。 */
  copied: string[];
  /** 当前实例已存在（或来源不存在）而跳过的文件相对路径。 */
  skipped: string[];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * 把安装版（真实用户主目录）的 provider/凭据/CLI 配置导入当前实例。
 *
 * 关键业务逻辑：只补缺失、绝不覆盖——便携版实例一旦有自己的配置（用户已登录、
 * 已选 provider），安装版的同名文件不再有意义，静默覆盖会吞掉用户在便携版里
 * 的新选择；已复制的文件由各读取方（credentials/provider provisioning/CLI）
 * 在下一次读取或重启后生效，本函数不做热重载。
 */
export async function importZCodeInstalledConfigs(params?: {
  /** 测试/高级用法注入的安装版用户主目录；缺省取 os.homedir()。 */
  homeDir?: string;
  /** 测试/高级用法注入的当前实例数据根；缺省取 getDataBaseDir()。 */
  targetDataBaseDir?: string;
}): Promise<ZCodeInstalledConfigImportResult> {
  const homeDir = params?.homeDir ?? homedir();
  const targetBaseDir = params?.targetDataBaseDir ?? getDataBaseDir();

  // 自我导入防护与 session 导入同因：当前实例就在使用主目录数据时没有可导入的“另一份”配置。
  if (resolve(homeDir) === resolve(targetBaseDir)) {
    throw new Error(
      "[zcode-installed] 当前实例正在使用用户主目录数据（安装版/默认形态），无需导入安装版配置",
    );
  }

  const result: ZCodeInstalledConfigImportResult = { copied: [], skipped: [] };
  for (const relativePath of INSTALLED_CONFIG_RELATIVE_PATHS) {
    const sourcePath = join(homeDir, relativePath);
    const targetPath = join(targetBaseDir, relativePath);
    if (!(await fileExists(sourcePath))) {
      result.skipped.push(relativePath);
      continue;
    }
    if (await fileExists(targetPath)) {
      result.skipped.push(relativePath);
      continue;
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    result.copied.push(relativePath);
  }

  logger.info(
    undefined,
    `ZCode 安装版配置导入完成 copied=${result.copied.length} skipped=${result.skipped.length}`,
  );
  return result;
}
