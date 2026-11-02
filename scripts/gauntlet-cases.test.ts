import assert from "node:assert/strict";
import test from "node:test";
import type { Box, LeakKind } from "../src/shared/events.js";
import { detectApiKeys, detectEmails, detectPasswords } from "../src/shield/detectors/index.js";
import { flashCases, gauntletCases, type GauntletCase } from "../tools/gauntlet/cases.js";

const box: Box = { x: 0, y: 0, w: 12, h: 12 };
const lineFor = (text: string) => ({ text, box, words: text.split(/\s+/u).map((word) => ({ text: word, box })) });

function detect(example: GauntletCase) {
  const line = lineFor(example.text);
  return [...detectApiKeys([line]), ...detectEmails([line]), ...detectPasswords([line])];
}

test("Leak Gauntlet normal cases agree with Tier 1 text detectors", () => {
  assert.ok(gauntletCases.length >= 20, "headline set must contain at least 20 cases");
  const ids = gauntletCases.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length, "case IDs must be unique");
  const failures: string[] = [];
  for (const example of gauntletCases) {
    const actual = detect(example).map((hit) => hit.kind);
    if (example.kind === null) {
      if (actual.length) failures.push(`${example.id}: decoy detected as ${actual.join(", ")}`);
    } else if (!actual.includes(example.kind)) {
      failures.push(`${example.id}: expected ${example.kind}, got ${actual.join(", ") || "none"}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("every Gauntlet secret is a distinct leak to the engine", () => {
  // One value is one leak, so two cases sharing a fingerprint would score as a miss.
  const owners = new Map<string, string>();
  for (const example of [...gauntletCases, ...flashCases]) {
    for (const hit of detect(example)) {
      const owner = owners.get(hit.fingerprint);
      assert.ok(owner === undefined || owner === example.id, `${example.id} shares a leak fingerprint with ${owner}`);
      owners.set(hit.fingerprint, example.id);
    }
  }
});

test("flash cases use the same detector contract but remain separately identifiable", () => {
  assert.ok(flashCases.length > 0);
  assert.ok(flashCases.every((example) => example.size === "flash" && example.kind !== null));
  for (const example of flashCases) assert.ok(detect(example).map((hit) => hit.kind).includes(example.kind as LeakKind), example.id);
});
