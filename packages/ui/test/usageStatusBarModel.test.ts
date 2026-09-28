import assert from "node:assert/strict";
import test from "node:test";
import type { V4ConversationUsageDetailResult } from "@zcode/shared/zcode-protocol-v4";
import {
  buildUsageStatusBarModel,
  formatDurationMs,
  formatFullTokenCount,
  formatTokensPerSecond,
  hasUsageStatusBarContent,
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
  assert.equal(model.generation?.tokensPerSecond, 100);
  assert.equal(model.generation?.modelId, "glm-5.3");
  assert.equal(hasUsageStatusBarContent(model), true);
});

test("generation is hidden when the generation window is unknown", () => {
  for (const generationMs of [null, 0] as const) {
    const model = buildUsageStatusBarModel({
      detail: detail({
        requestId: "req-1",
        modelId: "glm-5.3",
        status: "running",
        outputTokens: 500,
        generationMs,
        durationMs: null,
        timeToFirstTokenMs: null,
      }),
    });
    assert.equal(model.generation, null);
    assert.equal(hasUsageStatusBarContent(model), false);
  }
});

test("no session or no detail hides the bar entirely (draft mode)", () => {
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
  assert.equal(formatDurationMs("en-US", 1_234), "1.2s");
  assert.equal(formatDurationMs("en-US", 65_000), "1m5s");
  assert.equal(formatDurationMs("en-US", null), null);
});
