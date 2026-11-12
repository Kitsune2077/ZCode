import assert from "node:assert/strict";
// 官方 v3.15.1 已把单测迁移到 vitest：root vitest 会收集所有 *.test.ts，
// node:test 风格的文件因为没有 vitest 套件而整体报 No test suite found。
import { test } from "vitest";
import type { V4ConversationUsageDetailResult } from "@zcode/shared/zcode-protocol-v4";
import {
  advanceStreamingAnchor,
  buildStreamingLiveValues,
  buildUsageStatusBarModel,
  estimateStreamingOutputTokens,
  estimateTurnOutputTokens,
  findLatestTurnActivity,
  findStreamingAssistantText,
  formatCompactTokenCount,
  formatDurationMs,
  formatFullTokenCount,
  formatTokensPerSecond,
  hasUsageStatusBarContent,
  isUsageSnapshotRunning,
  resolveGenerationSpeedTier,
} from "../src/v4/composer/usageStatusBarModel.js";

function detail(latestRequest: V4ConversationUsageDetailResult["latestRequest"]) {
  return {
    sessionId: "sess-1",
    latestRequest,
    latestTurn: null,
    toolSummary: { toolCallCount: 0, toolErrorCount: 0, items: [] },
    subagents: { totalTokens: 0, requestCount: 0, toolCallCount: 0, sessionCount: 0, items: [] },
  } satisfies V4ConversationUsageDetailResult;
}

test("generation speed derives from first-token to completion", () => {
  const model = buildUsageStatusBarModel({
    detail: detail({
      requestId: "req-1",
      modelId: "glm-5.3",
      status: "completed",
      outputTokens: 1_000,
      generationMs: 10_000,
      durationMs: 15_000,
      timeToFirstTokenMs: 1_200,
    }),
  });
  // 1000 tokens / 10s = 100 tok/s（不是用整请求时长 15s 算出的 66.7）。
  assert.equal(model.latest?.tokensPerSecond, 100);
  assert.equal(model.latest?.modelId, "glm-5.3");
  assert.equal(model.latest?.timeToFirstTokenMs, 1_200);
  assert.equal(model.latest?.durationMs, 15_000);
  assert.equal(hasUsageStatusBarContent(model), true);
});

test("running request keeps the snapshot but has no derivable speed", () => {
  for (const generationMs of [null, 0] as const) {
    const model = buildUsageStatusBarModel({
      detail: detail({
        requestId: "req-1",
        modelId: "glm-5.3",
        status: "running",
        outputTokens: 500,
        generationMs,
        durationMs: null,
        timeToFirstTokenMs: 900,
      }),
    });
    // 快照仍在：输出量/TTFT 是有效事实，状态条不应整条消失。
    assert.equal(hasUsageStatusBarContent(model), true);
    assert.equal(model.latest?.tokensPerSecond, null);
    assert.equal(model.latest?.outputTokens, 500);
    assert.equal(model.latest?.timeToFirstTokenMs, 900);
    assert.equal(isUsageSnapshotRunning(model.latest!), true);
  }
});

test("no session or no detail yields an empty model (draft placeholder)", () => {
  assert.equal(hasUsageStatusBarContent(buildUsageStatusBarModel({ detail: null })), false);
  assert.equal(hasUsageStatusBarContent(buildUsageStatusBarModel({})), false);
});


test("streaming token estimate counts CJK per char and latin per four chars", () => {
  assert.equal(estimateStreamingOutputTokens("你好世界"), 4);
  assert.equal(estimateStreamingOutputTokens("hello world"), 3); // 10 个非空白字符 / 4 向上取整
  assert.equal(estimateStreamingOutputTokens("中文 abc"), 3); // 2 CJK + ceil(3/4)
  assert.equal(estimateStreamingOutputTokens(""), 0);
  assert.equal(estimateStreamingOutputTokens("  \n\t "), 0);
});

test("streaming row lookup takes the last streaming assistant text", () => {
  const rows = [
    { kind: "assistantText", state: "complete", text: "old", turnId: "t1", rowId: 1, createdAt: 1 },
    { kind: "assistantText", state: "streaming", text: "半截", turnId: "t2", rowId: 2, createdAt: 2 },
    { kind: "toolCall", turnId: "t2", rowId: 3, createdAt: 3 },
  ] as unknown as Parameters<typeof findStreamingAssistantText>[0];
  const found = findStreamingAssistantText(rows);
  assert.equal(found?.turnId, "t2");
  assert.equal(found?.rowId, 2);
  assert.equal(findStreamingAssistantText([]), null);
  assert.equal(findStreamingAssistantText(undefined), null);
});

test("streaming anchor resets speed per segment but keeps turn TTFT", () => {
  const empty = advanceStreamingAnchor(null, { turnId: "t1", rowId: 1, text: "" }, 1_000);
  assert.deepEqual(empty, {
    turnId: "t1",
    rowId: 1,
    turnStartedAt: 1_000,
    firstTokenAt: null,
    segmentFirstTokenAt: null,
  });
  const firstText = advanceStreamingAnchor(empty, { turnId: "t1", rowId: 1, text: "你好" }, 1_200);
  assert.equal(firstText.firstTokenAt, 1_200);
  assert.equal(firstText.segmentFirstTokenAt, 1_200);
  // 工具调用后同轮第二段：TTFT/本轮起点保留，速率起点按新段重置。
  const secondSegment = advanceStreamingAnchor(
    firstText,
    { turnId: "t1", rowId: 5, text: "继续" },
    9_000,
  );
  assert.equal(secondSegment.turnStartedAt, 1_000);
  assert.equal(secondSegment.firstTokenAt, 1_200);
  assert.equal(secondSegment.segmentFirstTokenAt, 9_000);
  // 下一轮重建全部时刻，不继承上一轮任何时间。
  const nextTurn = advanceStreamingAnchor(
    secondSegment,
    { turnId: "t2", rowId: 9, text: "新" },
    20_000,
  );
  assert.equal(nextTurn.turnStartedAt, 20_000);
  assert.equal(nextTurn.firstTokenAt, 20_000);
  assert.equal(nextTurn.segmentFirstTokenAt, 20_000);
});

test("streaming live values use segment time for speed and turn total for output", () => {
  const anchor = advanceStreamingAnchor(null, { turnId: "t1", rowId: 1, text: "x" }, 1_000);
  const values = buildStreamingLiveValues({
    text: "你好世界", // 当前段 4 token，生成 2s
    turnOutputTokens: 100, // 本轮累计（含工具调用前的段落）
    anchor,
    now: 3_000,
    minGenerationMs: 1_000,
  });
  assert.equal(values.tokensPerSecond, 2);
  assert.equal(values.outputTokens, 100);
  assert.equal(values.timeToFirstTokenMs, 0);
  assert.equal(values.durationMs, 2_000);
  assert.equal(values.generationMs, 2_000);
  // 样本不足一个 tick：不给速率，避免数字剧烈跳动。
  const tooShort = buildStreamingLiveValues({
    text: "你好世界",
    turnOutputTokens: 100,
    anchor,
    now: 1_400,
    minGenerationMs: 1_000,
  });
  assert.equal(tooShort.tokensPerSecond, null);
});

test("turn output estimate accumulates every assistant text segment of the turn", () => {
  const rows = [
    { kind: "assistantText", state: "complete", text: "你好", turnId: "t1", rowId: 1, createdAt: 1 },
    { kind: "toolCall", turnId: "t1", rowId: 2, createdAt: 2 },
    { kind: "assistantText", state: "streaming", text: "世界", turnId: "t1", rowId: 3, createdAt: 3 },
    { kind: "assistantText", state: "complete", text: "别人的", turnId: "t2", rowId: 4, createdAt: 4 },
  ] as unknown as Parameters<typeof estimateTurnOutputTokens>[0];
  assert.equal(estimateTurnOutputTokens(rows, "t1"), 4);
  assert.equal(estimateTurnOutputTokens(rows, "t2"), 3);
  assert.equal(estimateTurnOutputTokens(undefined, "t1"), 0);
});

test("latest turn activity comes from the last turn header", () => {
  const rows = [
    { kind: "turnHeader", turnId: "t1", rowId: 1, state: "completedSuccess", createdAt: 1 },
    { kind: "userInput", turnId: "t2", rowId: 2, createdAt: 2 },
    { kind: "turnHeader", turnId: "t2", rowId: 3, state: "running", createdAt: 3 },
    { kind: "toolCall", turnId: "t2", rowId: 4, createdAt: 4 },
  ] as unknown as Parameters<typeof findLatestTurnActivity>[0];
  // 工具调用空窗期没有流式正文行，但 header 仍是 running：本轮未结束。
  assert.deepEqual(findLatestTurnActivity(rows), { turnId: "t2", running: true });
  const completed = [
    ...rows,
    { kind: "turnHeader", turnId: "t3", rowId: 5, state: "completedInterrupted", createdAt: 5 },
  ] as unknown as Parameters<typeof findLatestTurnActivity>[0];
  assert.deepEqual(findLatestTurnActivity(completed), { turnId: "t3", running: false });
  // controlOnly 轮没有模型生成，不能因为 state=running 就展示生成中。
  const controlOnly = [
    { kind: "turnHeader", turnId: "t9", rowId: 9, state: "running", executionKind: "controlOnly" },
  ] as unknown as Parameters<typeof findLatestTurnActivity>[0];
  assert.deepEqual(findLatestTurnActivity(controlOnly), { turnId: "t9", running: false });
  assert.equal(findLatestTurnActivity([]), null);
  assert.equal(findLatestTurnActivity(undefined), null);
});

test("speed tiers split at 70 and 40 tokens per second", () => {
  assert.equal(resolveGenerationSpeedTier(70), "fast");
  assert.equal(resolveGenerationSpeedTier(55), "medium");
  assert.equal(resolveGenerationSpeedTier(12.5), "slow");
});

test("formatters degrade defensively", () => {
  assert.equal(formatTokensPerSecond("en-US", 100.44), "100.4");
  assert.equal(formatTokensPerSecond("en-US", Number.NaN), "0");
  assert.equal(formatFullTokenCount("en-US", 123_456), "123,456");
  assert.equal(formatFullTokenCount("en-US", 0), "0");
  assert.equal(formatCompactTokenCount("en-US", 999), "999");
  assert.equal(formatCompactTokenCount("en-US", 1_000), "1K");
  assert.equal(formatCompactTokenCount("en-US", 1_234), "1.2K");
  assert.equal(formatCompactTokenCount("en-US", 1_200_000), "1.2M");
  assert.equal(formatDurationMs("en-US", 1_234), "1.2s");
  assert.equal(formatDurationMs("en-US", 65_000), "1m5s");
  assert.equal(formatDurationMs("en-US", null), null);
});
