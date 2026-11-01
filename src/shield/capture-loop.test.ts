import assert from "node:assert/strict";
import test from "node:test";
import type { LeakKind } from "../shared/events.js";
import { CaptureLoop } from "./capture-loop.js";

const noRegions: [] = [];
const detectorKinds: LeakKind[] = ["api_key", "email", "password", "sensitive_region"];

test("capture loop never overlaps ticks while capture or OCR is busy", async () => {
  let finishRecognition!: () => void;
  let finishCapture!: () => void;
  let calls = 0;
  let frameCount = 0;
  let captureCalls = 0;
  const loop = new CaptureLoop({
    capture: async () => {
      captureCalls += 1;
      if (captureCalls === 1) await new Promise<void>((resolve) => { finishCapture = resolve; });
      return Buffer.from(`frame-${++frameCount}`);
    },
    ocr: { recognize: async () => { calls += 1; await new Promise<void>((resolve) => { finishRecognition = resolve; }); return []; } },
    intervalMs: 100,
    enabledDetectors: detectorKinds,
    sensitiveRegions: noRegions,
    onFrame: () => {},
  });
  const active = loop.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await loop.tick(), false);
  assert.equal(captureCalls, 1);
  finishCapture();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(await loop.tick(), false);
  finishRecognition();
  assert.equal(await active, true);
  const second = loop.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  finishRecognition();
  assert.equal(await second, true);
  await loop.stop();
});

test("identical PNG bytes skip OCR and emit the previous boxes for lastSeen refresh", async () => {
  let recognitionCalls = 0;
  const frames: Array<{ leaks: Array<{ kind: string }>; unchanged: boolean }> = [];
  const region = { x: 20, y: 30, w: 40, h: 50 };
  const loop = new CaptureLoop({
    capture: async () => Buffer.from("same frame"),
    ocr: { recognize: async () => { recognitionCalls += 1; return []; } },
    intervalMs: 100,
    enabledDetectors: ["sensitive_region"],
    sensitiveRegions: [region],
    onFrame: (frame) => frames.push(frame),
  });
  await loop.tick();
  const firstAt = frames[0]!.unchanged;
  await loop.tick();
  assert.equal(recognitionCalls, 1);
  assert.equal(firstAt, false);
  assert.equal(frames[1]!.unchanged, true);
  assert.deepEqual(frames[0]!.leaks, [{ kind: "sensitive_region", box: region, preview: "sensitive region" }]);
  assert.deepEqual(frames[1]!.leaks, frames[0]!.leaks);
  await loop.stop();
});
