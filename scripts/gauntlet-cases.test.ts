import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import type { Box, LeakKind } from "../src/shared/events.js";
import { detectApiKeys, detectCards, detectEmails, detectPasswords, detectPhones, detectWatchlist } from "../src/shield/detectors/index.js";
import { flashCases, gauntletCases, gauntletWatchlist, type GauntletCase } from "../tools/gauntlet/cases.js";

const box: Box = { x: 0, y: 0, w: 12, h: 12 };
const lineFor = (text: string) => ({ text, box, words: text.split(/\s+/u).map((word) => ({ text: word, box })) });
const watchlist = gauntletWatchlist.map((entry, index) => ({ ...entry, id: `gauntlet-${index}` }));

/** Every text detector the engine runs; QR cases are images and are checked separately. */
function detect(example: GauntletCase) {
  const lines = [lineFor(example.text)];
  return [
    ...detectApiKeys(lines), ...detectEmails(lines), ...detectPasswords(lines),
    ...detectPhones(lines), ...detectCards(lines), ...detectWatchlist(lines, watchlist),
  ];
}

test("Leak Gauntlet cases agree with the detectors", () => {
  assert.ok(gauntletCases.filter((example) => example.kind !== null).length >= 30, "headline set must stay at least 30 secrets");
  const ids = gauntletCases.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length, "case IDs must be unique");
  const failures: string[] = [];
  for (const example of gauntletCases) {
    const actual = detect(example).map((hit) => hit.kind);
    if (example.kind === "qr_code") {
      if (actual.length) failures.push(`${example.id}: QR caption detected as ${actual.join(", ")}`);
    } else if (example.kind === null) {
      if (actual.length) failures.push(`${example.id}: decoy detected as ${actual.join(", ")}`);
    } else if (!actual.includes(example.kind)) {
      failures.push(`${example.id}: expected ${example.kind}, got ${actual.join(", ") || "none"}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("QR cases ship their image", () => {
  for (const example of gauntletCases.filter((item) => item.kind === "qr_code")) {
    assert.ok(example.image && existsSync(`tools/gauntlet/${example.image}`), `${example.id} image missing; run swift scripts/generate-gauntlet-qr.swift`);
  }
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
