import assert from "node:assert/strict";
import test from "node:test";
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
