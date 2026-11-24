#!/usr/bin/env node
import { realpathSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * 当前模块是否正作为 CLI 入口被执行（例如 `node scripts/ci/desktop-release-info.mjs …`）。
 *
 * CI 脚本既被 workflow 当命令行执行，也被其它脚本或测试 import 以复用导出的函数。
 * 被 import 时不能运行命令行部分：那里会解析 process.argv、读写文件甚至 process.exit。
 *
 * @param {string} moduleUrl 调用方的 import.meta.url
 * @returns {boolean}
 */
export function isCliEntryPoint(moduleUrl) {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    // Node 解析入口模块时默认跟随符号链接，import.meta.url 是真实路径，这里与之对齐。
    const invokedUrl = pathToFileURL(realpathSync(invoked)).href;
    // Windows 的盘符大小写不参与路径比较。
    return process.platform === "win32"
      ? invokedUrl.toLowerCase() === moduleUrl.toLowerCase()
      : invokedUrl === moduleUrl;
  } catch {
    return false;
  }
}
