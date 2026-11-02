import assert from "node:assert/strict";
import test from "node:test";
import { createGauntletPlan } from "./plan.js";

test("gauntlet plan is seeded, varied, and separates secrets, decoys, and flashes", () => {
  const first = createGauntletPlan(12345, 1_250);
  assert.deepEqual(createGauntletPlan(12345, 1_250), first);
  assert.notDeepEqual(createGauntletPlan(54321, 1_250), first);
  const secretRounds = first.filter((item) => item.label.startsWith("round "));
  assert.equal(secretRounds.length, 25);
  assert.equal(secretRounds[0]?.label, "round 1/25");
  assert.equal(new Set(first.map(({ x, y }) => `${x},${y}`)).size > 1, true);
  assert.equal(new Set(first.map(({ fontPx }) => fontPx)).size > 1, true);
  assert.equal(new Set(first.map(({ theme }) => theme)).size, 2);
  assert.equal(new Set(first.map(({ style }) => style)).size, 4);
  assert.ok(first.filter((item) => item.label.startsWith("flash ")).every((item) => item.visibleMs >= 250 && item.visibleMs <= 600));
});
