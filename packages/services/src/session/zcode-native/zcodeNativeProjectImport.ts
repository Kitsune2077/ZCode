import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import type { ProjectRepositoryContract, VirtualProject } from "#src/project-storage/contract.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ZcodeNativeConversationSource } from "./zcodeNativeConversationSource.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const logger = createServiceLogger("zcode-native-import");

type Database = InstanceType<typeof DatabaseSync>;

function normalizePathForComparison(path: string): string {
  const normalized = path.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** 安装版 tasks-index 里与本批导入相关的项目快照（只取 local host、未删除）。 */
export interface SourceProjectSnapshot {
  readonly projectId: string;
  readonly name: string;
  readonly nameOverridden: boolean;
  readonly pinned: boolean;
  /** 按 position 排序的 roots；primaryRoot 优先。 */
  readonly roots: readonly string[];
  readonly primaryRoot?: string;
}

function tableExists(db: Database, table: string): boolean {
  const row = db
    .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { n: number };
  return row.n > 0;
}

/**
 * 读取安装版 tasks-index 中各任务的本地项目归属（projects + project_roots + tasks）。
 *
 * 源库整文件拷贝到一次性临时目录后只读打开（与 CLI 会话库同一防撕裂策略）；
 * 旧版本源库没有 projects 表 / 文件不存在时返回空 Map——调用方走"按目录建单 root
 * 项目"的回退（远端 Source Server 首次迁移同款先例，虚拟项目 spec 2026-10-15 裁决）。
 */
export async function readSourceTaskProjectAssignments(
  source: ZcodeNativeConversationSource,
  taskIds: readonly string[],
): Promise<Map<string, SourceProjectSnapshot>> {
  const assignments = new Map<string, SourceProjectSnapshot>();
  if (taskIds.length === 0) return assignments;
  const sourcePath = source.sourceTasksIndexPath;
  try {
    await stat(sourcePath);
  } catch {
    return assignments;
  }
  const tempDir = await mkdtemp(join(dirname(sourcePath), "zcode-native-index-"));
  const copyPath = join(tempDir, "tasks-index.sqlite");
  let db: Database | null = null;
  try {
    await copyFile(sourcePath, copyPath);
    db = new DatabaseSync(copyPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    if (!tableExists(db, "projects") || !tableExists(db, "project_roots") || !tableExists(db, "tasks")) {
      return assignments;
    }
    const readTask = db.prepare(
      `SELECT p.project_id AS projectId, p.name AS name, p.name_overridden AS nameOverridden,
              p.pinned AS pinned
       FROM tasks t JOIN projects p ON p.project_id = t.project_id
       WHERE t.task_id = ? AND p.host_id = 'local' AND p.deleted = 0`,
    );
    const readRoots = db.prepare(
      `SELECT root_path AS rootPath FROM project_roots
       WHERE project_id = ? ORDER BY is_primary DESC, position`,
    );
    for (const taskId of taskIds) {
      if (assignments.has(taskId)) continue;
      const project = readTask.get(taskId) as
        | { projectId: string; name: string; nameOverridden: number; pinned: number }
        | undefined;
      if (!project) continue;
      const roots = (readRoots.all(project.projectId) as Array<{ rootPath: string }>).map(
        (row) => row.rootPath,
      );
      if (roots.length === 0) continue;
      assignments.set(taskId, {
        projectId: project.projectId,
        name: project.name,
        nameOverridden: project.nameOverridden === 1,
        pinned: project.pinned === 1,
        roots,
        primaryRoot: roots[0],
      });
    }
    return assignments;
  } catch (error) {
    // 项目归属读取失败不阻断导入本体：会话照常落库，任务保持未归类。
    logger.warn(
      undefined,
      `读取安装版项目归属失败 source=${source.sourceTasksIndexPath}`,
      error,
    );
    return assignments;
  } finally {
    try {
      db?.close();
    } catch {
      // 关闭失败不影响主流程
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function findProjectByExactRoots(
  projects: readonly VirtualProject[],
  roots: readonly string[],
): VirtualProject | undefined {
  const wanted = new Set(roots.map(normalizePathForComparison));
  return projects.find(
    (project) =>
      !project.deleted &&
      project.roots.length === wanted.size &&
      project.roots.every((root) => wanted.has(normalizePathForComparison(root.rootPath))),
  );
}

function findUniqueProjectContainingRoot(
  projects: readonly VirtualProject[],
  rootPath: string,
): VirtualProject | undefined {
  const matches = projects.filter(
    (project) =>
      !project.deleted && project.roots.some((root) => normalizePathForComparison(root.rootPath) === normalizePathForComparison(rootPath)),
  );
  // 同目录命中多个项目时保持未归类（与首启归属"唯一匹配才归入"同一语义），不猜。
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * 把导入的会话按安装版的项目结构归入目标侧项目：
 * - 安装版 tasks-index 有归属 → 复刻同名同 roots 的项目（已存在等价项目则复用）；
 * - 无归属（旧版源库 / 未归类）→ 按会话目录建单 root 项目（Source Server 迁移先例）；
 * - 目标已有多个包含该目录的项目 → 保持未归类。
 * 归属经 moveTask 写入并置 OWNERSHIP_DECIDED（首启归属不再改判）；
 * 目录内已导入的会话共享同一目标项目。失败按会话记 warn，不阻断导入。
 */
export async function assignImportedTaskProject(params: {
  projectRepository: ProjectRepositoryContract;
  taskId: string;
  workspacePath: string;
  sourceProject?: SourceProjectSnapshot;
  /** 目录 → 目标项目缓存：同批导入同目录只解析/创建一次。 */
  resolvedProjectsByDirectory: Map<string, string>;
}): Promise<void> {
  const { projectRepository, taskId, workspacePath, sourceProject } = params;
  const dirKey = normalizePathForComparison(workspacePath);
  let projectId = params.resolvedProjectsByDirectory.get(dirKey);
  if (projectId === undefined) {
    const tree = projectRepository.readTree({ includeTasks: false });
    let target: VirtualProject;
    if (sourceProject) {
      target =
        findProjectByExactRoots(tree.projects, sourceProject.roots) ??
        projectRepository.saveProject({
          // 未手工改名的项目不固化名字：目标侧按主要目录推导，随目录重命名自然更新。
          ...(sourceProject.nameOverridden ? { name: sourceProject.name } : {}),
          roots: [...sourceProject.roots],
          ...(sourceProject.primaryRoot ? { primaryRoot: sourceProject.primaryRoot } : {}),
          pinned: sourceProject.pinned,
        });
    } else {
      const existing = findUniqueProjectContainingRoot(tree.projects, workspacePath);
      target =
        existing ??
        projectRepository.saveProject({
          roots: [workspacePath],
          primaryRoot: workspacePath,
        });
    }
    projectId = target.id;
    params.resolvedProjectsByDirectory.set(dirKey, projectId);
  }
  projectRepository.moveTask({
    task: { workspacePath, taskId },
    projectId,
    addMissingRoot: true,
  });
}

/** CLI resolveProjectMemoryRoot 的 workspaceId 派生镜像（apps/zcode-cli/packages/core/src/memory/project-root.ts）。 */
function sanitizeProjectSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "project";
}

export function resolveProjectMemoryWorkspaceId(workspacePath: string): string {
  const normalized = resolve(workspacePath);
  const keySource =
    process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const hash = createHash("sha256").update(keySource).digest("hex").slice(0, 16);
  const slug = sanitizeProjectSlug(basename(normalized) || "project");
  return `${slug}-${hash}`;
}

function isProjectMemoryFileName(fileName: string): boolean {
  return fileName === "MEMORY.md" || fileName.endsWith(".md");
}

/**
 * 复制安装版某目录的项目记忆（{dataRoot}/.zcode/cli/memories/projects/{id}/memory/*.md）
 * 到当前数据根同 id 目录；workspaceId 由目录派生，同目录两侧一致，无需重算落点。
 * 目标已存在的文件跳过（目标优先，与 legacy 快照同一冲突语义）。返回复制文件数。
 */
export async function copyProjectMemoryForDirectory(params: {
  sourceDataRoot: string;
  targetMemoriesProjectsRoot: string;
  workspacePath: string;
}): Promise<number> {
  const workspaceId = resolveProjectMemoryWorkspaceId(params.workspacePath);
  const sourceMemoryDir = join(
    params.sourceDataRoot,
    "cli",
    "memories",
    "projects",
    workspaceId,
    "memory",
  );
  let entries: Array<{ name: string; isFile: () => boolean; isSymbolicLink: () => boolean }>;
  try {
    entries = (await readdir(sourceMemoryDir, { withFileTypes: true })) as typeof entries;
  } catch {
    // 安装版没有该项目记忆：常见情形，静默跳过。
    return 0;
  }
  const targetMemoryDir = join(
    params.targetMemoriesProjectsRoot,
    workspaceId,
    "memory",
  );
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !isProjectMemoryFileName(entry.name)) {
      continue;
    }
    const targetFile = join(targetMemoryDir, entry.name);
    try {
      await stat(targetFile);
      continue; // 目标已存在：目标优先，不覆盖便携侧后续编辑。
    } catch {
      // 目标不存在：复制。
    }
    await mkdir(targetMemoryDir, { recursive: true });
    await copyFile(join(sourceMemoryDir, entry.name), targetFile);
    copied += 1;
  }
  return copied;
}
