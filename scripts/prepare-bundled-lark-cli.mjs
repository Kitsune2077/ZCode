#!/usr/bin/env node

/**
 * 准备随包内置的飞书 CLI（lark-cli）原生二进制。
 *
 * 为什么内置：官方 npm 包 @larksuite/cli 只是转发壳（scripts/run.js → bin/lark-cli[.exe]），
 * 真正实现由 GitHub Release 以原生单文件分发。插件 skills/setup 的第一步是
 * `command -v lark-cli`；只要内置副本进了 PATH，它就会跳过 `npm install -g @larksuite/cli`，
 * 用户因此无需预装 Node.js / npm。
 *
 * 供应链：版本跟随 npm 上 @larksuite/cli 的 latest（可用 ZCODE_LARK_CLI_VERSION 钉死）；
 * 期望摘要取自该版本 npm 包内的 checksums.txt（官方随包发布），下载后逐字节校验，
 * 校验失败即构建失败——不能把无法验证的二进制放进安装包。
 *
 * 产物：packages/desktop/bundled-tools/<platform-key>/lark-cli/lark-cli[.exe]
 *   - 打包时由 electron-builder 复制到 resources/tools/lark-cli
 *   - 运行时由 services 的 runtimeToolResolver 解析，并把所在目录追加进 Agent 的 PATH
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { downloadWithRetry } from "./download-file.mjs";
import { runCommand } from "./spawn-command.mjs";
import { getTargetPlatform } from "../packages/desktop/scripts/target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const PACKAGE_NAME = "@larksuite/cli";
const BINARY_BASENAME = "lark-cli";
const META_FILE_NAME = "lark-cli-bundle.json";
const GITHUB_RELEASE_BASE = "https://github.com/larksuite/cli/releases/download";
const SKIP_ENV = "ZCODE_SKIP_LARK_CLI";
const VERSION_ENV = "ZCODE_LARK_CLI_VERSION";
const REGISTRY_ENV_KEYS = ["npm_config_registry", "NPM_CONFIG_REGISTRY"];
// 官方 install.js 同样优先走 npmmirror 的 binary 镜像，GitHub 仅作兜底。
const DEFAULT_REGISTRIES = ["https://registry.npmmirror.com", "https://registry.npmjs.org"];
const DOWNLOAD_ATTEMPTS = 3;
const ARCHIVE_PLATFORM_MAP = { darwin: "darwin", linux: "linux", win32: "windows" };
const ARCHIVE_ARCH_MAP = { arm64: "arm64", riscv64: "riscv64", x64: "amd64" };

function binaryFileNameForPlatform(platform) {
  return platform === "win32" ? `${BINARY_BASENAME}.exe` : BINARY_BASENAME;
}

function archiveNameForTarget(version, archivePlatform, archiveArch) {
  const extension = archivePlatform === "windows" ? ".zip" : ".tar.gz";
  return `${BINARY_BASENAME}-${version}-${archivePlatform}-${archiveArch}${extension}`;
}

function resolveRegistryBases(env) {
  const configured = REGISTRY_ENV_KEYS.map((key) => env[key]?.trim()).find(Boolean);
  const seen = new Set();
  return [
    ...(configured ? [configured.replace(/\/+$/, "")] : []),
    ...DEFAULT_REGISTRIES,
  ].filter((base) => !seen.has(base) && seen.add(base));
}

async function fetchJson(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} (${url})`);
  }
  return response.json();
}

async function resolveLatestVersion(registryBases) {
  const failures = [];
  for (const base of registryBases) {
    try {
      const packument = await fetchJson(`${base}/${encodeURIComponent(PACKAGE_NAME)}/latest`);
      const version = typeof packument?.version === "string" ? packument.version.trim() : "";
      if (version) return { version, registryBase: base };
      failures.push(`${base}: latest 响应缺少 version`);
    } catch (error) {
      failures.push(`${base}: ${String(error)}`);
    }
  }
  throw new Error(`无法从任何 registry 解析 ${PACKAGE_NAME} 的 latest 版本：\n- ${failures.join("\n- ")}`);
}

/** 官方 checksums.txt 随 npm 包发布；取它而不是自算摘要，才能对上游发布物做真正校验。 */
async function resolveExpectedChecksums(registryBase, version, workDir) {
  const packument = await fetchJson(`${registryBase}/${encodeURIComponent(PACKAGE_NAME)}`);
  const tarballUrl = packument?.versions?.[version]?.dist?.tarball;
  if (typeof tarballUrl !== "string" || !tarballUrl.trim()) {
    throw new Error(`${PACKAGE_NAME}@${version} 的 dist.tarball 缺失`);
  }

  const tarballPath = join(workDir, "package.tgz");
  await downloadWithRetry(tarballUrl.trim(), tarballPath, DOWNLOAD_ATTEMPTS);
  // 与 prepare-prebuilds 相同的 tar 约定：cwd + 相对归档名，-C 目标用正斜杠，
  // 避免 Windows 盘符冒号被 GNU tar 当成远程主机名。
  runCommand("tar", ["-xzf", "package.tgz", "package/checksums.txt"], { cwd: workDir });

  const checksums = new Map();
  for (const line of readFileSync(join(workDir, "package", "checksums.txt"), "utf8").split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+(.+)$/i.exec(line.trim());
    if (match) checksums.set(match[2].trim(), match[1].toLowerCase());
  }
  if (checksums.size === 0) {
    throw new Error(`checksums.txt 为空或格式不可解析（${PACKAGE_NAME}@${version}）`);
  }
  return checksums;
}

async function downloadReleaseArchive({ archiveName, version, registryBase, destinationPath }) {
  // npmmirror 的 binary 镜像与上游 release 资产同名同内容，先用它，GitHub 兜底。
  const urls = [
    `${registryBase}/-/binary/${BINARY_BASENAME}/v${version}/${archiveName}`,
    `${GITHUB_RELEASE_BASE}/v${version}/${archiveName}`,
  ];
  const failures = [];
  for (const url of urls) {
    try {
      await downloadWithRetry(url, destinationPath, DOWNLOAD_ATTEMPTS);
      return url;
    } catch (error) {
      failures.push(`${url}: ${String(error)}`);
    }
  }
  throw new Error(`下载 ${archiveName} 失败：\n- ${failures.join("\n- ")}`);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function extractBinary(archiveName, workDir, outputDir, binaryFileName) {
  const extractDir = join(workDir, "extract");
  mkdirSync(extractDir, { recursive: true });
  runCommand("tar", ["-xf", archiveName, "-C", extractDir.replaceAll("\\", "/")], { cwd: workDir });

  const binaryPath = join(extractDir, binaryFileName);
  if (!existsSync(binaryPath)) {
    throw new Error(`归档中未找到 ${binaryFileName}：${archiveName}`);
  }
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, binaryFileName);
  // 归档里可能还有 CHANGELOG/README/LICENSE；LICENSE 单独保留用于声明，其余不随包。
  writeFileSync(outputPath, readFileSync(binaryPath));
  const licensePath = join(extractDir, "LICENSE");
  if (existsSync(licensePath)) {
    writeFileSync(join(outputDir, "LICENSE"), readFileSync(licensePath));
  }
  return outputPath;
}

function readExistingMeta(metaPath) {
  try {
    return JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

function cleanupWorkDir(workDir) {
  try {
    // 与 prepare-prebuilds 一致：Windows 下刚写完的文件可能被杀毒/索引器短暂持有，
    // 立即删除会 EPERM，且 finally 里的异常会掩盖真正的下载/校验错误。
    rmSync(workDir, { force: true, recursive: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    console.warn(`  [warn] 清理临时目录失败（可忽略）: ${workDir}`);
    console.warn(`  [warn] ${String(error)}`);
  }
}

async function main() {
  if (process.env[SKIP_ENV] === "1") {
    console.log(`==> 跳过飞书 CLI 内置（${SKIP_ENV}=1）`);
    return;
  }

  const target = getTargetPlatform();
  const archivePlatform = ARCHIVE_PLATFORM_MAP[target.os];
  const archiveArch = ARCHIVE_ARCH_MAP[target.arch];
  if (!archivePlatform || !archiveArch) {
    // 上游未发布该平台的资产时明确跳过，而不是产出一个缺工具的安装包却不作声。
    console.log(
      `==> 跳过飞书 CLI 内置：上游未提供 ${target.os}/${target.arch} 的发布资产（platform=${target.key}）`,
    );
    return;
  }

  const outputDir = join(rootDir, "packages", "desktop", "bundled-tools", target.key, BINARY_BASENAME);
  const binaryFileName = binaryFileNameForPlatform(target.os);
  const metaPath = join(outputDir, META_FILE_NAME);

  const registryBases = resolveRegistryBases(process.env);
  const pinnedVersion = process.env[VERSION_ENV]?.trim();
  const resolved = pinnedVersion
    ? { version: pinnedVersion, registryBase: registryBases[0] }
    : await resolveLatestVersion(registryBases);
  const { version, registryBase } = resolved;

  const existing = readExistingMeta(metaPath);
  const existingBinaryPath = join(outputDir, binaryFileName);
  // 幂等只比对二进制自身的摘要：归档校验和（archiveSha256）与解包后文件的摘要不同，
  // 用前者比对会让每次构建都误判为损坏并重新下载。
  if (existing?.version === version && existsSync(existingBinaryPath)) {
    if (sha256File(existingBinaryPath) === existing.binarySha256) {
      console.log(`    [skip] lark-cli ${version} 已就绪（${target.key}）`);
      return;
    }
    console.log(`    [repair] lark-cli 二进制与记录摘要不符，重新准备：${existingBinaryPath}`);
  }

  console.log("==> Preparing bundled Lark CLI");
  console.log(`    target  : ${target.key}`);
  console.log(`    version : ${version}${pinnedVersion ? ` (${VERSION_ENV} 指定)` : " (npm latest)"}`);
  console.log(`    output  : ${outputDir}`);

  const archiveName = archiveNameForTarget(version, archivePlatform, archiveArch);
  const workDir = mkdtempSync(join(tmpdir(), "zcode-lark-cli-"));
  try {
    const checksums = await resolveExpectedChecksums(registryBase, version, workDir);
    const expectedSha = checksums.get(archiveName);
    if (!expectedSha) {
      throw new Error(`checksums.txt 中缺少 ${archiveName}（${PACKAGE_NAME}@${version}）`);
    }

    const archivePath = join(workDir, archiveName);
    const sourceUrl = await downloadReleaseArchive({
      archiveName,
      version,
      registryBase,
      destinationPath: archivePath,
    });

    const actualSha = sha256File(archivePath);
    if (actualSha !== expectedSha) {
      throw new Error(
        `sha256 校验失败：${archiveName}\n  期望 ${expectedSha}\n  实际 ${actualSha}`,
      );
    }
    console.log(`    sha256  : ${actualSha} ✓`);

    const outputPath = extractBinary(archiveName, workDir, outputDir, binaryFileName);
    const binarySha = sha256File(outputPath);
    writeFileSync(
      metaPath,
      `${JSON.stringify(
        {
          archiveName,
          // 归档摘要用于追溯供应链（与官方 checksums.txt 对应）。
          archiveSha256: actualSha,
          binary: binaryFileName,
          // 解包后二进制的摘要，供下一次构建做幂等判断。
          binarySha256: binarySha,
          sourceUrl,
          version,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`    [extract] ${archiveName} -> ${outputPath}`);
  } finally {
    cleanupWorkDir(workDir);
  }
}

try {
  await main();
} catch (error) {
  console.error(`[prepare-lark-cli] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
