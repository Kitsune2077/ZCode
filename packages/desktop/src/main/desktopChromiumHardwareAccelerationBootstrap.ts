import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSettingsHomeAnchor } from "./desktopPortableHome.js";

interface ChromiumHardwareAccelerationApp {
  disableHardwareAcceleration(): void;
}

function resolveChromiumHardwareAccelerationSettingsFile(): string {
  // 便携版启动早期已把 ZCODE_DESKTOP_HOME_DIR 指到 exe 目录（见 desktopDataBaseDirBootstrap）；
  // 该 bootstrap 的求值顺序在其后，因此这里能读到便携锚点，安装版则仍是用户主目录。
  return join(resolveSettingsHomeAnchor(process.env, homedir()), ".zcode", "v2", "setting.json");
}

function extractBootstrapChromiumHardwareAccelerationEnabled(rawValue: unknown): boolean {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return true;
  }

  const enabled = (
    rawValue as {
      desktopChromiumHardwareAccelerationEnabled?: unknown;
    }
  ).desktopChromiumHardwareAccelerationEnabled;
  return typeof enabled === "boolean" ? enabled : true;
}

function readBootstrapChromiumHardwareAccelerationEnabledFromDisk(
  settingsFile: string = resolveChromiumHardwareAccelerationSettingsFile(),
): boolean {
  if (!existsSync(settingsFile)) {
    return true;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapChromiumHardwareAccelerationEnabled(JSON.parse(raw));
  } catch {
    return true;
  }
}

export function applyEarlyChromiumHardwareAccelerationBootstrap(
  app: ChromiumHardwareAccelerationApp,
  rawSettings?: unknown,
): boolean {
  const enabled =
    rawSettings === undefined
      ? readBootstrapChromiumHardwareAccelerationEnabledFromDisk()
      : extractBootstrapChromiumHardwareAccelerationEnabled(rawSettings);
  if (!enabled) {
    // Electron 只能在 app ready 前关闭 Chromium 硬件加速。
    // 因此设置页保存后必须在下一次 main 进程最早期读取并应用，不能等到 whenReady。
    app.disableHardwareAcceleration();
  }
  return enabled;
}
