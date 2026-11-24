import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { win32 } from "node:path";
import type { IntegratedTerminalShellOption } from "@zcode/shared";
import { discoverWindowsGitBash, type WindowsGitBashDiscoveryOptions } from "@zcode/shared/node";

// 本仓库定制：PowerShell 7 集成终端选项（上游只列出 CMD 与 Git Bash）。
const WINDOWS_PWSH_PATH_SEGMENTS = ["PowerShell", "7", "pwsh.exe"] as const;

export async function listIntegratedTerminalShellOptions(options: {
  env: NodeJS.ProcessEnv;
  gitBashDiscovery?: Omit<WindowsGitBashDiscoveryOptions, "env" | "platform" | "isExecutable">;
  isExecutable?: WindowsGitBashDiscoveryOptions["isExecutable"];
  platform: NodeJS.Platform;
}): Promise<IntegratedTerminalShellOption[]> {
  if (options.platform !== "win32") {
    return [];
  }

  const shellOptions: IntegratedTerminalShellOption[] = [createCommandPromptOption(options.env)];
  // 原来重复的固定目录/PATH 发现会漏掉非标准安装；共享发现修复漏检，选择与来源映射保持不变。
  const gitBash = await discoverWindowsGitBash({
    ...options.gitBashDiscovery,
    env: options.env,
    isExecutable: options.isExecutable,
    platform: options.platform,
  });
  if (gitBash) {
    shellOptions.push({
      dialect: "git-bash",
      id: `git-bash:${gitBash.path}`,
      label: "Git Bash",
      path: gitBash.path,
      source: gitBash.source,
    });
  }
  // 本仓库定制：追加 PowerShell 7 选项。
  const powershell = await resolveWindowsPowerShell(options.env, options.isExecutable);
  if (powershell) {
    shellOptions.push({
      dialect: "powershell",
      id: `powershell:${powershell.path}`,
      label: "PowerShell 7",
      path: powershell.path,
      source: powershell.source,
    });
  }

  return shellOptions;
}

function createCommandPromptOption(env: NodeJS.ProcessEnv): IntegratedTerminalShellOption {
  const path = getWindowsEnvValue(env, "ComSpec")?.trim() || "cmd.exe";
  return {
    dialect: "cmd",
    id: `cmd:${path}`,
    label: "CMD",
    path,
    source: "system",
  };
}

// 本仓库定制：PowerShell 7 发现。上游 4.0 把 Git Bash 的固定目录 / PATH / PATHEXT 辅助函数
// 收进了 @zcode/shared/node 的 discoverWindowsGitBash 并从本文件删除；pwsh 不在其职责内，
// 因此保留一份只服务 PowerShell 的最小实现。isExecutable 与共享发现同契约（可同步可异步）。
async function resolveWindowsPowerShell(
  env: NodeJS.ProcessEnv,
  isExecutable?: WindowsGitBashDiscoveryOptions["isExecutable"],
): Promise<{ path: string; source: "system" | "path" } | undefined> {
  for (const candidate of windowsPowerShellCandidatePaths(env)) {
    if (await isExecutableCandidate(candidate, isExecutable)) {
      return { path: candidate, source: "system" };
    }
  }

  for (const candidate of windowsExecutableCandidates("pwsh", env)) {
    if (await isExecutableCandidate(candidate, isExecutable)) {
      return { path: candidate, source: "path" };
    }
  }
  return undefined;
}

function windowsPowerShellCandidatePaths(env: NodeJS.ProcessEnv): string[] {
  // MSI 默认装在 %ProgramFiles%\PowerShell\7，用环境变量推导以兼容非 C 盘安装；
  // Microsoft Store 版没有固定文件路径，交由调用方的 PATH 扫描兜底。
  const roots = [
    getWindowsEnvValue(env, "ProgramFiles"),
    getWindowsEnvValue(env, "ProgramFiles(x86)"),
  ].filter((root): root is string => typeof root === "string" && root.trim().length > 0);
  return roots.map((root) => win32.normalize(win32.join(root, ...WINDOWS_PWSH_PATH_SEGMENTS)));
}

function windowsExecutableCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  if (/[\\/]/.test(command)) {
    return [command];
  }

  const pathValue = getWindowsEnvValue(env, "PATH");
  if (!pathValue) {
    return [command];
  }

  const extensions = windowsExecutableExtensions(env);
  return pathValue
    .split(win32.delimiter)
    .filter((entry) => entry.trim().length > 0)
    .flatMap((entry) => extensions.map((extension) => win32.join(entry, `${command}${extension}`)));
}

function windowsExecutableExtensions(env: NodeJS.ProcessEnv): string[] {
  const rawExtensions = getWindowsEnvValue(env, "PATHEXT")?.split(win32.delimiter) ?? [
    ".COM",
    ".EXE",
    ".BAT",
    ".CMD",
  ];
  const normalized = rawExtensions
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.length > 0);
  return normalized.includes(".exe") ? normalized : [".exe", ...normalized];
}

function getWindowsEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const lowerKey = key.toLowerCase();
  const match = Object.keys(env).find((envKey) => envKey.toLowerCase() === lowerKey);
  return match ? env[match] : undefined;
}

async function isExecutableCandidate(
  path: string,
  isExecutable?: WindowsGitBashDiscoveryOptions["isExecutable"],
): Promise<boolean> {
  try {
    return await (isExecutable ?? isExecutableFile)(path);
  } catch {
    return false;
  }
}

// 默认探测与共享发现同语义：可执行权限 + 普通文件。
async function isExecutableFile(path: string): Promise<boolean> {
  await access(path, constants.X_OK);
  return (await stat(path)).isFile();
}
