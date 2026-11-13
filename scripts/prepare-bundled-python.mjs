#!/usr/bin/env node

/**
 * 准备随包内置的最小 Python 创作环境（CPython + Office 创作/PDF 库）。
 *
 * 为什么内置：四个文档插件（docx/pptx/xlsx/pdf）的创作脚本依赖 `python3` 与一批 pip 包。
 * 此前只靠系统 Python：公司内网无外网时 pip 装不了包，创建/编辑/校验链路直接断。参照
 * DeepSeek Harness 的"锁定运行时 + 锁定库 + 校验 + 可离线预置"思路，把解释器与库随包
 * 分发，运行时零下载；skill 里的 `command -v python3` 与 `python3 -c "import openpyxl"`
 * 因此直接命中内置副本。
 *
 * 供应链：
 *   - CPython 取自 python-build-standalone（PSF-2.0）的 install_only 归档；
 *     release tag、每平台资产名与 sha256 钉死在 scripts/python-runtime-lock.json。
 *   - wheel 集同样是"包名 + 版本 + 每平台 sha256"锁定；下载后逐字节校验，
 *     pip 以 --no-deps 安装锁定文件，不做运行时版本解析。
 *   - 刻意不含 PyMuPDF（AGPL-3.0）：PDF 页面渲染由 dsoffice 承担。
 *
 * 产物：packages/desktop/bundled-tools/<platform-key>/python/
 *   - python3 / python3.cmd / python / python.cmd（shim：清理 PYTHONHOME/PYTHONPATH，
 *     禁用 user site，保证不会误用宿主编译器环境）
 *   - python-runtime-bundle.json（版本/来源/归档 sha256/包清单，幂等判断）
 *   - licenses/（CPython 与各 wheel 随包许可原文）
 *   - runtime/（CPython 树 + site-packages）
 *
 * 打包时由 electron-builder 复制到 resources/tools/python，运行时由 services 的
 * runtimeToolResolver 解析并把该目录追加进 Agent 的 PATH（工具 id "python"）。
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  downloadPrebuiltArchive,
  verifyPrebuiltArchiveSha256,
} from "./prebuilt-binary-download.mjs";
import { extractPrebuiltArchive } from "./prebuilt-binary-extract.mjs";
import { runCommand } from "./spawn-command.mjs";
import { spawnSync } from "node:child_process";
import { getTargetPlatform } from "../packages/desktop/scripts/target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const LOCK_FILE = "python-runtime-lock.json";
const TOOL_BASENAME = "python";
const META_FILE_NAME = "python-runtime-bundle.json";
const SKIP_ENV = "ZCODE_SKIP_PYTHON";
const RELEASE_BASE = "https://github.com/astral-sh/python-build-standalone/releases/download";
// pip 解析 wheel 需要的目标三元组；与 lock 里的平台键一一对应。
const PIP_PLATFORM_BY_KEY = {
  "win32-x64": "win_amd64",
  "darwin-arm64": "macosx_11_0_arm64",
  "darwin-x64": "macosx_10_15_x86_64",
};
// 可在运行时裁剪掉的 CPython 附带内容（测试套件、GUI、头文件与静态库）。
const TRIMMED_RUNTIME_SEGMENTS = [
  ["Lib", "test"],
  ["Lib", "idlelib"],
  ["Lib", "tkinter"],
  ["tcl"],
  ["include"],
  ["libs"],
];
// 导入断言：必须全部通过，否则说明 wheel 没装全或平台不匹配。
const REQUIRED_IMPORTS = [
  "docx",
  "pptx",
  "openpyxl",
  "xlsxwriter",
  "defusedxml",
  "PIL",
  "lxml",
  "pypdf",
  "reportlab",
  "pdfplumber",
  "pikepdf",
];

function readLock() {
  return JSON.parse(readFileSync(resolve(scriptDir, LOCK_FILE), "utf8"));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readExistingMeta(metaPath) {
  try {
    return JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

/** wheel 文件名 -> { name, version }；name 归一化为 PyPI 风格（下划线转连字符）。 */
function parseWheelFilename(filename) {
  const [distribution, version] = filename.replace(/\.whl$/, "").split("-");
  return { name: distribution.replaceAll("_", "-"), version };
}

function resolveRuntimePaths(target, pythonVersion) {
  const pythonTag = `python${pythonVersion.split(".").slice(0, 2).join(".")}`;
  const outputDir = join(rootDir, "packages", "desktop", "bundled-tools", target.key, TOOL_BASENAME);
  const runtimeDir = join(outputDir, "runtime");
  const sitePackages =
    target.os === "win32"
      ? join(runtimeDir, "Lib", "site-packages")
      : join(runtimeDir, "lib", pythonTag, "site-packages");
  const interpreter =
    target.os === "win32" ? join(runtimeDir, "python.exe") : join(runtimeDir, "bin", "python3");
  const sitePackagesRelative =
    target.os === "win32"
      ? `runtime/Lib/site-packages`
      : `runtime/lib/${pythonTag}/site-packages`;
  return { outputDir, runtimeDir, sitePackages, sitePackagesRelative, interpreter };
}

function shimName(target) {
  return target.os === "win32" ? "python3.cmd" : "python3";
}

function pythonShimBody(target, sitePackagesRelative) {
  // 关键点：清掉继承的 PYTHONHOME 并禁用 user site；PYTHONPATH 显式指向随包 site-packages
  // （relocatable 构建的 sysconfig purelib 未必等于该目录，靠它保证 skill import 命中内置库）。
  // 不要加 -E/-I，以免丢掉 ZCode 注入的 PYTHONUTF8/PYTHONIOENCODING（中文输出依赖它）。
  const interpreter =
    target.os === "win32" ? "$DIR/runtime/python.exe" : "$DIR/runtime/bin/python3";
  return `#!/bin/sh
# ZCode 随包 Python shim（prepare-bundled-python.mjs 生成，勿手改）。
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
unset PYTHONHOME
PYTHONNOUSERSITE=1
export PYTHONNOUSERSITE
PYTHONPATH="$DIR/${sitePackagesRelative}"
export PYTHONPATH
exec "${interpreter}" "$@"
`;
}

function pythonCmdShimBody(sitePackagesRelative) {
  return `@echo off
rem ZCode bundled Python shim (generated by prepare-bundled-python.mjs).
setlocal
set "PYTHONHOME="
set "PYTHONPATH=%~dp0${sitePackagesRelative.replaceAll("/", "\\")}"
set "PYTHONNOUSERSITE=1"
"%~dp0runtime\\python.exe" %*
endlocal & exit /b %ERRORLEVEL%
`;
}

/** 下载并解包 CPython；返回解包出的 python 目录（install_only 归档内层为 python/）。 */
async function stageInterpreter({ asset, release, workDir, runtimeDir, target }) {
  const assetUrl = `${RELEASE_BASE}/${release}/${asset.name}`;
  const archivePath = join(workDir, asset.name);
  console.log(`    cpython : ${asset.name}`);
  await downloadPrebuiltArchive(assetUrl, archivePath);
  verifyPrebuiltArchiveSha256(archivePath, asset.sha256);
  const extractDir = join(workDir, "cpython");
  mkdirSync(extractDir, { recursive: true });
  extractPrebuiltArchive({
    archiveExt: "tar.gz",
    archivePath,
    extractDir,
    cwd: workDir,
  });
  const extractedRoot = join(extractDir, "python");
  if (!existsSync(extractedRoot)) {
    throw new Error(`[prepare-python] 归档内未找到 python/ 目录：${asset.name}`);
  }
  mkdirSync(runtimeDir, { recursive: true });
  cpSync(extractedRoot, runtimeDir, { recursive: true });
  console.log(`    [extract] ${basename(extractedRoot)} -> ${runtimeDir}`);
  return { assetUrl, archiveSha256: asset.sha256 };
}

function assertBundledPip(interpreter) {
  try {
    runCommand(interpreter, ["-m", "pip", "--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function resolvePipPython(interpreter) {
  if (assertBundledPip(interpreter)) return interpreter;
  // install_only 归档通常自带 pip；万一缺失，用宿主 python 下载/安装（wheel 是目标平台的，
  // 安装目标目录也与宿主解释器无关）。
  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  for (const candidate of candidates) {
    try {
      runCommand(candidate, ["-m", "pip", "--version"], { stdio: "pipe" });
      console.log(`    [warn] 内置解释器缺 pip，改用宿主 ${candidate} 安装 wheel`);
      return candidate;
    } catch {
      // 继续尝试下一个候选
    }
  }
  throw new Error("[prepare-python] 内置解释器与宿主都没有可用的 pip");
}

function buildRequirements({ platformWheels, requirementsPath }) {
  const lines = [];
  const byNameVersion = new Map();
  for (const [filename, hash] of Object.entries(platformWheels)) {
    const { name, version } = parseWheelFilename(filename);
    const key = `${name}==${version}`;
    const entry = byNameVersion.get(key) ?? { hashes: [] };
    entry.hashes.push(hash);
    byNameVersion.set(key, entry);
  }
  for (const [key, entry] of [...byNameVersion.entries()].sort()) {
    // 同一 name/version 可能有多个 wheel（不同 abi），hash 全部列出，pip 会选当前平台的。
    lines.push(`${key} ${entry.hashes.map((hash) => `--hash=sha256:${hash}`).join(" ")}`);
  }
  writeFileSync(requirementsPath, `${lines.join("\n")}\n`, "utf8");
  return byNameVersion.size;
}

function stageWheels({ pipPython, pipPlatform, platformWheels, requirementsPath, wheelsDir }) {
  // PyPI 索引默认走清华镜像：runner（国内、无代理）直连 pypi.org /
  // files.pythonhosted.org 下载 win_amd64 wheel 会间歇性失败
  // （Gitea run 61 实测：pip download 78 秒后失败，且 stdio: pipe 把
  // pip 的真实报错吞了）。镜像可用 ZCODE_PYPI_INDEX 覆盖。
  const index = process.env.ZCODE_PYPI_INDEX?.trim() || "https://pypi.tuna.tsinghua.edu.cn/simple";
  runCommand(
    pipPython,
    [
      "-m", "pip", "download",
      "--only-binary=:all:",
      "--platform", pipPlatform,
      "--python-version", "3.12",
      "--implementation", "cp",
      "--abi", "cp312",
      "--require-hashes",
      "--no-cache-dir",
      "--dest", wheelsDir,
      // 与 --require-hashes 组合使用时 pip 要求索引声明走 -i；
      // 镜像完整镜像了 pypi.org 的 wheel 与元数据。
      "--index-url", index,
      "-r", requirementsPath,
    ],
    // stdio: inherit——pip 的报错必须原样进 job 日志；pipe 会吞掉失败原因。
    { stdio: "inherit" },
  );
  // 下载结果的摘要必须与锁文件一致；不一致说明上游重发或解析跑偏，必须失败。
  const downloaded = readdirSync(wheelsDir).filter((file) => file.endsWith(".whl"));
  for (const file of downloaded) {
    const expected = platformWheels[file];
    if (!expected) throw new Error(`[prepare-python] 下载到锁文件之外的 wheel：${file}`);
    const actual = sha256File(join(wheelsDir, file));
    if (actual !== expected) {
      throw new Error(`[prepare-python] wheel sha256 不匹配：${file}\n  期望 ${expected}\n  实际 ${actual}`);
    }
  }
  const missing = Object.keys(platformWheels).filter((file) => !downloaded.includes(file));
  if (missing.length > 0) {
    throw new Error(`[prepare-python] 缺少锁定的 wheel：${missing.join(", ")}`);
  }
  console.log(`    wheels  : ${downloaded.length} 个（sha256 全部匹配）`);
}

function installWheels({ pipPython, pipPlatform, wheelsDir, sitePackages }) {
  mkdirSync(sitePackages, { recursive: true });
  const wheels = readdirSync(wheelsDir)
    .filter((file) => file.endsWith(".whl"))
    .map((file) => join(wheelsDir, file));
  runCommand(
    pipPython,
    [
      "-m", "pip", "install",
      "--no-index",
      "--no-deps",
      "--no-compile",
      "--no-cache-dir",
      "--disable-pip-version-check",
      // 交叉打包必须显式声明目标平台：宿主 python3 装异平台 wheel 会被 pip 判
      // "is not a supported wheel on this platform"（Gitea run 62 实测，Linux
      // 宿主装 win_amd64 轮子；本机 A/B 对照实验：不加 --platform 失败、加上成功）。
      // --platform 与 --target/--no-deps 组合受支持；轮子已本地下载，--no-index 不触网。
      "--only-binary=:all:",
      "--platform", pipPlatform,
      "--python-version", "3.12",
      "--implementation", "cp",
      "--abi", "cp312",
      "--target", sitePackages,
      ...wheels,
    ],
    // stdio: inherit——pip 的报错必须原样进 job 日志；pipe 会吞掉失败原因。
    { stdio: "inherit" },
  );
  console.log(`    [install] ${wheels.length} wheels -> ${sitePackages}`);
}

function trimRuntime(runtimeDir) {
  for (const segments of TRIMMED_RUNTIME_SEGMENTS) {
    rmSync(join(runtimeDir, ...segments), { force: true, recursive: true });
  }
  const removePycache = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__") {
          rmSync(full, { force: true, recursive: true });
        } else {
          removePycache(full);
        }
      } else if (entry.name.endsWith(".pdb")) {
        rmSync(full, { force: true });
      }
    }
  };
  removePycache(runtimeDir);
}

/**
 * 静态校验：site-packages 下每个必需模块的顶层条目存在（目录含 __init__.py，
 * 或 <name>.py / <name>*.pyd / <name>*.so）。
 * 交叉构建用——目标平台的解释器在宿主上无法执行（Windows PE 在 Linux 上
 * 报 "MZ...: not found"），只能核对 wheel 是否真的装进了正确目录。
 */
function verifyImportsStatically(sitePackages) {
  const entries = readdirSync(sitePackages);
  const missing = [];
  for (const name of REQUIRED_IMPORTS) {
    const found =
      entries.includes(name) ||
      entries.includes(`${name}.py`) ||
      entries.some(
        (entry) =>
          (entry.startsWith(`${name}.`) || entry.startsWith(`${name}-`)) &&
          /\.(pyd|so)$/u.test(entry),
      );
    if (!found) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(
      `[prepare-python] 静态校验缺模块：${missing.join(", ")}` +
        `\n  sitePackages=${sitePackages}\n  entries: ${entries.slice(0, 30).join(", ")}`,
    );
  }
  console.log(
    `    [verify] 交叉构建：跳过运行时 import 探针，静态校验通过（${REQUIRED_IMPORTS.length} 个模块目录存在）`,
  );
}

function verifyImports({ interpreter, sitePackages, target }) {
  // 交叉构建时内置解释器是目标平台的二进制（Linux 宿主上跑 win32 的 python.exe
  // 会报 "MZ...: not found"，Gitea run 63 实测），只能做静态校验；
  // 同平台构建（Windows/macOS 开发机）仍跑真实 import，覆盖 DLL/重定位问题。
  if (target.os !== process.platform) {
    verifyImportsStatically(sitePackages);
    return;
  }
  // 逐模块校验：合并成一条 import 时，任一失败只会得到 "code 1"，无法定位是哪个包、
  // 也不会显示 stderr（macOS 首跑就因此只看到 failed with code 1）。这里单独跑并回传 stderr。
  for (const name of REQUIRED_IMPORTS) {
    const result = spawnSync(interpreter, ["-c", `import ${name}`], {
      encoding: "utf8",
      // 与 shim 同语义：让校验看到的就是 skill 运行时的 sys.path。
      env: { ...process.env, PYTHONPATH: sitePackages, PYTHONNOUSERSITE: "1" },
    });
    if (result.error) {
      throw new Error(`[prepare-python] 无法启动内置解释器校验 import ${name}：${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "").trim().split(/\r?\n/).slice(-6).join(" | ");
      // macOS 的 install_only 归档是 relocatable 构建，site-packages 是否进入 sys.path
      // 取决于前缀重定位；失败时把 sys.path、purelib 与安装目录内容打印出来，避免盲猜。
      const probe = spawnSync(
        interpreter,
        [
          "-c",
          "import sys,sysconfig; print('sys.path=',sys.path); print('purelib=',sysconfig.get_paths().get('purelib'))",
        ],
        { encoding: "utf8" },
      );
      let installed = "<unreadable>";
      try {
        installed = readdirSync(sitePackages).slice(0, 30).join(", ");
      } catch (error) {
        installed = `<unreadable: ${String(error)}>`;
      }
      throw new Error(
        `[prepare-python] import ${name} 失败（exit ${result.status}）：${detail}` +
          `\n  probe: ${(probe.stdout || probe.stderr || "").trim()}` +
          `\n  sitePackages=${sitePackages}\n  entries: ${installed}`,
      );
    }
  }
  console.log(`    [verify] import 通过：${REQUIRED_IMPORTS.join(", ")}`);
}

/** 收集 CPython 与各 wheel 的许可原文，随包保留（与 lark-cli 同级做法）。 */
function stageLicenses({ runtimeDir, sitePackages, outputDir }) {
  const licensesDir = join(outputDir, "licenses");
  rmSync(licensesDir, { force: true, recursive: true });
  mkdirSync(licensesDir, { recursive: true });

  const recorded = [];
  // CPython 归档里叫 LICENSE.txt；不同平台归档可能是 LICENSE / LICENCE，按候选依次找。
  const cpythonLicense = ["LICENSE.txt", "LICENSE", "LICENCE"].map((name) =>
    join(runtimeDir, name),
  ).find((candidate) => existsSync(candidate));
  if (cpythonLicense) {
    cpSync(cpythonLicense, join(licensesDir, "CPython-LICENSE.txt"));
    recorded.push({ component: "CPython", file: "CPython-LICENSE.txt" });
  }
  for (const entry of readdirSync(sitePackages, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".dist-info")) continue;
    const distInfo = join(sitePackages, entry.name);
    for (const file of readdirSync(distInfo, { recursive: true })) {
      const name = String(file);
      if (!/(^|[/\\])(LICENSE|LICENCE|COPYING|NOTICE)/i.test(name)) continue;
      if (statSync(join(distInfo, name)).isDirectory()) continue;
      const targetName = `${entry.name.replace(/\.dist-info$/, "")}${name.includes("/") || name.includes("\\") ? `-${name.replaceAll(/[/\\]/g, "-")}` : `-${name}`}`;
      cpSync(join(distInfo, name), join(licensesDir, targetName));
      recorded.push({ component: entry.name.replace(/\.dist-info$/, ""), file: targetName });
    }
  }
  return recorded;
}

function writeBundleMeta({ metaPath, lock, target, licenseRecords, wheels }) {
  const packages = wheels.map((filename) => {
    const { name, version } = parseWheelFilename(filename);
    return { name, version };
  });
  writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        cpython: {
          release: lock.cpython.release,
          version: lock.cpython.version,
          asset: lock.cpython.assets[target.key].name,
          archiveSha256: lock.cpython.assets[target.key].sha256,
        },
        interpreter: shimName(target),
        license: "PSF-2.0（CPython）+ 各 wheel 原始许可，见 licenses/",
        packages: packages.sort((a, b) => a.name.localeCompare(b.name)),
        upstream: "https://github.com/astral-sh/python-build-standalone",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function main() {
  if (process.env[SKIP_ENV] === "1") {
    console.log(`==> 跳过 Python 创作环境内置（${SKIP_ENV}=1）`);
    return;
  }

  const target = getTargetPlatform();
  const lock = readLock();
  const asset = lock.cpython.assets[target.key];
  const platformWheels = lock.packages[target.key];
  const pipPlatform = PIP_PLATFORM_BY_KEY[target.key];
  if (!asset || !platformWheels || !pipPlatform) {
    console.log(
      `==> 跳过 Python 创作环境内置：未声明 ${target.key} 的 CPython 资产或 wheel 锁（skill 走系统 Python）`,
    );
    return;
  }
  const { outputDir, runtimeDir, sitePackages, sitePackagesRelative, interpreter } =
    resolveRuntimePaths(target, lock.cpython.version);
  const metaPath = join(outputDir, META_FILE_NAME);
  const existing = readExistingMeta(metaPath);
  // 幂等只看元数据版本 + 解释器 + site-packages；导入断言属于构建期校验，不在此重复。
  if (
    existing?.cpython?.archiveSha256 === asset.sha256 &&
    existsSync(interpreter) &&
    existsSync(sitePackages)
  ) {
    console.log(`    [skip] CPython ${lock.cpython.version} + wheels 已就绪（${target.key}）`);
    return;
  }
  if (existing) {
    console.log(`    [repair] 元数据或产物缺失，重新准备：${outputDir}`);
  }

  console.log("==> Preparing bundled Python authoring runtime");
  console.log(`    target  : ${target.key}`);
  console.log(`    cpython : ${lock.cpython.version} (release ${lock.cpython.release})`);
  console.log(`    output  : ${outputDir}`);

  rmSync(outputDir, { force: true, recursive: true });
  mkdirSync(runtimeDir, { recursive: true });

  const workDir = mkdtempSync(join(tmpdir(), "zcode-python-runtime-"));
  try {
    await stageInterpreter({ asset, release: lock.cpython.release, workDir, runtimeDir, target });
    const pipPython = resolvePipPython(interpreter);
    const requirementsPath = join(workDir, "requirements.lock.txt");
    const wheelCount = buildRequirements({ platformWheels, requirementsPath });
    const wheelsDir = join(workDir, "wheels");
    mkdirSync(wheelsDir, { recursive: true });
    stageWheels({ pipPython, pipPlatform, platformWheels, requirementsPath, wheelsDir });
    installWheels({ pipPython, pipPlatform, wheelsDir, sitePackages });
    trimRuntime(runtimeDir);
    verifyImports({ interpreter, sitePackages, target });

    const licenseRecords = stageLicenses({ runtimeDir, sitePackages, outputDir });
    writeBundleMeta({ metaPath, lock, target, licenseRecords, wheels: Object.keys(platformWheels) });
    console.log(`    [licenses] ${licenseRecords.length} 份许可原文 -> ${join(outputDir, "licenses")}`);

    writeFileSync(join(outputDir, "python3"), pythonShimBody(target, sitePackagesRelative), { mode: 0o755 });
    writeFileSync(join(outputDir, "python"), pythonShimBody(target, sitePackagesRelative), { mode: 0o755 });
    if (target.os === "win32") {
      writeFileSync(join(outputDir, "python3.cmd"), pythonCmdShimBody(sitePackagesRelative));
      writeFileSync(join(outputDir, "python.cmd"), pythonCmdShimBody(sitePackagesRelative));
    }
    console.log(`    [shim]  python3${target.os === "win32" ? " + python3.cmd" : ""} -> ${outputDir}`);
    console.log(`    [done]  ${wheelCount} 个包（${REQUIRED_IMPORTS.length} 项导入断言通过）`);
  } finally {
    try {
      rmSync(workDir, { force: true, recursive: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.warn(`  [warn] 清理临时目录失败（可忽略）: ${workDir}`);
      console.warn(`  [warn] ${String(error)}`);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(`[prepare-python] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
