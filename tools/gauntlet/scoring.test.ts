import assert from "node:assert/strict";
import test from "node:test";
import type { Box, LeakKind } from "../../src/shared/events.js";
import { scoreGauntlet, type GauntletLeakEvent, type GauntletRunCase } from "./scoring.js";

const region: Box = { x: 100, y: 100, w: 200, h: 40 };
const cases: GauntletRunCase[] = [
  { id: "key-a", kind: "api_key", region, paintedAt: 1_000, hiddenAt: 2_000 },
  { id: "email-b", kind: "email", region, paintedAt: 3_000, hiddenAt: 4_000 },
  { id: "future-phone", kind: "phone", region, paintedAt: 5_000, hiddenAt: 6_000 },
  { id: "brief", kind: "email", region, paintedAt: 7_000, hiddenAt: 7_400, flash: true },
  { id: "decoy", kind: null, region, paintedAt: 8_000, hiddenAt: 9_000 },
];
const event = (id: string, kind: LeakKind, at: number, box = region): GauntletLeakEvent => ({ id, kind, box, at });

test("scores mask latency and requires coverage through the delayed air window", () => {
  const result = scoreGauntlet({
    cases: [cases[0]!], detected: [event("a", "api_key", 1_100)], cleared: [{ id: "a", at: 3_000 }],
    maskLiveAt: new Map([["a", 1_180]]), enabledDetectors: ["api_key"], delayMs: 1_000,
  });
  assert.equal(result.cases[0]?.status, "blocked");
  assert.equal(result.cases[0]?.latencyMs, 180);
  assert.equal(result.headline.p50Ms, 180);
  assert.equal(result.headline.p95Ms, 180);
  assert.equal(result.headline.everyMaskUpBeforeAir, true);

  const earlyClear = scoreGauntlet({
    cases: [cases[0]!], detected: [event("a", "api_key", 1_100)], cleared: [{ id: "a", at: 2_999 }],
    maskLiveAt: new Map([["a", 1_180]]), enabledDetectors: ["api_key"], delayMs: 1_000,
  });
  assert.equal(earlyClear.cases[0]?.status, "missed");
});

test("reports disabled detector cases as pending and counts unmatched events as false alarms", () => {
  const result = scoreGauntlet({
    cases: [cases[2]!, cases[4]!], detected: [event("stray", "password", 8_100)], cleared: [],
    maskLiveAt: new Map(), enabledDetectors: ["api_key", "email", "password"], delayMs: 1_000,
  });
  assert.equal(result.cases.find(({ id }) => id === "future-phone")?.status, "pending");
  assert.equal(result.headline.eligible, 1);
  assert.equal(result.headline.falseAlarms, 1);
  assert.deepEqual(result.falseAlarmLeakIds, ["stray"]);
});

test("matches by kind, time window and canvas region, and scores flash separately", () => {
  const casesToScore = [cases[1]!, cases[3]!];
  const detected = [
    event("wrong-region", "email", 3_100, { x: 900, y: 900, w: 10, h: 10 }),
    event("email", "email", 3_100),
    event("flash", "email", 7_100),
  ];
  const result = scoreGauntlet({
    cases: casesToScore, detected, cleared: [{ id: "email", at: 5_000 }],
    maskLiveAt: new Map([["email", 3_200], ["flash", 7_800]]), enabledDetectors: ["email"], delayMs: 1_000,
  });
  assert.deepEqual(result.falseAlarmLeakIds, ["wrong-region"]);
  assert.equal(result.headline.blocked, 1);
  assert.equal(result.headline.eligible, 1);
  assert.equal(result.flash.blocked, 0);
  assert.equal(result.flash.eligible, 1);
  assert.equal(result.headline.everyMaskUpBeforeAir, true);
});

test("p50 and p95 use nearest-rank latency percentiles", () => {
  const examples = [0, 100, 200, 300].map((start, index) => ({
    id: `c${index}`, kind: "email" as const, region, paintedAt: start + 1_000, hiddenAt: start + 1_100,
  }));
  const detected = examples.map((example, index) => event(`e${index}`, "email", example.paintedAt + 10));
  const result = scoreGauntlet({
    cases: examples, detected, cleared: [],
    maskLiveAt: new Map(detected.map((item, index) => [item.id, examples[index]!.paintedAt + index * 100])),
    enabledDetectors: ["email"], delayMs: 1_000,
  });
  assert.equal(result.headline.p50Ms, 100);
  assert.equal(result.headline.p95Ms, 300);
});
