import assert from "node:assert/strict";
// 官方 v3.15.1 已把单测迁移到 vitest：root vitest 会收集所有 *.test.ts，
// node:test 风格的文件因为没有 vitest 套件而整体报 No test suite found。
import { test } from "vitest";
import type { V4ConversationUsageDetailResult } from "@zcode/shared/zcode-protocol-v4";
import {
  buildUsageStatusBarModel,
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
