import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import type { ZCodeInstalledImportedSessionSource } from "#src/session/zcode-installed-native/zcodeInstalledSessionTypes.js";

/** message 行（data 为 JSON blob，与 ZCode CLI MessageInfo 结构同源）。 */
export interface ZCodeInstalledMessageRow {
  id: string;
  timeCreated: number | null;
  data: unknown;
}

/** part 行；Phase 1 只消费 type=text 的正文。 */
export interface ZCodeInstalledPartRow {
  timeCreated: number | null;
  data: unknown;
}

type MutableRecord = Record<string, unknown>;

function isObjectRecord(value: unknown): value is MutableRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: unknown): MutableRecord | null {
  if (isObjectRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

/** Phase 1（text-only）只提取 text part 的用户可见正文；reasoning/tool/step/patch/file 显式跳过。 */
function extractVisibleTextFromParts(parts: readonly unknown[]): string | null {
  const texts: string[] = [];
  for (const part of parts) {
    const record = parseJsonRecord(part);
    if (!record || record.type !== "text") {
      continue;
    }
    if (typeof record.text !== "string") {
      continue;
    }
    const normalized = record.text.replace(/\r\n/g, "\n").trim();
    if (normalized.length > 0) {
      texts.push(normalized);
    }
  }
  return texts.length > 0 ? texts.join("\n\n") : null;
}

export function parseZCodeInstalledSession(params: {
  sessionId: string;
  directory: string;
  title?: string;
  timeCreated: number;
  timeUpdated: number;
  sourcePath: string;
  messages: readonly ZCodeInstalledMessageRow[];
  partsByMessageId: ReadonlyMap<string, readonly ZCodeInstalledPartRow[]>;
}): ZCodeInstalledImportedSessionSource {
  const messages: ZCodeInstalledImportedSessionSource["messages"] = [];
  let firstUserTimestamp: number | undefined;
  let lastTurnTimestamp: number | undefined;
  let model: string | undefined;
  let currentTurnIndex = -1;
  let pendingAssistantContent = "";
  let pendingAssistantTimestamp: number | undefined;

  const flushPendingAssistant = () => {
    if (!pendingAssistantContent || currentTurnIndex < 0) {
      pendingAssistantContent = "";
      pendingAssistantTimestamp = undefined;
      return;
    }
    // 关键业务逻辑：ZCode CLI 与 OpenCode 同源，一轮用户输入对应多条 assistant step 消息，
    // 正文散布在其间的 text part；聚合到下一条 user 消息或结束时统一 flush，
    // 保证导入后仍是“用户一轮 + assistant 一轮”的最小可渲染结构。
    const timestamp = pendingAssistantTimestamp ?? lastTurnTimestamp ?? params.timeUpdated;
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

  const appendUserTurn = (content: string, timestamp: number | undefined) => {
    flushPendingAssistant();
    currentTurnIndex += 1;
    const resolved = timestamp ?? lastTurnTimestamp ?? params.timeCreated;
    firstUserTimestamp ??= resolved;
    lastTurnTimestamp = Math.max(lastTurnTimestamp ?? resolved, resolved);
    messages.push({
      role: "user",
      content,
      timestamp: resolved,
      turnIndex: currentTurnIndex,
    });
  };

  for (const row of params.messages) {
    const record = parseJsonRecord(row.data);
    if (!record) {
      continue;
    }
    const role = record.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const timestamp =
      readTimestamp((record.time as MutableRecord | undefined)?.created) ??
      row.timeCreated ??
      undefined;
    const parts = params.partsByMessageId.get(row.id);
    const text =
      parts && parts.length > 0
        ? extractVisibleTextFromParts(parts.map((part) => part.data))
        : null;

    if (role === "user") {
      // 纯 tool_result 承载的 user 消息没有 text part，Phase 1 跳过而不是伪造占位。
      if (text) {
        appendUserTurn(text, timestamp);
      }
      continue;
    }

    if (!text) {
      // 纯工具 step 消息（无 text part）不贡献可见内容。
      continue;
    }
    if (currentTurnIndex < 0) {
      // 开头的孤儿 assistant 文本没有对应 user 轮；仍保留内容，挂到首个虚拟轮。
      currentTurnIndex = 0;
    }
    // modelID/model 记录的是来源端运行态，仅用于列表展示，不参与续聊时的模型选择。
    if (!model && typeof record.modelID === "string" && record.modelID.trim()) {
      model = record.modelID.trim();
    }
    pendingAssistantContent = pendingAssistantContent
      ? `${pendingAssistantContent}\n\n${text}`
      : text;
    pendingAssistantTimestamp ??= timestamp ?? lastTurnTimestamp;
  }

  flushPendingAssistant();

  if (messages.length === 0) {
    throw new Error(
      `[zcode-installed] ZCode 安装版 session ${params.sessionId} 没有可导入的可见消息`,
    );
  }

  const firstUserMessage = messages.find((message) => message.role === "user");
  return {
    provider: "zcodeInstalled",
    sessionId: params.sessionId,
    workspacePath: params.directory,
    sourcePath: params.sourcePath,
    createdAt: firstUserTimestamp ?? params.timeCreated,
    updatedAt: Math.max(lastTurnTimestamp ?? 0, params.timeUpdated),
    title: params.title?.trim() || deriveSessionTitle(firstUserMessage?.content ?? "", []),
    migrationSource: "zcodeInstalled",
    ...(model ? { model } : {}),
    messages,
  };
}
