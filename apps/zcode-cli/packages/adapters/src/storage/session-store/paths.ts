import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { maybeThrowStorageFsFault } from "../fs-fault-injection.js";

/**
 * usage 会话库的基目录：显式 `ZCODE_DATA_BASE_DIR`（桌面便携态由 main 下发）优先，
 * 否则为用户主目录。独立 CLI 不设该变量，行为不变；SSH 远端 CLI 不继承该变量，
 * 远端库仍在远端用户主目录。
 */
export function resolveSessionDbBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const baseDir = env.ZCODE_DATA_BASE_DIR?.trim();
  return baseDir && baseDir.length > 0 ? baseDir : homedir();
}

export function getDefaultSessionDbPath(): string {
  // 便携版（数据根 = exe 目录）下 usage 库必须随程序走，否则迁移时丢用量历史；
  // 此前裸用 homedir()，ZCODE_DATA_BASE_DIR 被无视，是便携数据目录功能的一致性缺口。
  return join(resolveSessionDbBaseDir(), ".zcode", "cli", "db", "db.sqlite");
}

export function ensureParentDir(filePath: string): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    maybeThrowStorageFsFault({ operation: "mkdir", path: parent });
    mkdirSync(parent, { recursive: true });
  }
}
