import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskTokenUsageResult } from "@zcode/shared";
import type { V4ConversationUsageDetailResult } from "@zcode/shared/zcode-protocol-v4";
import {
  buildUsageStatusBarModel,
  formatCompactTokenCount,
  formatDurationMs,
  formatFullTokenCount,
  formatPercent,
  formatTokensPerSecond,
  hasUsageStatusBarContent,
  resolveGenerationSpeedTier,
} from "../src/v4/composer/usageStatusBarModel.js";

function taskUsage(overrides: Partial<{ totalTokens: number; modelRequestCount: number }> = {}) {
  return {
    sessionId: "sess-1",
    totalTokens: overrides.totalTokens ?? 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    modelRequestCount: overrides.modelRequestCount ?? 0,
    modelErrorCount: 0,
    inputBaselineBySource: {},
  } satisfies ZCodeTaskTokenUsageResult;
}

function detail(overrides: {
  latestRequest?: V4ConversationUsageDetailResult["latestRequest"];
  latestTurn?: V4ConversationUsageDetailResult["latestTurn"];
  toolSummary?: V4ConversationUsageDetailResult["toolSummary"];
}): V4ConversationUsageDetailResult {
  return {
    sessionId: "sess-1",
    latestRequest: overrides.latestRequest ?? null,
    latestTurn: overrides.latestTurn ?? null,
    toolSummary: overrides.toolSummary ?? { toolCallCount: 0, toolErrorCount: 0, items: [] },
  };
}

test("draft mode keeps only the today metric", () => {
  const model = buildUsageStatusBarModel({ taskUsage: null, todayTotalTokens: 12_345 });
  assert.equal(model.session, null);
  assert.equal(model.todayTotalTokens, 12_345);
  assert.equal(model.turn, null);
  assert.equal(model.generation, null);
  assert.equal(model.tools, null);
  assert.equal(hasUsageStatusBarContent(model), true);
});

test("zero totals are hidden instead of rendering 0", () => {
  const model = buildUsageStatusBarModel({
    taskUsage: taskUsage({ totalTokens: 0 }),
    todayTotalTokens: 0,
  });
  assert.equal(model.session, null);
  assert.equal(model.todayTotalTokens, null);
  assert.equal(hasUsageStatusBarContent(model), false);
});

test("session metric carries the request count for tooltips", () => {
  const model = buildUsageStatusBarModel({
    taskUsage: taskUsage({ totalTokens: 98_765, modelRequestCount: 42 }),
    todayTotalTokens: 1_000,
  });
  assert.deepEqual(model.session, { totalTokens: 98_765, modelRequestCount: 42 });
  assert.equal(model.todayTotalTokens, 1_000);
});

test("generation speed derives from first-token to completion", () => {
  const model = buildUsageStatusBarModel({
    taskUsage: taskUsage({ totalTokens: 100 }),
    todayTotalTokens: null,
    detail: detail({
      latestRequest: {
        requestId: "req-1",
        modelId: "glm-5.3",
        status: "completed",
        outputTokens: 1_000,
        generationMs: 10_000,
        durationMs: 15_000,
        timeToFirstTokenMs: 1_200,
      },
    }),
  });
  // 1000 tokens / 10s = 100 tok/s（不是用整请求时长 15s 算出的 66.7）。
  assert.equal(model.generation?.tokensPerSecond, 100);
  assert.equal(model.generation?.modelId, "glm-5.3");
  assert.equal(resolveGenerationSpeedTier(100), "fast");
});

test("generation is hidden when the generation window is unknown", () => {
  const model = buildUsageStatusBarModel({
    taskUsage: taskUsage({ totalTokens: 100 }),
    todayTotalTokens: null,
    detail: detail({
      latestRequest: {
        requestId: "req-1",
        modelId: "glm-5.3",
        status: "running",
        outputTokens: 500,
        generationMs: null,
        durationMs: null,
        timeToFirstTokenMs: null,
      },
    }),
  });
  assert.equal(model.generation, null);
  assert.equal(resolveGenerationSpeedTier(70), "fast");
  assert.equal(resolveGenerationSpeedTier(55), "medium");
  assert.equal(resolveGenerationSpeedTier(12.5), "slow");
});

test("turn metric exposes five-way breakdown and cache hit rate", () => {
  const model = buildUsageStatusBarModel({
    taskUsage: taskUsage({ totalTokens: 1 }),
    todayTotalTokens: null,
    detail: detail({
      latestTurn: {
        turnId: "turn-1",
        status: "completed",
        startedAt: 1,
        durationMs: 65_000,
        timeToFirstTokenMs: 900,
        modelRequestCount: 6,
        toolCallCount: 4,
        toolErrorCount: 1,
        inputTokens: 10_000,
        outputTokens: 2_000,
        reasoningTokens: 300,
        cacheCreationTokens: 400,
        cacheReadTokens: 6_000,
        totalTokens: 12_000,
      },
    }),
  });
  assert.equal(model.turn?.totalTokens, 12_000);
  assert.equal(model.turn?.modelRequestCount, 6);
  // 命中率分母是 total input（10k），不能叠加 cache 字段。
  assert.equal(model.turn?.cacheHitRate, 0.6);
  assert.equal(formatPercent("en-US", model.turn?.cacheHitRate ?? null), "60%");
});

test("cache hit rate falls back to cache-only denominator when input is missing", () => {
  const model = buildUsageStatusBarModel({
    taskUsage: taskUsage({ totalTokens: 1 }),
    todayTotalTokens: null,
    detail: detail({
      latestTurn: {
        turnId: "turn-1",
        status: "completed",
        startedAt: 1,
        durationMs: null,
        timeToFirstTokenMs: null,
        modelRequestCount: 1,
        toolCallCount: 0,
        toolErrorCount: 0,
        inputTokens: 0,
        outputTokens: 100,
        reasoningTokens: 0,
        cacheCreationTokens: 1_000,
        cacheReadTokens: 3_000,
        totalTokens: 100,
      },
    }),
  });
  assert.equal(model.turn?.cacheHitRate, 0.75);
});

test("tool summary hides when there are no calls and surfaces errors", () => {
  const empty = buildUsageStatusBarModel({
    taskUsage: taskUsage({ totalTokens: 1 }),
    todayTotalTokens: null,
    detail: detail({}),
  });
  assert.equal(empty.tools, null);

  const withTools = buildUsageStatusBarModel({
    taskUsage: taskUsage({ totalTokens: 1 }),
    todayTotalTokens: null,
    detail: detail({
      toolSummary: {
        toolCallCount: 12,
        toolErrorCount: 2,
        items: [
          { toolName: "read", callCount: 8, errorCount: 0, avgDurationMs: 12.5 },
          { toolName: "bash", callCount: 4, errorCount: 2, avgDurationMs: null },
        ],
      },
    }),
  });
  assert.equal(withTools.tools?.toolCallCount, 12);
  assert.equal(withTools.tools?.toolErrorCount, 2);
  assert.deepEqual(withTools.tools?.items[1], { toolName: "bash", callCount: 4, errorCount: 2 });
});

test("compact formatting uses locale-appropriate notation", () => {
  assert.equal(formatCompactTokenCount("en-US", 12_345), "12.3K");
  assert.equal(formatCompactTokenCount("en-US", 1_200_000), "1.2M");
  assert.equal(formatCompactTokenCount("en-US", 0), "0");
  assert.equal(formatCompactTokenCount("en-US", Number.NaN), "0");
  assert.equal(formatCompactTokenCount("en-US", -5), "0");
});

test("full formatting never truncates", () => {
  assert.equal(formatFullTokenCount("en-US", 123_456), "123,456");
  assert.equal(formatFullTokenCount("en-US", 0), "0");
});

test("speed and duration formatting degrade defensively", () => {
  assert.equal(formatTokensPerSecond("en-US", 100.44), "100.4");
  assert.equal(formatTokensPerSecond("en-US", Number.NaN), "0");
  assert.equal(formatDurationMs("en-US", 1_234), "1.2s");
  assert.equal(formatDurationMs("en-US", 65_000), "1m5s");
  assert.equal(formatDurationMs("en-US", null), null);
  assert.equal(formatPercent("en-US", null), null);
});
