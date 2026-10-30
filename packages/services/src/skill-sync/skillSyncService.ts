import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { SKILL_DATA_SYNC_MAX_ITEM_BYTES } from "@zcode/shared";
import type {
  ISkillSyncService,
  SkillZipImportResult,
  SkillZipImportResultItem,
} from "./skillSync.js";
import {
  MAX_SKILL_SCAN_DEPTH,
  shouldWalkSkillDirectoryEntry,
  walkSkillMarkdownPaths,
} from "../skills/skillDiscoveryWalk.js";
import { createSkillDataSyncMethods } from "../data-sync/node.js";
import { createSkillSyncSizeLimitError } from "./skillSyncErrors.js";
import { resolveSkillSyncPathWithin } from "./skillSyncPath.js";
import { extractSkillZipArchive } from "./skillZipArchive.js";

const SKILL_FILE_NAME = "SKILL.md";
const DEFAULT_MAX_ARCHIVE_BYTES = SKILL_DATA_SYNC_MAX_ITEM_BYTES;

/** 用户级技能候选：path 指向技能目录下的 SKILL.md。 */
export interface UserSkillCandidate {
  name: string;
  directoryName: string;
  description: string;
  path: string;
}

export function createSkillSyncService(options?: { maxArchiveBytes?: number }): ISkillSyncService {
  const maxArchiveBytes = options?.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  // 数据同步：单个技能目录的大小上限，默认 20MB。
  const dataSync = createSkillDataSyncMethods({ maxItemBytes: maxArchiveBytes });
  return {
    ...dataSync,
    // 本仓库定制：本地 ZIP 技能包导入入口（上游 3.17 移除归档导入后单独保留）。
    importSkillsZipArchive: (params) =>
      importSkillsZipArchive({ filePath: params.filePath, maxArchiveBytes }),
  };
}

export function resolveUserHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

export function getUserZcodeSkillRoot(): string {
  return join(resolveUserHomeDir(), ".zcode", "skills");
}

function getUserAgentsSkillRoot(): string {
  return join(resolveUserHomeDir(), ".agents", "skills");
}

/**
 * 用户级技能候选：`~/.zcode/skills` 优先，`~/.agents/skills` 中同目录名或同 name 的项剔除，再按 realpath 去重。
 * 文件数与字节签名由数据同步的 list 自己计算。
 */
export async function collectUserSkillCandidates(): Promise<UserSkillCandidate[]> {
  const seenSkillRealpaths = new Set<string>();
  const userZcodeSkillRoot = getUserZcodeSkillRoot();
  const rawZcodeCandidates = await collectUserSkillCandidatesInRoot(userZcodeSkillRoot);
  const zcodeDirectoryNames = await collectCoveredSkillDirectoryNamesInRoot(userZcodeSkillRoot);
  const zcodeSkillNameKeys = new Set(
    rawZcodeCandidates.map((candidate) => normalizeSkillNameKey(candidate.name)),
  );
  const zcodeCandidates = await dedupeCandidatesByCanonicalSkillPath(
    rawZcodeCandidates,
    seenSkillRealpaths,
  );
  const agentsCandidates = await dedupeCandidatesByCanonicalSkillPath(
    (await collectUserSkillCandidatesInRoot(getUserAgentsSkillRoot())).filter(
      (candidate) =>
        !zcodeDirectoryNames.has(candidate.directoryName) &&
        !zcodeSkillNameKeys.has(normalizeSkillNameKey(candidate.name)),
    ),
    seenSkillRealpaths,
  );

  return [...zcodeCandidates, ...agentsCandidates].sort((left, right) =>
    left.directoryName.localeCompare(right.directoryName),
  );
}

async function dedupeCandidatesByCanonicalSkillPath(
  candidates: UserSkillCandidate[],
  seenSkillRealpaths: Set<string>,
): Promise<UserSkillCandidate[]> {
  const result: UserSkillCandidate[] = [];
  for (const candidate of candidates) {
    const canonicalPath = await realpath(candidate.path).catch(() => candidate.path);
    if (seenSkillRealpaths.has(canonicalPath)) {
      continue;
    }
    seenSkillRealpaths.add(canonicalPath);
    result.push(candidate);
  }
  return result;
}

async function collectUserSkillCandidatesInRoot(root: string): Promise<UserSkillCandidate[]> {
  if (!existsSync(root)) {
    return [];
  }
  const candidates: UserSkillCandidate[] = [];
  for await (const skillPath of walkSkillMarkdownPaths(root)) {
    const directoryPath = dirname(skillPath);
    const relativePath = normalizeSkillDirectoryRelativePath(root, directoryPath);
    if (!relativePath) {
      continue;
    }
    const content = await readSkillFileOrNull(skillPath);
    if (content !== null) {
      const metadata = parseSkillMetadata(content, basename(relativePath));
      candidates.push({
        name: metadata.name,
        directoryName: relativePath,
        description: metadata.description,
        path: skillPath,
      });
    }
  }

  // 远端同步候选必须复用设置页已有的有界扫描策略；
  // 自己维护递归会漏掉 MAX_SKILL_SCAN_DEPTH 和软链 realpath 去重，遇到环形目录软链会卡住。
  return candidates.sort((left, right) => left.directoryName.localeCompare(right.directoryName));
}

async function collectCoveredSkillDirectoryNamesInRoot(root: string): Promise<Set<string>> {
  const directoryNames = new Set<string>();
  if (!existsSync(root)) {
    return directoryNames;
  }
  const stack: Array<{ directoryPath: string; relativePath: string; depth: number }> = [
    { directoryPath: root, relativePath: "", depth: 0 },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const skillFilePath = join(current.directoryPath, SKILL_FILE_NAME);
    if (current.relativePath && (await readSkillFileOrNull(skillFilePath))) {
      directoryNames.add(current.relativePath);
    }
    if (current.depth >= MAX_SKILL_SCAN_DEPTH) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(current.directoryPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!shouldWalkSkillDirectoryEntry(entry.name)) {
        continue;
      }
      const entryPath = join(current.directoryPath, entry.name);
      const isDirectory =
        entry.isDirectory() ||
        (entry.isSymbolicLink() && (await stat(entryPath).catch(() => undefined))?.isDirectory());
      if (!isDirectory) {
        continue;
      }
      stack.push({
        directoryPath: entryPath,
        relativePath: joinSkillRelativePath(current.relativePath, entry.name),
        depth: current.depth + 1,
      });
    }
  }

  return directoryNames;
}

function normalizeSkillDirectoryRelativePath(root: string, directoryPath: string): string {
  return relative(root, directoryPath).replaceAll("\\", "/");
}

export function normalizeSkillNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function joinSkillRelativePath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

export async function readSkillFileOrNull(skillPath: string): Promise<string | null> {
  try {
    return await readFile(skillPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function parseSkillMetadata(
  content: string,
  fallbackName: string,
): {
  name: string;
  description: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) {
    return { name: fallbackName, description: "" };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return { name: fallbackName, description: "" };
  }
  const metadata = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const name =
    typeof metadata.name === "string" && metadata.name.trim() ? metadata.name.trim() : fallbackName;
  const description = typeof metadata.description === "string" ? metadata.description.trim() : "";
  return { name, description };
}

/**
 * 本仓库定制：本地 ZIP 技能包导入。
 *
 * 上游 3.17 把技能同步收敛到「按条目载荷」的 data-sync 模型，本地归档导入没有对应入口，
 * 因此在本文件单独保留：先在临时目录解压并校验，再逐个复制进用户级 skills 根，
 * 避免路径穿越或半成品目录污染用户配置。
 */
export async function importSkillsZipArchive(options: {
  filePath: string;
  maxArchiveBytes: number;
}): Promise<SkillZipImportResult> {
  const filePath = options.filePath.trim();
  if (!/\.zip$/iu.test(filePath)) {
    throw new Error(`skill zip import requires a .zip file: ${filePath}`);
  }
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`skill zip import path is not a regular file: ${filePath}`);
  }
  if (fileStat.size > options.maxArchiveBytes) {
    throw createSkillSyncSizeLimitError({
      actualBytes: fileStat.size,
      maxBytes: options.maxArchiveBytes,
      phase: "archive",
    });
  }
  // renderer 只有本地路径、没有通用文件读取能力：ZIP 字节由 host 读盘后再解压。
  const archive = await readFile(filePath);
  const targetRoot = getUserZcodeSkillRoot();
  await mkdir(targetRoot, { recursive: true });
  const tempRoot = join(targetRoot, `.zip-tmp-${randomUUID()}`);
  await mkdir(tempRoot, { recursive: true });
  try {
    await extractSkillZipArchive(archive, tempRoot, {
      maxExtractedBytes: options.maxArchiveBytes,
    });
    return { results: await importExtractedSkillDirectories(tempRoot) };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function importExtractedSkillDirectories(
  tempRoot: string,
): Promise<SkillZipImportResultItem[]> {
  const targetRoot = getUserZcodeSkillRoot();
  // 复用上游的候选扫描与去重：`~/.zcode/skills` 优先，`~/.agents/skills` 同名目录/同名 skill 跳过，
  // 避免同一次导入在 .zcode 下生成重复来源。
  const existingCandidates = await collectUserSkillCandidates();
  const existingPathByDirectory = new Map(
    existingCandidates.map((candidate) => [candidate.directoryName, candidate.path]),
  );
  const existingPathByName = new Map(
    existingCandidates.map((candidate) => [normalizeSkillNameKey(candidate.name), candidate.path]),
  );

  const results: SkillZipImportResultItem[] = [];
  for (const extracted of await collectExtractedSkillDirectories(tempRoot)) {
    const { directoryName, sourcePath } = extracted;
    const targetPath = resolveSkillSyncPathWithin(targetRoot, directoryName);
    const skillContent = await readSkillFileOrNull(join(sourcePath, SKILL_FILE_NAME));
    if (skillContent === null) {
      results.push({
        name: basename(directoryName),
        directoryName,
        status: "failed",
        error: "SKILL.md is missing",
      });
      continue;
    }

    const metadata = parseSkillMetadata(skillContent, directoryName);
    const nameKey = normalizeSkillNameKey(metadata.name);
    const existingPath =
      existingPathByDirectory.get(directoryName) ?? existingPathByName.get(nameKey);
    if (existingPath || existsSync(targetPath)) {
      results.push({
        name: metadata.name,
        directoryName,
        status: "skipped",
        path: existingPath ?? targetPath,
      });
      continue;
    }

    try {
      await mkdir(dirname(targetPath), { recursive: true });
      await cp(sourcePath, targetPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      results.push({
        name: metadata.name,
        directoryName,
        status: "synced",
        path: targetPath,
      });
      existingPathByDirectory.set(directoryName, targetPath);
      existingPathByName.set(nameKey, targetPath);
    } catch (error) {
      results.push({
        name: metadata.name,
        directoryName,
        status: "failed",
        path: targetPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function collectExtractedSkillDirectories(
  root: string,
): Promise<Array<{ directoryName: string; sourcePath: string }>> {
  const directories: Array<{ directoryName: string; sourcePath: string }> = [];
  const stack: Array<{ directoryPath: string; relativePath: string }> = [
    { directoryPath: root, relativePath: "" },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    if (current.relativePath && existsSync(join(current.directoryPath, SKILL_FILE_NAME))) {
      directories.push({
        directoryName: current.relativePath,
        sourcePath: current.directoryPath,
      });
    }
    const entries = await readdir(current.directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !shouldWalkSkillDirectoryEntry(entry.name)) {
        continue;
      }
      stack.push({
        directoryPath: join(current.directoryPath, entry.name),
        relativePath: joinSkillRelativePath(current.relativePath, entry.name),
      });
    }
  }
  return directories;
}
