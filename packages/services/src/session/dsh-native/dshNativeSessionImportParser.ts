import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import type { DshNativeImportedSessionSource } from "#src/session/dsh-native/dshNativeSessionTypes.js";

type MutableRecord = Record<string, unknown>;

function isObjectRecord(value: unknown): value is MutableRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function toContentBlocks(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  // 防御：个别版本可能把 content 写成单块对象。
  return isObjectRecord(value) ? [value] : [];
}

/** Phase 1（text-only）：只提取 text 块的用户可见正文；reasoning/tool-call 等块显式跳过。 */
function extractVisibleTextFromContent(content: unknown): string | null {
  const texts: string[] = [];
  for (const block of toContentBlocks(content)) {
    if (!isObjectRecord(block) || block.type !== "text") {
      continue;
    }
    if (typeof block.text !== "string") {
      continue;
    }
    const normalized = block.text.replace(/\r\n/g, "\n").trim();
    if (normalized.length > 0) {
      texts.push(normalized);
    }
  }
  return texts.length > 0 ? texts.join("\n\n") : null;
}

/**
 * 解析 DSH 会话事件流为可导入消息。
 *
 * 事件类型白名单：user/message、assistant/message（text 块）、session/title、model/selection；
 * turn/step/tool/system/request/compaction/session-log-* 等元事件一律跳过。
 * user/message 开启新轮次；同一轮内多条 assistant/message 的 text 块聚合为一轮回复
 * （与 OpenCode 导入同因：保证导入后仍是“用户一轮 + assistant 一轮”的最小可渲染结构）。
 */
export function parseDshNativeSession(params: {
  sessionId: string;
  directory: string;
  sourcePath: string;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
  records: readonly MutableRecord[];
}): DshNativeImportedSessionSource {
  const messages: DshNativeImportedSessionSource["messages"] = [];
  let sessionTitle: string | undefined;
  let model: string | undefined;
  let createdAt: number | undefined;
  let firstUserTimestamp: number | undefined;
  let lastTurnTimestamp: number | undefined;
  let currentTurnIndex = -1;
  let pendingAssistantContent = "";
  let pendingAssistantTimestamp: number | undefined;
  // 时间戳兜底链的终点：事件流缺失 time 且无 fallback 时仍需产出可排序的确定值。
  const fallbackTime = params.fallbackCreatedAt ?? params.fallbackUpdatedAt ?? 0;

  const flushPendingAssistant = () => {
    if (!pendingAssistantContent || currentTurnIndex < 0) {
      pendingAssistantContent = "";
      pendingAssistantTimestamp = undefined;
      return;
    }
    const timestamp = pendingAssistantTimestamp ?? lastTurnTimestamp ?? fallbackTime;
    messages.push({
      role: "assistant",
      content: pendingAssistantContent,
      timestamp,
      turnIndex: currentTurnIndex,
    });
    lastTurnTimestamp = Math.max(lastTurnTimestamp ?? timestamp, timestamp);
    pendingAssistantContent = "";
    pendingAssistantTimestamp = undefined;
  };

  for (const record of params.records) {
    const data = isObjectRecord(record.data) ? record.data : undefined;
    const recordTime = readTimestamp(record.time);

    switch (record.type) {
      case "session": {
        createdAt ??= readTimestamp(record.createdAt) ?? params.fallbackCreatedAt;
        continue;
      }
      case "session/title": {
        const title = typeof data?.title === "string" ? data.title.trim() : "";
        if (title) {
          // 最新一条标题生效。
          sessionTitle = title;
        }
        continue;
      }
      case "model/selection": {
        if (!model && typeof data?.model === "string" && data.model.trim()) {
          model = data.model.trim();
        }
        continue;
      }
      case "user/message": {
        const text = data ? extractVisibleTextFromContent(data.content) : null;
        if (!text) {
          continue;
        }
        flushPendingAssistant();
        currentTurnIndex += 1;
        const timestamp = recordTime ?? lastTurnTimestamp ?? createdAt ?? fallbackTime;
        firstUserTimestamp ??= timestamp;
        lastTurnTimestamp = Math.max(lastTurnTimestamp ?? timestamp, timestamp);
        messages.push({
          role: "user",
          content: text,
          timestamp,
          turnIndex: currentTurnIndex,
        });
        continue;
      }
      case "assistant/message": {
        const message = isObjectRecord(data?.message) ? data.message : undefined;
        const text = message ? extractVisibleTextFromContent(message.content) : null;
        if (!text) {
          continue;
        }
        if (currentTurnIndex < 0) {
          // 开头的孤儿 assistant 文本挂到第 0 轮。
          currentTurnIndex = 0;
        }
        pendingAssistantContent = pendingAssistantContent
          ? `${pendingAssistantContent}\n\n${text}`
          : text;
        pendingAssistantTimestamp ??= recordTime ?? lastTurnTimestamp;
        continue;
      }
      default:
        // 白名单外的元事件（turn/step/tool/system/request/compaction/session-log-* 等）。
        continue;
    }
  }

  flushPendingAssistant();

  if (messages.length === 0) {
    throw new Error(
      `[dsh-native] DSH 原生 session ${params.sessionId} 没有可导入的可见消息`,
    );
  }

  const firstUserMessage = messages.find((message) => message.role === "user");
  const resolvedCreatedAt =
    firstUserTimestamp ?? createdAt ?? params.fallbackCreatedAt ?? lastTurnTimestamp ?? 0;
  const resolvedUpdatedAt = Math.max(
    lastTurnTimestamp ?? 0,
    params.fallbackUpdatedAt ?? 0,
    resolvedCreatedAt,
  );
  return {
    provider: "deepseekHarness",
    sessionId: params.sessionId,
    workspacePath: params.directory,
    sourcePath: params.sourcePath,
    createdAt: resolvedCreatedAt,
    updatedAt: resolvedUpdatedAt,
    title: sessionTitle || deriveSessionTitle(firstUserMessage?.content ?? "", []),
    migrationSource: "deepseekHarness",
    ...(model ? { model } : {}),
    messages,
  };
}
