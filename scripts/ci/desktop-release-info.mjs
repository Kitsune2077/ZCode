#!/usr/bin/env node

/**
 * 桌面安装包发布信息：收集与渲染。
 *
 * 为什么独立成脚本而不是写在 workflow 的 shell 步骤里：
 *   1. 构建在 Windows / macOS / Linux 三种 runner 上跑，内联 shell 会分裂成三份平台方言；
 *   2. 这段逻辑（产物识别、sha256、Release 说明表格）能在本地用真实 dist 目录验证，
 *      而 workflow 本身在仓库里无法执行验证。
 *
 * 用法：
 *   node scripts/ci/desktop-release-info.mjs collect --dist-dir <dir> --os win --arch x64 --out <file>
 *   node scripts/ci/desktop-release-info.mjs render  --info-dir <dir> --out <file>
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommandAndReadStdout } from "../spawn-command.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "../..");
const LARK_CLI_DIR_NAME = "lark-cli";
const LARK_CLI_META_FILE = "lark-cli-bundle.json";

// 主产物后缀；blockmap / latest.yml / builder-debug.yml 属辅助文件，不进说明表格。
// Windows 同时产出 nsis 安装包与便携 zip，两者都是主产物。
const PRIMARY_ARTIFACT_EXTENSIONS = {
  linux: [".appimage", ".deb", ".rpm", ".pkg.tar.zst"],
  mac: [".dmg", ".zip"],
  win: [".exe", ".zip"],
};
const AUXILIARY_ARTIFACT_EXTENSIONS = [".blockmap"];

const OS_LABELS = { linux: "Linux", mac: "macOS", win: "Windows" };

// 同一平台可能有多种形态（安装包 / 便携包 / 系统包），说明里必须区分，否则用户不知道下载哪个。
const ARTIFACT_FORMS = {
  linux: {
    ".appimage": "便携可执行（AppImage）",
    ".deb": "Debian 包",
    ".pkg.tar.zst": "Arch 包（pacman）",
    ".rpm": "RPM 包",
  },
  mac: { ".dmg": "磁盘映像", ".zip": "便携 ZIP" },
  win: { ".exe": "安装包（NSIS）", ".zip": "便携 ZIP（解压即用）" },
};

function readArg(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function resolveCommitId() {
  const fromEnv = process.env.GITHUB_SHA?.trim();
  if (fromEnv) return fromEnv;
  try {
    return runCommandAndReadStdout("git", ["rev-parse", "HEAD"], { cwd: rootDir }).trim();
  } catch {
    return "unknown";
  }
}

function resolveLarkCliProvenance() {
  // 与 bundled-runtime-tools 的落盘位置一致：bundled-tools/<platform-key>/lark-cli/lark-cli-bundle.json
  const platformKey = `${process.platform}-${process.arch}`;
  const metaPath = join(
    rootDir,
    "packages",
    "desktop",
    "bundled-tools",
    platformKey,
    LARK_CLI_DIR_NAME,
    LARK_CLI_META_FILE,
  );
  if (!existsSync(metaPath)) return null;
  try {
    const meta = readJson(metaPath);
    return {
      archiveSha256: meta.archiveSha256,
      sourceUrl: meta.sourceUrl,
      version: meta.version,
    };
  } catch {
    return null;
  }
}

function resolveArtifactForm(targetOs, lowerName) {
  const forms = ARTIFACT_FORMS[targetOs] ?? {};
  return (
    Object.entries(forms).find(([extension]) => lowerName.endsWith(extension))?.[1] ?? "其他产物"
  );
}

function classifyArtifacts(distDir, targetOs) {
  const primary = new Set(PRIMARY_ARTIFACT_EXTENSIONS[targetOs] ?? []);
  const entries = readdirSync(distDir).filter((name) => {
    const full = join(distDir, name);
    return statSync(full).isFile();
  });

  const artifacts = [];
  for (const name of entries) {
    const lower = name.toLowerCase();
    const isPrimary = [...primary].some((extension) => lower.endsWith(extension));
    const isAuxiliary = AUXILIARY_ARTIFACT_EXTENSIONS.some((extension) =>
      lower.endsWith(extension),
    );
    if (!isPrimary && !isAuxiliary) continue;
    const full = join(distDir, name);
    artifacts.push({
      ...(isPrimary ? { form: resolveArtifactForm(targetOs, lower) } : {}),
      kind: isPrimary ? "installer" : "auxiliary",
      name,
      sha256: sha256File(full),
      sizeBytes: statSync(full).size,
    });
  }
  // installers 在前，同类别按名字稳定排序，便于 Release 说明逐次可比。
  return artifacts.sort((left, right) =>
    left.kind === right.kind
      ? left.name.localeCompare(right.name)
      : left.kind === "installer"
        ? -1
        : 1,
  );
}

function collect() {
  const distDir = resolve(readArg("dist-dir") ?? join(rootDir, "packages", "desktop", "dist"));
  const targetOs = readArg("os");
  const targetArch = readArg("arch");
  const outPath = readArg("out");
  if (!targetOs || !targetArch || !outPath) {
    throw new Error("collect 需要 --os / --arch / --out");
  }
  if (!existsSync(distDir)) {
    throw new Error(`产物目录不存在：${distDir}`);
  }

  const info = {
    arch: targetArch,
    artifacts: classifyArtifacts(distDir, targetOs),
    commit: resolveCommitId(),
    larkCli: resolveLarkCliProvenance(),
    os: targetOs,
    // 远端 mock-cdn 资产是否随包构建；跳过时说明里要写清楚，避免用户以为远程工作区开箱可用。
    remoteAssetsIncluded: process.env.ZCODE_SKIP_REMOTE_ASSETS !== "1",
    version: readJson(join(rootDir, "package.json")).version,
  };
  const installers = info.artifacts.filter((artifact) => artifact.kind === "installer");
  if (installers.length === 0) {
    throw new Error(`在 ${distDir} 未找到 ${targetOs} 的主产物，构建可能未产出安装包`);
  }

  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), `${JSON.stringify(info, null, 2)}\n`, "utf8");
  console.log(`[release-info] collected ${installers.length} installer(s) -> ${outPath}`);
  for (const artifact of info.artifacts) {
    console.log(
      `  ${artifact.kind.padEnd(9)} ${artifact.name}  (${formatMiB(artifact.sizeBytes)})`,
    );
  }
}

/** 一个平台可能有多份主产物（如 Windows 的 nsis 安装包 + 便携 zip），逐份出一行。 */
function renderPlatformRows(info) {
  return info.artifacts
    .filter((artifact) => artifact.kind === "installer")
    .map((artifact) => ({
      arch: info.arch,
      form: artifact.form ?? "其他产物",
      name: artifact.name,
      os: OS_LABELS[info.os] ?? info.os,
      sha256: artifact.sha256,
      size: formatMiB(artifact.sizeBytes),
    }));
}

function render() {
  const infoDir = resolve(readArg("info-dir") ?? ".");
  const outPath = readArg("out");
  if (!outPath) throw new Error("render 需要 --out");

  const infos = readdirSync(infoDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(join(infoDir, name)));
  if (infos.length === 0) throw new Error(`未在 ${infoDir} 找到任何 build-info json`);

  const version = infos[0].version;
  const commit = infos[0].commit;
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
  const larkCli = infos.find((info) => info.larkCli)?.larkCli ?? null;
  const remoteAssetsIncluded = infos.every((info) => info.remoteAssetsIncluded);

  const rows = infos
    .flatMap(renderPlatformRows)
    .sort((left, right) =>
      `${left.os}-${left.arch}-${left.name}`.localeCompare(
        `${right.os}-${right.arch}-${right.name}`,
      ),
    );

  const lines = [];
  lines.push(`ZCode ${version} 桌面安装包。`);
  lines.push("");
  lines.push(
    runUrl
      ? `由 GitHub Actions 构建：${runUrl}（commit \`${commit}\`）`
      : `由本地脚本渲染（commit \`${commit}\`）`,
  );
  lines.push("");
  lines.push("| 平台 | 架构 | 形态 | 产物 | 大小 | SHA256 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    lines.push(
      `| ${row.os} | ${row.arch} | ${row.form} | \`${row.name}\` | ${row.size} | \`${row.sha256}\` |`,
    );
  }
  lines.push("");
  lines.push("### 说明");
  lines.push("");
  lines.push("- 构建身份：`production`（`ZCODE_ENV=production`），版本取自根 `package.json`。");
  lines.push(
    "- **未签名**：Windows 首次运行需在 SmartScreen 选「仍要运行」；macOS 需手动去隔离后打开：" +
      "`sudo xattr -rd com.apple.quarantine /Applications/ZCode.app`。",
  );
  lines.push(
    "- Windows 便携 ZIP：解压到任意目录后直接双击 `ZCode.exe` 即可运行，无需安装、不写注册表" +
      "（应用数据仍保存在用户目录的 `.zcode` 下）。",
  );
  if (larkCli) {
    lines.push(
      `- 内置飞书 CLI \`${larkCli.version}\`（无需预装 Node.js）。来源：${larkCli.sourceUrl}` +
        `，归档 sha256 \`${larkCli.archiveSha256}\`。`,
    );
  }
  lines.push(
    remoteAssetsIncluded
      ? "- 远端工作区预编译资源（mock-cdn）已随包构建。"
      : "- 远端工作区预编译资源（mock-cdn）**未包含**（构建时 `ZCODE_SKIP_REMOTE_ASSETS=1`）。",
  );
  lines.push("- 每个产物旁的 `.blockmap` 供增量更新使用，与安装包一同附在本 Release。");

  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), `${lines.join("\n")}\n`, "utf8");
  console.log(`[release-info] release notes -> ${outPath}`);

  const auxiliary = infos.flatMap((info) =>
    info.artifacts
      .filter((artifact) => artifact.kind === "auxiliary")
      .map((artifact) => artifact.name),
  );
  if (auxiliary.length > 0) {
    console.log(`[release-info] auxiliary files to attach: ${auxiliary.join(", ")}`);
  }
}

function main() {
  const command = process.argv[2];
  if (command === "collect") return collect();
  if (command === "render") return render();
  throw new Error(`未知子命令：${String(command)}（支持 collect / render）`);
}

try {
  main();
} catch (error) {
  console.error(`[release-info] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
