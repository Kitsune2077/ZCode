// 构建期把第三方 zusage 悬浮条注入 app.asar（第三方运行时见 third-party/zusage/NOTE.md）。
//
// 契约：
//   - 在 asar 入口 out/main/index.js 末尾追加一行动态 import，指向 resources/zusage/inject-main.cjs；
//   - loader 路径用 process.resourcesPath 运行时求值，绝不写死构建机路径；
//   - 幂等：先剥离任何既有 inject-main 注入行再加（重复打包不会累积多行）；
//   - 只做 asar 注入，不跑 engine-patch（锚点按上游引擎版本硬编码，见 NOTE.md）。

import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

/** asar 内的桌面主进程入口（与本包 package.json 的 "main" 同源）。 */
export const ZUSAGE_ASAR_ENTRY = "out/main/index.js";
/** 产物内的运行时落点（相对 resources/）。 */
export const ZUSAGE_RESOURCES_DIR_NAME = "zusage";

/**
 * 匹配任意一条 zusage 注入行（不限路径形态），用于剥离旧行后重新注入。
 * 注入行固定是**单行**、以 `\n;` 起始、同时含 inject-main.cjs 与 "[zusage] load failed" 标记。
 * `\n;` 之后不假定紧跟 import( ——两种形态的表达式前缀不同：
 *   - 上游 patch_install.py：`\n;import("file:///abs/.../inject-main.cjs").then(...)`
 *   - 本仓库：`\n;(()=>{…})().then(...)`（process.resourcesPath 动态定位）
 */
const ZUSAGE_INJECT_LINE_RE =
  /\n;[^\n]*inject-main\.cjs[^\n]*"\[zusage\] load failed"[^\n]*\);/gu;

/**
 * 运行时动态定位 loader 的注入行。
 * 不能用 require（入口是 ESM），也不能写死绝对路径（构建机与用户机器不同）；
 * process.resourcesPath 在 Windows 形如 `C:\...\resources`，需转成 file URL。
 */
export function buildZusageInjectLine() {
  return [
    "\n;",
    "(()=>{",
    'const p=process.resourcesPath.replace(/\\\\/g,"/");',
    'const h=p.startsWith("/")?"file://"+p:"file:///"+p;',
    `return import(h+"/${ZUSAGE_RESOURCES_DIR_NAME}/inject-main.cjs");`,
    "})()",
    '.then(() => null, (e) => console.error("[zusage] load failed", e));',
  ].join("");
}

/** 剥离既有注入行（幂等）。 */
export function stripZusageInjectLines(source) {
  return source.replace(ZUSAGE_INJECT_LINE_RE, "");
}

/**
 * 把注入行追加到入口源码；返回 null 表示无需变更（已指向当前形态）。
 */
export function applyZusageInjectLine(source) {
  const stripped = stripZusageInjectLines(source);
  const line = buildZusageInjectLine();
  if (stripped + line === source) return null;
  return stripped + line;
}

/** 校验 vendored runtime 完整性（数量下限 + 关键文件存在）。 */
async function assertVendoredRuntime(runtimeDir) {
  const required = ["inject-main.cjs", "overlay.js", "plugin-storage.cjs", "plugin-updater.cjs"];
  for (const name of required) {
    const target = join(runtimeDir, name);
    const info = await stat(target).catch(() => null);
    if (!info?.isFile() || info.size === 0) {
      throw new Error(
        `[zusage] vendored runtime 缺失或为空：${target}（见 packages/desktop/third-party/zusage/NOTE.md）`,
      );
    }
  }
}

/**
 * 把 runtime 复制到产物 resources/zusage/。
 * @param {{ runtimeSourceDir: string, resourcesDir: string }} options
 */
export async function stageZusageRuntime({ runtimeSourceDir, resourcesDir }) {
  await assertVendoredRuntime(runtimeSourceDir);
  const targetDir = join(resourcesDir, ZUSAGE_RESOURCES_DIR_NAME);
  await rm(targetDir, { force: true, recursive: true });
  await mkdir(targetDir, { recursive: true });
  await cp(runtimeSourceDir, targetDir, { recursive: true });
  return targetDir;
}

/**
 * 对 staging 目录（asar 解包结果）执行注入。返回是否变更。
 * @param {{ stagingDir: string }} options
 */
export async function injectZusageIntoStaging({ stagingDir }) {
  const entryPath = join(stagingDir, ...ZUSAGE_ASAR_ENTRY.split("/"));
  const entryStat = await stat(entryPath).catch(() => null);
  if (!entryStat?.isFile()) {
    throw new Error(
      `[zusage] asar staging 内缺少入口 ${ZUSAGE_ASAR_ENTRY}（${entryPath}）：` +
        `上游改了桌面主进程产物布局，需同步更新本模块`,
    );
  }
  const source = await readFile(entryPath, "utf8");
  const next = applyZusageInjectLine(source);
  if (next === null) {
    console.log(`[zusage] 注入行已存在，跳过（${ZUSAGE_ASAR_ENTRY}）`);
    return false;
  }
  await writeFile(entryPath, next, "utf8");
  console.log(`[zusage] 已注入 asar 入口（${ZUSAGE_ASAR_ENTRY}）`);
  return true;
}

/** 便捷入口：解析本包内置的 vendored runtime 源目录。 */
export function resolveVendoredRuntimeDir(desktopPackageRoot) {
  return resolve(desktopPackageRoot, "third-party", "zusage", "runtime");
}

/** 是否禁用注入（打包调试用）。 */
export function isZusageOverlayDisabled() {
  return process.env.ZCODE_SKIP_ZUSAGE_OVERLAY === "1";
}
