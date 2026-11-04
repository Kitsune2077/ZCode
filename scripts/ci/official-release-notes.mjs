#!/usr/bin/env node
// 取官方（zai-org/ZCode）某版本的更新日志，供 upstream-sync workflow 贴进同步 PR。
//
// 数据源与桌面端 autoUpdater 的官方说明回退（releaseFeedUpdateProvider
// .fetchOfficialReleaseNotes）同源，按可靠性排序：
//   1. 官方 update manifest（zcode.z.ai，stable→preview 依次探测）——桌面"更新内容"
//      弹窗同款数据，逐版本中文说明；官方 GitHub Releases 稀疏（3.15.x/3.16.x 均未发），
//      只作兜底；
//   2. GitHub Releases API 的 tag body。
//
// 版本完全匹配才采用（与 extractOfficialReleaseNotesForVersion 同语义）：manifest 里
// version 字段必须等于目标版本，避免把相邻版本的说明贴进错误的 PR。
//
// 用法：node scripts/ci/official-release-notes.mjs --version 3.17.2
// 输出：更新日志文本（stdout）；任一来源命中即输出并 exit 0；全部未命中输出空并 exit 0
//      （调用方按空值省略"官方更新日志"小节，不视为错误）。

import process from "node:process";

const OFFICIAL_ENDPOINT_ORIGIN = "https://zcode.z.ai";
const OFFICIAL_RELEASES_API = "https://api.github.com/repos/zai-org/ZCode/releases/tags/";

function parseArgs(argv) {
  const index = argv.indexOf("--version");
  if (index === -1 || !argv[index + 1]) {
    console.error("用法: node scripts/ci/official-release-notes.mjs --version <x.y.z>");
    process.exit(2);
  }
  return { version: argv[index + 1].replace(/^v/u, "").trim() };
}

/** 官方 manifest 的 platform/channel 取值规则（manifestUpdateProvider 同款映射）。 */
function manifestUrl(version, channel) {
  const channelValue = channel === "preview" ? "3" : "1";
  const url = new URL("/api/v1/releases/electron/manifest", OFFICIAL_ENDPOINT_ORIGIN);
  url.searchParams.set("platform", "windows-x86_64");
  url.searchParams.set("channel", channelValue);
  return url;
}

/**
 * 行级提取 manifest 顶层 `releaseNotes:` 块（块标量 `|`/`|-`）。
 * manifest 结构由官方服务端生成，字段顺序稳定；顶层键是行首无缩进的 `key:`，
 * 块正文是缩进行。version 不匹配返回 null（与桌面端"版本完全一致才采用"同语义）。
 */
function extractReleaseNotesFromManifest(yamlText, version) {
  const lines = yamlText.split(/\r?\n/u);
  const versionLine = lines.find((line) => /^version:\s*/u.test(line));
  if (!versionLine || versionLine.replace(/^version:\s*/u, "").trim() !== version) {
    return null;
  }

  const notesIndex = lines.findIndex((line) => /^releaseNotes:/u.test(line));
  if (notesIndex === -1) return null;
  const header = lines[notesIndex].slice("releaseNotes:".length).trim();
  if (!/^\|/u.test(header)) return null; // 仅支持块标量；内联值官方未使用

  const collected = [];
  for (let i = notesIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) {
      collected.push("");
      continue;
    }
    // 顶层键（行首无缩进的 key:）= 块结束。
    if (/^[^\s#]/u.test(line)) break;
    collected.push(line);
  }
  // 剥离 YAML 块标量缩进：以首个非空行的前导空格数为基准。
  const indent = Math.min(
    ...collected.filter((line) => line.trim().length > 0).map((line) => line.match(/^ */u)[0].length),
  );
  const notes = collected
    .map((line) => (line.trim().length === 0 ? "" : line.slice(indent)))
    .join("\n")
    .replace(/^\n+|\s+$/gu, "");
  return notes.length > 0 ? notes : null;
}

async function fetchManifestReleaseNotes(version) {
  // stable 优先；官方常先把新版放 preview（历史实况），stable 没有再探 preview。
  for (const channel of ["stable", "preview"]) {
    try {
      const response = await fetch(manifestUrl(version, channel), {
        headers: { accept: "application/x-yaml,text/yaml,text/plain,*/*" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) continue;
      const text = await response.text();
      const notes = extractReleaseNotesFromManifest(text, version);
      if (notes) return { notes, source: `官方 update manifest（${channel} 通道）` };
    } catch {
      // 网络/解析失败按"该通道无匹配"处理，继续下一通道（与桌面端一致）。
    }
  }
  return null;
}

async function fetchGitHubReleaseNotes(version) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  try {
    const response = await fetch(`${OFFICIAL_RELEASES_API}v${version}`, {
      headers: {
        accept: "application/vnd.github+json",
        // 匿名配额 60/h 不够 CI 用；workflow 里注入 GITHUB_TOKEN 提额。
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const release = await response.json();
    const body = typeof release.body === "string" ? release.body.trim() : "";
    return body.length > 0 ? { notes: body, source: "官方 GitHub Release" } : null;
  } catch {
    return null;
  }
}

const { version } = parseArgs(process.argv);
const found = (await fetchManifestReleaseNotes(version)) ?? (await fetchGitHubReleaseNotes(version));
if (found) {
  console.log(found.notes);
}
