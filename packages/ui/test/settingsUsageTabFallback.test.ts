import assert from "node:assert/strict";
import test from "node:test";
import { shouldFallbackSettingsUsageTabToApp } from "../src/lib/settingsNavigation.js";

// NewAPI 标签与 Coding Plan 共用 settings 的 usage 分区，但它没有“套餐存在性”这个前提。
// 回归点：SettingsPage 曾把所有非 app tab 都折算成 codingPlan 传给回退判定，
// 导致用户没有 Coding Plan 时，刚点开的 NewAPI 标签会被立刻切回 App 用量。
test("NewAPI usage tab never falls back to app usage", () => {
  assert.equal(
    shouldFallbackSettingsUsageTabToApp({
      activeTab: "newApi",
      checkingCodingPlanTab: false,
      loadingModelProviders: false,
      showCodingPlanTab: false,
    }),
    false,
  );
});

test("coding plan tab still falls back when no plan is available", () => {
  assert.equal(
    shouldFallbackSettingsUsageTabToApp({
      activeTab: "codingPlan",
      checkingCodingPlanTab: false,
      loadingModelProviders: false,
      showCodingPlanTab: false,
    }),
    true,
  );
});

test("coding plan tab is kept while providers or entitlement are still loading", () => {
  assert.equal(
    shouldFallbackSettingsUsageTabToApp({
      activeTab: "codingPlan",
      checkingCodingPlanTab: true,
      loadingModelProviders: false,
      showCodingPlanTab: false,
    }),
    false,
  );
  assert.equal(
    shouldFallbackSettingsUsageTabToApp({
      activeTab: "codingPlan",
      checkingCodingPlanTab: false,
      loadingModelProviders: true,
      showCodingPlanTab: false,
    }),
    false,
  );
});

test("app usage tab is never redirected", () => {
  assert.equal(
    shouldFallbackSettingsUsageTabToApp({
      activeTab: "app",
      checkingCodingPlanTab: false,
      loadingModelProviders: false,
      showCodingPlanTab: false,
    }),
    false,
  );
});
