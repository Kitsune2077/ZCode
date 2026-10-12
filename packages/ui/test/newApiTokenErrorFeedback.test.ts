import assert from "node:assert/strict";
// 官方 v3.15.1 已把单测迁移到 vitest：root vitest 会收集所有 *.test.ts，
// node:test 风格的文件因为没有 vitest 套件而整体报 No test suite found。
import { test } from "vitest";
import { resolveNewApiTokenErrorFeedbackMessageId } from "../src/lib/newApiTokenErrorFeedback.js";

test("scope-denial codes map to the scope guidance message", () => {
  assert.equal(
    resolveNewApiTokenErrorFeedbackMessageId(
      "NewAPI request http://x/api/token/ failed with HTTP 403 (ACCESS_TOKEN_SCOPE_DENIED) token scope is denied.",
    ),
    "login.newApi.tokenError.scopeDenied",
  );
  assert.equal(
    resolveNewApiTokenErrorFeedbackMessageId("... HTTP 403 (ACCESS_TOKEN_ROUTE_UNDECLARED)"),
    "login.newApi.tokenError.scopeDenied",
  );
});

test("expiry and legacy-retirement codes map to the regenerate message", () => {
  assert.equal(
    resolveNewApiTokenErrorFeedbackMessageId("... HTTP 401 (ACCESS_TOKEN_EXPIRED)"),
    "login.newApi.tokenError.expired",
  );
  assert.equal(
    resolveNewApiTokenErrorFeedbackMessageId("... HTTP 401 (ACCESS_TOKEN_LEGACY_RETIRED)"),
    "login.newApi.tokenError.expired",
  );
});

test("unknown errors and empty input pass through untouched", () => {
  assert.equal(
    resolveNewApiTokenErrorFeedbackMessageId("NewAPI request ... failed with HTTP 500."),
    null,
  );
  assert.equal(resolveNewApiTokenErrorFeedbackMessageId(null), null);
  assert.equal(resolveNewApiTokenErrorFeedbackMessageId(""), null);
});
