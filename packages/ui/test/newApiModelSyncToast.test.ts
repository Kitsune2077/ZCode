import assert from "node:assert/strict";
// 官方 v3.15.1 已把单测迁移到 vitest：root vitest 会收集所有 *.test.ts，
// node:test 风格的文件因为没有 vitest 套件而整体报 No test suite found。
import { test } from "vitest";
import { pickNewApiModelSyncToastMessageId } from "../src/lib/newApiModelSyncToast.js";

test("no difference produces no toast message", () => {
  assert.equal(pickNewApiModelSyncToastMessageId(0, 0), null);
});

test("additions and removals each get their dedicated message", () => {
  assert.equal(pickNewApiModelSyncToastMessageId(3, 0), "newapi.modelSync.toast.added");
  assert.equal(pickNewApiModelSyncToastMessageId(0, 2), "newapi.modelSync.toast.removed");
});

test("mixed changes use the combined message", () => {
  assert.equal(pickNewApiModelSyncToastMessageId(2, 1), "newapi.modelSync.toast.addedAndRemoved");
});
