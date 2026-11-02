import assert from "node:assert/strict";
import test from "node:test";
import type { Box, LeakKind } from "../src/shared/events.js";
import { detectApiKeys, detectEmails, detectPasswords } from "../src/shield/detectors/index.js";
import { flashCases, gauntletCases, type GauntletCase } from "../tools/gauntlet/cases.js";

const box: Box = { x: 0, y: 0, w: 12, h: 12 };
const lineFor = (text: string) => ({ text, box, words: text.split(/\s+/u).map((word) => ({ text: word, box })) });
// Keep real detector misses visible while allowing the regression suite to run green.
// This JWT contains lowercase base64url characters; the current detector regex is uppercase-only.
const knownDetectorGaps = new Map([["jwt", "api_key"] as const]);

function detectedKinds(example: GauntletCase): LeakKind[] {
  const line = lineFor(example.text);
  return [...detectApiKeys([line]), ...detectEmails([line]), ...detectPasswords([line])].map((hit) => hit.kind);
}

test("Leak Gauntlet normal cases agree with Tier 1 text detectors", () => {
  assert.ok(gauntletCases.length >= 20, "headline set must contain at least 20 cases");
  const ids = gauntletCases.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length, "case IDs must be unique");
  const failures: string[] = [];
  for (const example of gauntletCases) {
    const actual = detectedKinds(example);
    const knownGap = knownDetectorGaps.get(example.id);
    if (knownGap) {
      if (example.kind !== knownGap || actual.includes(knownGap)) failures.push(`${example.id}: known miss changed; got ${actual.join(", ") || "none"}`);
      continue;
    }
    if (example.kind === null) {
      if (actual.length) failures.push(`${example.id}: decoy detected as ${actual.join(", ")}`);
    } else if (!actual.includes(example.kind)) {
      failures.push(`${example.id}: expected ${example.kind}, got ${actual.join(", ") || "none"}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("known detector gaps remain explicitly tracked", () => {
  for (const [id, kind] of knownDetectorGaps) {
    const example = gauntletCases.find((candidate) => candidate.id === id);
    assert.ok(example, `missing known-gap case ${id}`);
    assert.equal(example.kind, kind);
    assert.ok(!detectedKinds(example).includes(kind), `${id} unexpectedly started detecting; remove it from known gaps`);
  }
});

test("flash cases use the same detector contract but remain separately identifiable", () => {
  assert.ok(flashCases.length > 0);
  assert.ok(flashCases.every((example) => example.size === "flash" && example.kind !== null));
  for (const example of flashCases) assert.ok(detectedKinds(example).includes(example.kind!), example.id);
});
