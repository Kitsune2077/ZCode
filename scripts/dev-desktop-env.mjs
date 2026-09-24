import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { withPinnedNodePath } from "./mise-toolchain-env.mjs";
import { quoteArgsForWindowsShell } from "./spawn-command.mjs";

const requestedEnv = process.argv[2]?.trim().toLowerCase();
const agentBytecode = process.argv.slice(3).includes("--agent-bytecode");
if (requestedEnv !== "test" && requestedEnv !== "production") {
  console.error("Usage: node scripts/dev-desktop-env.mjs <test|production> [--agent-bytecode]");
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 解析本次应该使用的 pnpm 入口。
 *
 * bug 原因：这里原来在 Windows 硬编码 `pnpm.cmd`，依赖子进程 cmd 在 PATH 里解析该
 * 字面量。用户终端的 pnpm 形态各不相同（npm 全局安装有 pnpm.cmd；standalone 安装只有
 * pnpm.exe；corepack / mise shim 又是别的形态），PATH 解析不到 pnpm.cmd 时第一步
 * `pnpm --filter ... pre-dev` 就报 "'pnpm.cmd' 不是内部或外部命令"。
 *
 * 修复依据：pnpm 执行生命周期脚本时会把自己入口的绝对路径写入 `npm_execpath`
 * （`pnpm run` 链路必然存在，本脚本正是被 `pnpm run dev:desktop:prod` 拉起的）。
 * 直接复用同一份 pnpm：JS 入口用当前 node 运行、exe 入口绝对路径直接 spawn，
 * 两者都不再经过 cmd 的 PATH 解析。
 */
function resolvePnpmInvocation() {
  const execPath = process.env.npm_execpath?.trim();
  if (!execPath) {
    // 直接 `node scripts/dev-desktop-env.mjs` 调用时没有 npm_execpath，退回 PATH 解析。
    return {
      command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      args: [],
      shell: process.platform === "win32",
    };
  }
  if (/\.(exe|com)$/i.test(execPath)) {
    // standalone pnpm.exe：绝对路径直接 spawn，含空格也无需 cmd 拼接转义。
    return { command: execPath, args: [], shell: false };
  }
  if (/\.(cmd|bat)$/i.test(execPath)) {
    // .cmd/.bat shim：必须经 cmd 执行；绝对路径可能含空格，由 run() 统一补引号。
    return { command: execPath, args: [], shell: process.platform === "win32" };
  }
  // .cjs/.mjs/.js 入口（npm 安装 / corepack 形态）：用当前 node 运行。
  return { command: process.execPath, args: [execPath], shell: false };
}

const pnpmInvocation = resolvePnpmInvocation();

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const useShell = options.shell ?? (process.platform === "win32");
    // Windows 下 shell:true 只按空格拼接命令行；仓库路径含空格（如 E:\Z Code\...）时
    // node <script> 的脚本路径会被 cmd 截断成 E:\Z 并报 Cannot find module，因此先补引号。
    // 命令本身（如绝对路径的 pnpm.cmd）同样按此规则处理。
    const needsQuoting = useShell && process.platform === "win32";
    const spawnArgs = needsQuoting ? quoteArgsForWindowsShell(args) : args;
    const spawnCommand = needsQuoting && /\s/.test(command) ? `"${command}"` : command;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: repoRoot,
      env: withPinnedNodePath(
        {
          ...process.env,
          ZCODE_ENV: requestedEnv,
          ZCODE_DESKTOP_AGENT_BYTECODE: agentBytecode ? "1" : "0",
        },
        process.execPath,
      ),
      stdio: "inherit",
      // Windows .cmd/.bat executables (pnpm.cmd, npm.cmd, etc.) require shell: true
      shell: useShell,
    });

    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          signal
            ? `${command} exited with signal ${signal}`
            : `${command} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

try {
  // The public dev scripts delegate here instead of invoking the package's
  // `dev` lifecycle directly, so pnpm will not run `pre-dev` automatically.
  // Preserve its runtime-asset preparation and stale `out` cleanup explicitly
  // before rebuilding bundles or starting Electron.
  await run(pnpmInvocation.command, [...pnpmInvocation.args, "--filter", "@zcode/desktop", "pre-dev"], {
    shell: pnpmInvocation.shell,
  });
  // On Windows, use "node" (resolved via PATHEXT) to avoid "C:\Program Files\..." space issues
  await run(process.platform === "win32" ? "node" : process.execPath, [
    resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs"),
  ]);
  if (agentBytecode) {
    await run(process.platform === "win32" ? "node" : process.execPath, [
      resolve(repoRoot, "scripts/build-desktop-agent-bytecode.mjs"),
    ]);
  }
  await run(pnpmInvocation.command, [...pnpmInvocation.args, "--filter", "@zcode/desktop", "dev:runtime"], {
    shell: pnpmInvocation.shell,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
