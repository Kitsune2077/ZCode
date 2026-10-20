import type { ZCodeSessionFile } from "@zcode/shared";
import {
  writeImportedLegacyTaskSnapshot,
  type LegacyTaskSessionFile,
} from "#src/session/legacyTaskSessionFile.js";

const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;

export function buildSearchableTextFromMessages(messages: ZCodeSessionFile["messages"]): string {
  const parts: string[] = [];
  let total = 0;
  for (const message of messages) {
    const content = message.content.trim();
    if (!content) {
      continue;
    }
    const next = total > 0 ? `\n${content}` : content;
    if (total + next.length > TASK_SEARCH_TEXT_MAX_CHARS) {
      parts.push(next.slice(0, TASK_SEARCH_TEXT_MAX_CHARS - total));
      break;
    }
    parts.push(next);
    total += next.length;
  }
  return parts.join("");
}

export async function writeImportedClaudeTaskSnapshot(params: {
  sessionFile: LegacyTaskSessionFile;
}): Promise<void> {
  // legacy ACP 下线后 importClaudeSessions 变成空桩，导入虽复制了 jsonl 却没有写
  // ~/.zcode/v2/sessions/{hash}/{taskId}.json。现在真实 ZCode session 承担续聊，legacy snapshot
  // 只保存过滤后的迁移备份，避免 Claude 来源运行态污染当前模型选择。
  // 快照写入统一委托 legacyTaskSessionFile 的共享原子写，OpenCode/DSH 导入同源，
  // 合并时不再保留本文件内的第二份写入实现（上游已删除 persistImportedClaudeTask 持久化路径）。
  await writeImportedLegacyTaskSnapshot(params);
}
