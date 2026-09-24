#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * 共享的下载入口。
 *
 * 原来内联在 scripts/prepare-prebuilds.mjs；飞书 CLI 的内置二进制准备需要同一套
 * 重试与失败语义，因此抽成模块，避免两份实现各自演化。
 */

export async function download(url, destinationPath) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} (${url})`);
  }
  if (!response.body) {
    throw new Error(`Download failed: empty response body (${url})`);
  }

  // 原实现使用 response.pipe(file) + finish 监听，网络中断时可能既不 resolve 也不 reject，
  // 最终触发 Node 24 的 unsettled top-level await。改为 pipeline，确保异常路径可观测且可失败退出。
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destinationPath, { flags: "w" }),
  );
}

export async function downloadWithRetry(url, destinationPath, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await download(url, destinationPath);
      return;
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      console.warn(`  [warn] download attempt ${attempt}/${maxAttempts} failed: ${url}`);
      console.warn(`  [warn] retry reason: ${String(error)}`);
    }
  }
}
