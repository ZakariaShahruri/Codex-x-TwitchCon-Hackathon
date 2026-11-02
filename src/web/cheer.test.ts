import test from "node:test";
import assert from "node:assert/strict";
import { safeCheerName } from "../../web/overlay/cheer-utils.js";

test("cheer labels are sanitized and limited to 20 characters", () => {
  assert.equal(safeCheerName("<script>alert(1)</script>"), "scriptalert1script");
  assert.equal(safeCheerName("A_B- C"), "A_BC");
  assert.equal(safeCheerName("abcdefghijklmnopqrstuvwxy"), "abcdefghijklmnopqrst");
  assert.equal(safeCheerName("!!!"), "viewer");
});
