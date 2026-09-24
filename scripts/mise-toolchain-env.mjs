import { delimiter, dirname } from "node:path";

/**
 * 让所有子进程使用和启动器相同的 Node runtime。
 *
 * `mise run` 通过 shell 执行 TOML task；当另一套 Node 出现在
 * 子 shell 的 PATH 前面时，pnpm 会用错误的 runtime 启动 package script，
 * 即使 task 本身已经由 mise 选中了正确版本。把启动器的 Node 目录置首，
 * 可以在不依赖用户 home 目录布局的前提下固定整条子进程链路。
 */
export function withPinnedNodePath(env, nodeExecutablePath) {
  const nodeDirectory = dirname(nodeExecutablePath);
  // Windows 环境块的键名大小写不固定：真实 PATH 可能以 `path` / `Path` / `PATH`
  // 任何形态出现（部分终端、CI runner、pnpm 生命周期会改写大小写）。
  //
  // bug 原因：这里曾经只认 `PATH` / `Path` 两种字面量（普通对象的键访问是大小写
  // 敏感的）。真实键是小写 `path` 时 `existingPath` 被读成空字符串，返回对象里
  // 同时留下原始 `path`（完整值）和新写入的 `Path`（只剩 node 目录）。Windows
  // 对大小写不同的同名环境键不做合并，子进程取到的是后写入的那条——整条 PATH
  // 被截断成 node 目录，pnpm / cmd.exe 相继报“不是内部或外部命令”
  // （dev:desktop 在 Windows 的实际故障链）。
  //
  // 修复：按大小写不敏感找出**全部**同名键，取第一个非空字符串作为真实 PATH，
  // 把这些键全部删掉后写回唯一的规范键（win32 用 `Path`，其它平台用 `PATH`），
  // 再在前面垫上启动器的 Node 目录。任何形态都只产生一个 PATH 条目。
  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
  const canonicalKey = process.platform === "win32" ? "Path" : "PATH";
  const existingPath =
    pathKeys
      .map((key) => env[key])
      .find((value) => typeof value === "string" && value.length > 0) ?? "";
  const strippedEnv = { ...env };
  for (const key of pathKeys) {
    delete strippedEnv[key];
  }
  const pathEntries = existingPath
    .split(delimiter)
    .filter(Boolean)
    .filter((entry) => entry !== nodeDirectory);

  return {
    ...strippedEnv,
    [canonicalKey]: [nodeDirectory, ...pathEntries].join(delimiter),
  };
}
