import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 便携版（zip 解包直跑）home 判定与启动早期数据目录计划。
 *
 * 产品规则见 packages/desktop/docs/portable-data-dir.md。要点：
 * - 便携版默认把 `.zcode` 放在 exe 同目录，安装版（NSIS，带卸载器）行为不变；
 * - 用户在 exe 同目录手动创建 `data` 目录后，锚点整体切换为该目录
 *   （状态落在 `<exe>/data/.zcode`），删除后下次启动恢复 exe 目录锚点，不做数据迁移；
 * - 显式环境变量 / setting.json 的 dataBaseDir 永远优先于便携默认与 data 目录约定；
 * - exe 目录不可写时回退用户主目录。
 *
 * 本模块保持纯函数 + 依赖注入，便于 vitest 直接覆盖判定与优先级逻辑；
 * IO 副作用（读 setting.json、探测可写、写 env）由 desktopDataBaseDirBootstrap 施加。
 */

/** electron-builder NSIS 安装版一定在安装根目录携带的卸载器文件名前缀。 */
const NSIS_UNINSTALLER_FILE_PATTERN = /^Uninstall.+\.exe$/i;

/**
 * Electron 专有的 process.defaultApp（`electron .` 开发态启动时为 true）。
 * @types/node 未声明该字段，这里窄化读取；打包态运行时恒为 undefined。
 */
function isElectronDevLaunch(process_: NodeJS.Process = process): boolean {
  return Boolean((process_ as NodeJS.Process & { defaultApp?: boolean }).defaultApp);
}

export interface PortableHomeDetectionOptions {
  platform?: NodeJS.Platform | string;
  /** 打包态（对应 Electron app.isPackaged）；开发态必须传入 false。 */
  isPackaged?: boolean;
  /** 应用可执行文件路径（打包态下 process.execPath 即 ZCode.exe）。 */
  executablePath?: string;
  /** 目录枚举，测试注入用；默认 readdirSync。 */
  listDirEntries?: (dir: string) => readonly string[];
}

/**
 * 判定当前运行形态是否为 Windows 便携包，是则返回 exe 所在目录，否则 null。
 *
 * 判据（仅 win32 + 打包态）：exe 同目录不存在 `Uninstall*.exe`。
 * NSIS 安装版必带卸载器；zip 便携包（win-unpacked 内容）没有。
 */
export function resolvePortableAppHomeDir(options: PortableHomeDetectionOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return null;
  }
  const isPackaged = options.isPackaged ?? !isElectronDevLaunch();
  if (!isPackaged) {
    return null;
  }
  const executablePath = options.executablePath ?? process.execPath;
  const appDir = dirname(executablePath);
  const listDirEntries = options.listDirEntries ?? readdirSync;
  let entries: readonly string[];
  try {
    entries = listDirEntries(appDir);
  } catch {
    // 目录不可枚举（极端权限）时按非便携处理，走默认主目录。
    return null;
  }
  if (entries.some((entry) => NSIS_UNINSTALLER_FILE_PATTERN.test(entry))) {
    return null;
  }
  return appDir;
}

/** 启动早期 settings 锚点（setting.json 的 home 前缀）：显式 env > 主目录。 */
export function resolveSettingsHomeAnchor(
  env: Record<string, string | undefined> = process.env,
  homeDir: string = "",
): string {
  const override = env.ZCODE_DESKTOP_HOME_DIR?.trim();
  return override && override.length > 0 ? override : homeDir;
}

/** data 目录约定的目录名；大小写由文件系统决定（便携判定仅 win32，天然大小写不敏感）。 */
export const PORTABLE_DATA_DIR_NAME = "data";

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 便携分支下用户手动创建的 `data` 目录（见 spec 的 data 目录约定）：
 * 存在且是目录 → 返回该路径并作为锚点；不存在 / 同名文件 / 非便携 → null。
 * 与旧 `<exe>/.zcode` 之间不做迁移，切换语义见 spec。
 */
export function resolvePortableDataDir(
  portableHomeDir: string | null,
  directoryExists: (path: string) => boolean = isExistingDirectory,
): string | null {
  if (!portableHomeDir) {
    return null;
  }
  const candidate = join(portableHomeDir, PORTABLE_DATA_DIR_NAME);
  return directoryExists(candidate) ? candidate : null;
}

export interface EarlyDataBaseDirPlanInput {
  env: Record<string, string | undefined>;
  /** 用户主目录（回退与安装版默认）。 */
  homeDir: string;
  /** 便携判定结果；null 表示安装版 / 开发态 / 非 Windows。 */
  portableHomeDir: string | null;
  /**
   * 便携分支下用户手动创建的 `<exe>/data` 目录（resolvePortableDataDir 的结果）；
   * 存在时替换便携默认锚点。非便携分支必须传 null。
   */
  portableDataDir: string | null;
  /** 读取 `<home>/.zcode/v2/setting.json` 的 dataBaseDir 字段；null 表示无显式配置。 */
  readConfiguredDataBaseDir: (settingsHome: string) => string | null;
}

export interface EarlyDataBaseDirPlan {
  /** settings 锚点（setting.json 所在 home 前缀）。 */
  readonly settingsHome: string;
  /** 应生效的数据根；null 表示沿用默认链（安装版现状）。 */
  readonly dataBaseDir: string | null;
  /** 是否需要把 settingsHome 写入 ZCODE_DESKTOP_HOME_DIR（便携分支才需要）。 */
  readonly propagateSettingsHomeEnv: boolean;
}

/**
 * 启动早期数据目录优先级计划（纯函数）：
 *
 * 1. 显式 `ZCODE_DATA_BASE_DIR` / `ZCODE_DESKTOP_HOME_DIR`（开发者与 e2e 隔离）——
 *    便携判定（含 data 目录约定）不覆盖任何显式配置，此时计划保持现状语义；
 * 2. 当前生效锚点的 setting.json 里用户显式配置的 `dataBaseDir`；
 * 3. 便携 `data` 目录约定：用户手动创建的 `<exe>/data` 替换便携默认锚点；
 * 4. 便携默认：exe 同目录（同时成为 settings 锚点）；
 * 5. 默认主目录（安装版现状）。
 */
export function planEarlyDataBaseDir(input: EarlyDataBaseDirPlanInput): EarlyDataBaseDirPlan {
  const explicitData = input.env.ZCODE_DATA_BASE_DIR?.trim() || null;
  const explicitSettingsHome = input.env.ZCODE_DESKTOP_HOME_DIR?.trim() || null;

  // 显式 env 优先：既不覆盖 dataBaseDir（避免 setDataBaseDir 压过 env），也不改 settings 锚点。
  if (explicitData || explicitSettingsHome) {
    return {
      settingsHome: explicitSettingsHome ?? input.homeDir,
      dataBaseDir: null,
      propagateSettingsHomeEnv: false,
    };
  }

  // 便携分支：锚点 = 手动 data 目录 ?? exe 目录；setting.json 始终从当前生效锚点读取。
  const settingsHome = input.portableHomeDir
    ? (input.portableDataDir ?? input.portableHomeDir)
    : input.homeDir;
  const configured = input.readConfiguredDataBaseDir(settingsHome);
  if (configured) {
    // 用户在（当前锚点下的）setting.json 里显式指定了数据目录：尊重显式配置。
    return { settingsHome, dataBaseDir: configured, propagateSettingsHomeEnv: input.portableHomeDir !== null };
  }
  return {
    settingsHome,
    dataBaseDir: input.portableHomeDir ? (input.portableDataDir ?? input.portableHomeDir) : null,
    propagateSettingsHomeEnv: input.portableHomeDir !== null,
  };
}

/**
 * 便携目录可写探测：`<dir>/.zcode` 必须可创建、可写入、可删除。
 * 只读介质（写保护 U 盘等）返回 false，调用方回退主目录。
 */
export function ensurePortableHomeWritable(portableHomeDir: string): boolean {
  const probeRoot = join(portableHomeDir, ".zcode");
  const probeFile = join(probeRoot, ".portable-write-probe");
  try {
    mkdirSync(probeRoot, { recursive: true });
    writeFileSync(probeFile, "probe");
    rmSync(probeFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 供早期 bootstrap 复用的 setting.json 路径（锚点由 resolveSettingsHomeAnchor 决定）。 */
export function portableAwareSettingsFile(settingsHome: string): string {
  return join(settingsHome, ".zcode", "v2", "setting.json");
}
