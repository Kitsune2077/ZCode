import { spawnSync } from "node:child_process";

const windowsShellCommandPattern = /\.(cmd|bat)$/i;
const windowsShellCommandNames = new Set(["npm", "pnpm"]);

export function resolveSpawnRuntimeOptions(command, platform = process.platform) {
  if (
    platform === "win32" &&
    (windowsShellCommandPattern.test(command) || windowsShellCommandNames.has(command))
  ) {
    return {
      // Windows runner 上 bare `pnpm` / `npm` 实际也是通过 cmd shim 提供。
      // 之前先把命令名改写成 `pnpm.cmd`，会让部分 `pnpm exec` 场景重新落回错误的包 cwd，
      // 最终把 tsup 入口解析成 scripts/src/... 并报“Cannot find src/main/index.ts”。
      // 这里保留原始命令名，只要求 shell/cmd.exe 负责解析 shim，避免再次改变 pnpm 的包上下文。
      shell: true,
    };
  }

  return {};
}

/**
 * 把字面量 `pnpm` 重写为当前正在运行的 pnpm 入口，返回新的 command/args。
 *
 * bug 原因：Windows 下子进程 cmd 按字面量在 PATH 里解析 `pnpm` / `pnpm.cmd`；
 * 用户终端的 pnpm 形态各异（npm 全局装的是 pnpm.cmd，standalone 安装只有
 * pnpm.exe，corepack / mise shim 又不同），PATH 状态解析不到时 dev:desktop 在
 * 多层脚本里反复报 “'pnpm' 不是内部或外部命令”。
 *
 * 修复依据：pnpm 执行生命周期脚本时会把自身入口的绝对路径写入 `npm_execpath`；
 * 这些脚本都由 `pnpm run` 拉起，直接复用同一份 pnpm 即可完全绕开 PATH 解析：
 * exe/com 绝对路径直接 spawn；JS 入口（.cjs/.mjs）用当前 node 运行；
 * .cmd/.bat shim 保留原样交给 resolveSpawnRuntimeOptions 开 shell（路径含空格
 * 时由 runCommand 补引号）。只重写字面量 "pnpm"：调用方显式传绝对路径或其它
 * 命令时不介入；无 npm_execpath（直接 node 调用）时退回原有 PATH 解析。
 */
function resolvePnpmInvocation(command, args) {
  if (command !== "pnpm") {
    return { command, args };
  }
  const execPath = process.env.npm_execpath?.trim();
  if (!execPath) {
    return { command, args };
  }
  if (/\.(exe|com|cmd|bat)$/i.test(execPath)) {
    return { command: execPath, args };
  }
  return { command: process.execPath, args: [execPath, ...args] };
}

// shell:true 时 Node 只把 args 按空格拼接进命令行、不做转义（对应 DEP0190 警告）。
// Windows 上仓库路径含空格时（如 E:\Z Code\...），pnpm --dir 的路径会被 cmd 按空格
// 截断成 E:\Z 并报 ENOENT: lstat。这里按 cmd.exe 规则给含空格的参数补双引号；
// 无空格参数保持原样，不影响现有无空格路径与 CI 行为。
export function quoteArgsForWindowsShell(args) {
  return args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg));
}

// 命令本体（如 npm_execpath 解析出的绝对路径）在 shell:true 拼接时同样可能含空格。
function quoteWindowsShellCommand(command) {
  return /\s/.test(command) ? `"${command}"` : command;
}

function resolveSpawnInvocation(command, args) {
  const invocation = resolvePnpmInvocation(command, args);
  const runtimeOptions = resolveSpawnRuntimeOptions(invocation.command);
  const spawnCommand = runtimeOptions.shell
    ? quoteWindowsShellCommand(invocation.command)
    : invocation.command;
  const spawnArgs = runtimeOptions.shell ? quoteArgsForWindowsShell(invocation.args) : invocation.args;
  return { spawnCommand, spawnArgs, runtimeOptions, command: invocation.command, args: invocation.args };
}

export function runCommand(command, args, options = {}) {
  const spawnInvocation = resolveSpawnInvocation(command, args);
  const result = spawnSync(spawnInvocation.spawnCommand, spawnInvocation.spawnArgs, {
    stdio: "inherit",
    ...options,
    ...spawnInvocation.runtimeOptions,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(
      `${spawnInvocation.command} ${spawnInvocation.args.join(" ")} failed with code ${result.status}`,
    );
  }

  return result;
}

export function runCommandAndReadStdout(command, args, options = {}) {
  const spawnInvocation = resolveSpawnInvocation(command, args);
  const result = spawnSync(spawnInvocation.spawnCommand, spawnInvocation.spawnArgs, {
    encoding: "utf8",
    ...options,
    ...spawnInvocation.runtimeOptions,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(
      `${spawnInvocation.command} ${spawnInvocation.args.join(" ")} failed with code ${result.status}`,
    );
  }

  return result.stdout;
}
