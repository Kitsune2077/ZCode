#!/usr/bin/env node

/**
 * 准备随包内置的 Office 转换引擎（@deepseek-ai/libreoffice-kit，dsoffice CLI）。
 *
 * 为什么内置：四个文档插件（docx/pptx/xlsx/pdf）的转换、渲染视觉验证与 xlsx 公式重算
 * 都依赖 LibreOffice。此前 skill 要求模型运行时现场下载安装（清华镜像/winget），公司内网
 * 无外网时整条质量闭环不可用。上游把 LibreOffice 预编译成 npm 平台引擎包（MPL-2.0，
 * win32-x64 解包约 199MB），随应用打包后运行时零下载——这正是 DeepSeek Harness 桌面版的
 * 分发方式。skill 侧只要求 `command -v dsoffice` 命中内置副本即可。
 *
 * 供应链：版本钉死（可用 ZCODE_LIBREOFFICE_KIT_VERSION 覆盖），用 npm --ignore-scripts
 * 安装闭包——kit 的原生引擎路径只 spawn 引擎包自带的 helper exe，不执行任何包脚本；
 * koffi（Windows 命名管道需要）的预编译 .node 由 registry 托管的 @koromix/koffi-<platform>
 * 平台包提供，loader 优先从兄弟包解析，同样不需要 install 脚本。所有包都经 registry
 * dist.integrity sha 校验，与"不能把无法验证的二进制放进安装包"的既有纪律一致。
 *
 * 产物：packages/desktop/bundled-tools/<platform-key>/libreoffice-kit/
 *   - dsoffice.cmd / dsoffice（shim：ELECTRON_RUN_AS_NODE 复用 app 自带 Electron Node）
 *   - libreoffice-kit-bundle.json（版本/来源元数据，幂等判断）
 *   - runtime/node_modules/（kit + 平台引擎 + koffi 闭包；node_modules 故意放在 runtime/
 *     子目录下——electron-builder 会过滤 extraResources from 根目录的 node_modules，
 *     koffi/sharp staging 的既有注释实证过这一行为）
 *
 * 打包时由 electron-builder 复制到 resources/tools/libreoffice-kit，运行时由 services 的
 * runtimeToolResolver 解析并把该目录追加进 Agent 的 PATH（工具 id "dsoffice"）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "./spawn-command.mjs";
import { getTargetPlatform } from "../packages/desktop/scripts/target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const TOOL_BASENAME = "libreoffice-kit";
const KIT_PACKAGE = "@deepseek-ai/libreoffice-kit";
// 钉死版本而不是跟随 latest：引擎是 199MB 级的二进制，必须逐版本人工验证后再升。
const DEFAULT_KIT_VERSION = "0.2.3";
const VERSION_ENV = "ZCODE_LIBREOFFICE_KIT_VERSION";
const SKIP_ENV = "ZCODE_SKIP_LIBREOFFICE_KIT";
const META_FILE_NAME = "libreoffice-kit-bundle.json";
// kit CLI 入口相对 runtime 目录（npm --prefix 根）的路径；shim 侧前缀 "$DIR/runtime/"。
const CLI_ENTRY_SEGMENTS = ["node_modules", "@deepseek-ai", "libreoffice-kit", "lib", "cli.js"];
const CLI_ENTRY_RELATIVE_TO_OUTPUT = ["runtime", ...CLI_ENTRY_SEGMENTS];
const REGISTRY_ENV_KEYS = ["npm_config_registry", "NPM_CONFIG_REGISTRY"];
const DEFAULT_REGISTRIES = ["https://registry.npmjs.org", "https://registry.npmmirror.com"];
// kit 的 optionalDependencies 按 os/cpu 自动选择；这里只登记"允许产出 bundle"的目标平台。
const ENGINE_PACKAGE_BY_PLATFORM_KEY = {
  "win32-x64": "@deepseek-ai/libreoffice-kit-win32-x64",
  "darwin-x64": "@deepseek-ai/libreoffice-kit-darwin-x64",
  "darwin-arm64": "@deepseek-ai/libreoffice-kit-darwin-arm64",
};
// Windows 原生引擎 helper 的 stdio 用受限令牌命名管道，koffi 必须在闭包内；
// koffi 3.x 的预编译 .node 来自 registry 托管的 @koromix/koffi-<platform>（optionalDeps
// 由 npm 按 os/cpu 自动选择），loader 按约定从 node_modules 根的兄弟包解析。
const KOROMIX_PACKAGE_BY_PLATFORM_KEY = {
  "win32-x64": "@koromix/koffi-win32-x64",
  "darwin-x64": "@koromix/koffi-darwin-x64",
  "darwin-arm64": "@koromix/koffi-darwin-arm64",
};

function resolveRegistryBases(env) {
  const configured = REGISTRY_ENV_KEYS.map((key) => env[key]?.trim()).find(Boolean);
  const seen = new Set();
  return [
    ...(configured ? [configured.replace(/\/+$/, "")] : []),
    ...DEFAULT_REGISTRIES,
  ].filter((base) => !seen.has(base) && seen.add(base));
}

/**
 * 优先用当前 node 同目录的 npm-cli.js 直调（node_modules/npm 布局），彻底绕开
 * Windows 对 PATH 上 npm.cmd 的 shell 解析；找不到再退回字面量 npm
 * （runCommand 会按 spawn-command.mjs 的既有规则交给 shell）。
 */
function resolveNpmInvocation() {
  const npmCliPath = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(npmCliPath)) {
    return { command: process.execPath, args: [npmCliPath] };
  }
  return { command: "npm", args: [] };
}

function installWithRegistryFallback({ installSpecs, registryBases, runtimeDir, cacheDir }) {
  const npm = resolveNpmInvocation();
  const failures = [];
  for (const registryBase of registryBases) {
    const args = [
      ...npm.args,
      "install",
      "--prefix", runtimeDir,
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--loglevel=warn",
      "--cache", cacheDir,
      "--registry", registryBase,
      ...installSpecs,
    ];
    try {
      runCommand(npm.command, args, { cwd: runtimeDir, env: process.env });
      return registryBase;
    } catch (error) {
      failures.push(`${registryBase}: ${String(error)}`);
    }
  }
  throw new Error(
    `npm install ${installSpecs.join(" ")} 在所有 registry 上失败：\n- ${failures.join("\n- ")}`,
  );
}

function readInstalledVersion(packageRoot) {
  try {
    return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))?.version ?? null;
  } catch {
    return null;
  }
}

function assertStagedClosure({ enginePackage, koromixPackage, runtimeDir }) {
  const modulesDir = join(runtimeDir, "node_modules");
  const kitRoot = join(modulesDir, "@deepseek-ai", "libreoffice-kit");
  const engineRoot = join(modulesDir, ...enginePackage.split("/"));
  const koromixRoot = join(modulesDir, ...koromixPackage.split("/"));
  const cliEntry = join(runtimeDir, ...CLI_ENTRY_SEGMENTS);

  for (const [label, path] of [
    [`kit CLI 入口 ${CLI_ENTRY_SEGMENTS.join("/")}`, cliEntry],
    [`kit 包目录（${KIT_PACKAGE}）`, kitRoot],
    [`平台引擎包目录（${enginePackage}）`, engineRoot],
    [`koffi 平台预编译包目录（${koromixPackage}）`, koromixRoot],
  ]) {
    if (!existsSync(path)) {
      throw new Error(`[prepare-libreoffice-kit] staging 后缺少 ${label}：${path}`);
    }
  }
  return { cliEntry, engineRoot, kitRoot, koromixRoot };
}

const SHIM_BODY_SH = `#!/bin/sh
# ZCode 随包内置的 dsoffice shim（prepare-bundled-libreoffice-kit.mjs 生成，勿手改）。
# 桌面打包布局下复用 app 自带的 Electron Node（ELECTRON_RUN_AS_NODE），与 Host 执行
# zcode.cjs 的方式一致；desktopRuntimeEnv 会优先注入 ZCODE_DSOFFICE_NODE_EXE。
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DSO_SCRIPT="$DIR/runtime/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js"
if [ -n "$ZCODE_DSOFFICE_NODE_EXE" ]; then
  DSO_NODE="$ZCODE_DSOFFICE_NODE_EXE"
elif [ -x "$DIR/../../../MacOS/ZCode" ]; then
  DSO_NODE="$DIR/../../../MacOS/ZCode"
elif [ -f "$DIR/../../../ZCode.exe" ]; then
  DSO_NODE="$DIR/../../../ZCode.exe"
elif command -v node >/dev/null 2>&1; then
  DSO_NODE=node
else
  echo "dsoffice: no usable Node runtime (set ZCODE_DSOFFICE_NODE_EXE)" >&2
  exit 127
fi
export ELECTRON_RUN_AS_NODE=1
exec "$DSO_NODE" "$DSO_SCRIPT" "$@"
`;

const SHIM_BODY_CMD = `@echo off
rem ZCode bundled dsoffice shim (generated by prepare-bundled-libreoffice-kit.mjs).
setlocal
set "DSO_SCRIPT=%~dp0runtime\\node_modules\\@deepseek-ai\\libreoffice-kit\\lib\\cli.js"
if defined ZCODE_DSOFFICE_NODE_EXE (
  set "DSO_NODE=%ZCODE_DSOFFICE_NODE_EXE%"
) else if exist "%~dp0..\\..\\..\\ZCode.exe" (
  set "DSO_NODE=%~dp0..\\..\\..\\ZCode.exe"
) else (
  set "DSO_NODE=node"
)
set "ELECTRON_RUN_AS_NODE=1"
"%DSO_NODE%" "%DSO_SCRIPT%" %*
endlocal & exit /b %ERRORLEVEL%
`;

function writeBundleMeta({
  kitRoot,
  enginePackage,
  engineRoot,
  koromixPackage,
  koromixRoot,
  outputDir,
  registryBase,
  requestedVersion,
}) {
  const stagedKitVersion = readInstalledVersion(kitRoot);
  const stagedEngineVersion = readInstalledVersion(engineRoot);
  const stagedKoromixVersion = readInstalledVersion(koromixRoot);
  writeFileSync(
    join(outputDir, META_FILE_NAME),
    `${JSON.stringify(
      {
        cliEntry: CLI_ENTRY_RELATIVE_TO_OUTPUT.join("/"),
        engine: { package: enginePackage, version: stagedEngineVersion },
        koffiBridge: { package: koromixPackage, version: stagedKoromixVersion },
        kit: { package: KIT_PACKAGE, version: stagedKitVersion, requestedVersion },
        license: "MPL-2.0（引擎随包携带 sources/ 与 licenses/，未裁剪）",
        registryBase,
        // 供应链：npm 安装即完成 registry dist.integrity sha 校验；这里的摘要供追溯比对。
        upstream: "https://github.com/deepseek-ai/dsh-libreoffice-kit",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return stagedKitVersion;
}

function readExistingMeta(metaPath) {
  try {
    return JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  if (process.env[SKIP_ENV] === "1") {
    console.log(`==> 跳过 Office 转换引擎内置（${SKIP_ENV}=1）`);
    return;
  }

  const target = getTargetPlatform();
  const enginePackage = ENGINE_PACKAGE_BY_PLATFORM_KEY[target.key];
  const koromixPackage = KOROMIX_PACKAGE_BY_PLATFORM_KEY[target.key];
  if (!enginePackage || !koromixPackage) {
    // 上游未发布该平台的预编译引擎（Linux 走 wasm 包，体积与验证成本另评估）时明确跳过，
    // 不产残缺 bundle；skill 侧的降级链会继续用系统 soffice 或如实报告不可用。
    console.log(
      `==> 跳过 Office 转换引擎内置：上游未提供 ${target.key} 的预编译引擎（skill 走降级链）`,
    );
    return;
  }

  const requestedVersion = process.env[VERSION_ENV]?.trim() || DEFAULT_KIT_VERSION;
  const outputDir = join(rootDir, "packages", "desktop", "bundled-tools", target.key, TOOL_BASENAME);
  const runtimeDir = join(outputDir, "runtime");
  const metaPath = join(outputDir, META_FILE_NAME);
  const cliEntry = join(runtimeDir, ...CLI_ENTRY_SEGMENTS);

  const existing = readExistingMeta(metaPath);
  if (
    existing?.kit?.version === requestedVersion &&
    existsSync(cliEntry) &&
    existsSync(join(runtimeDir, "node_modules", ...enginePackage.split("/"), "prebuilds.json"))
  ) {
    console.log(`    [skip] ${KIT_PACKAGE}@${requestedVersion} 已就绪（${target.key}）`);
    return;
  }
  if (existing) {
    console.log(`    [repair] bundle 元数据或产物缺失，重新准备：${outputDir}`);
  }

  console.log("==> Preparing bundled Office conversion engine (dsoffice)");
  console.log(`    target  : ${target.key}`);
  console.log(
    `    version : ${requestedVersion}${process.env[VERSION_ENV]?.trim() ? ` (${VERSION_ENV} 指定)` : " (钉死默认)"}`,
  );
  console.log(`    output  : ${outputDir}`);

  rmSync(outputDir, { force: true, recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  // npm install 需要一个包根；private 包避免被误发布，也避免 npm 在无 package.json 时的隐式行为。
  writeFileSync(
    join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: "zcode-bundled-dsoffice-runtime", private: true }, null, 2)}\n`,
    "utf8",
  );

  const registryBase = installWithRegistryFallback({
    cacheDir: join(rootDir, "node_modules", ".cache", "zcode-bundled-dsoffice"),
    installSpecs: [`${KIT_PACKAGE}@${requestedVersion}`],
    registryBases: resolveRegistryBases(process.env),
    runtimeDir,
  });

  const staged = assertStagedClosure({ enginePackage, koromixPackage, runtimeDir });
  const stagedKitVersion = writeBundleMeta({
    ...staged,
    enginePackage,
    koromixPackage,
    outputDir,
    registryBase,
    requestedVersion,
  });
  if (stagedKitVersion !== requestedVersion) {
    throw new Error(
      `[prepare-libreoffice-kit] 版本不匹配：请求 ${requestedVersion}，staging 得到 ${stagedKitVersion}`,
    );
  }

  writeFileSync(join(outputDir, "dsoffice"), SHIM_BODY_SH, { mode: 0o755 });
  writeFileSync(join(outputDir, "dsoffice.cmd"), SHIM_BODY_CMD);
  console.log(`    [shim]  dsoffice / dsoffice.cmd -> ${join(outputDir, "dsoffice")}`);
  console.log(`    [done]  registry=${registryBase}`);
}

try {
  await main();
} catch (error) {
  console.error(`[prepare-libreoffice-kit] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
