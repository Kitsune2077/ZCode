import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setDataBaseDir } from "@zcode/services/node";
import {
  ensurePortableHomeWritable,
  planEarlyDataBaseDir,
  portableAwareSettingsFile,
  resolvePortableAppHomeDir,
  resolvePortableDataDir,
  resolveSettingsHomeAnchor,
} from "./desktopPortableHome.js";

export function resolveBootstrapSettingsFile(
  homePath: string = resolveSettingsHomeAnchor(process.env, homedir()),
): string {
  return join(homePath, ".zcode", "v2", "setting.json");
}

export function extractBootstrapDataBaseDir(rawValue: unknown): string | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const dataBaseDir = (rawValue as { dataBaseDir?: unknown }).dataBaseDir;
  if (typeof dataBaseDir !== "string") {
    return null;
  }

  const trimmed = dataBaseDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBootstrapDataBaseDirFromDisk(settingsFile: string): string | null {
  if (!existsSync(settingsFile)) {
    return null;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapDataBaseDir(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function applyEarlyDataBaseDirBootstrap(): string | null {
  // 便携版（zip 解包直跑）默认把数据目录放在 exe 同目录；安装版（带 NSIS 卸载器）
  // 判定结果为 null，走原有主目录链路。规则见 packages/desktop/docs/portable-data-dir.md。
  let portableHomeDir = resolvePortableAppHomeDir();
  if (portableHomeDir && !ensurePortableHomeWritable(portableHomeDir)) {
    // 只读便携介质：回退主目录，避免启动即崩；留下可检索的 warn 便于定位。
    console.warn(
      `[data-base-dir] portable app directory is not writable, falling back to the user home: ${portableHomeDir}`,
    );
    portableHomeDir = null;
  }

  // data 目录约定：便携判定生效且用户手动创建了 <exe>/data 目录时，锚点整体切到该目录
  // （规则与切换语义见 docs/portable-data-dir.md；不可写回退已将 portableHomeDir 置 null）。
  const portableDataDir = resolvePortableDataDir(portableHomeDir);

  const plan = planEarlyDataBaseDir({
    env: process.env,
    homeDir: homedir(),
    portableHomeDir,
    portableDataDir,
    readConfiguredDataBaseDir: (settingsHome) =>
      readBootstrapDataBaseDirFromDisk(portableAwareSettingsFile(settingsHome)),
  });

  if (plan.propagateSettingsHomeEnv && !process.env.ZCODE_DESKTOP_HOME_DIR) {
    // 便携分支：settings 锚点与 Electron home（desktopRuntimeEnv 的 runtimeHomePath 稍后读取）
    // 跟随 exe 目录。e2e / 开发者显式预设该变量时不覆盖（plan 阶段已排除）。
    process.env.ZCODE_DESKTOP_HOME_DIR = plan.settingsHome;
  }

  if (plan.dataBaseDir) {
    // 启动早期就把 dataBaseDir 注入进来，避免 logger / crashReporter 先按默认 HOME 建目录，
    // 导致后续再切换到自定义目录时，日志和 crash dump 落在两套路径里。
    setDataBaseDir(plan.dataBaseDir);
  }
  return plan.dataBaseDir;
}
