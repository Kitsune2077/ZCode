import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUsageStatusBarModel,
  formatCompactTokenCount,
  formatFullTokenCount,
  hasUsageStatusBarContent,
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
  };
}

test("draft mode keeps only the today metric", () => {
  const model = buildUsageStatusBarModel({ taskUsage: null, todayTotalTokens: 12_345 });
  assert.equal(model.session, null);
  assert.equal(model.todayTotalTokens, 12_345);
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
