import assert from "node:assert/strict";
import test from "node:test";
import type { LeakKind } from "../shared/events.js";
import { CaptureLoop, type CaptureFrame } from "./capture-loop.js";

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

test("identical PNG bytes skip OCR and emit the previous boxes so they stay on screen", async () => {
  let recognitionCalls = 0;
  const frames: CaptureFrame[] = [];
  const region = { x: 20, y: 30, w: 40, h: 50 };
  const loop = new CaptureLoop({
    capture: async () => Buffer.from("same frame"),
    ocr: { recognize: async () => { recognitionCalls += 1; return []; } },
    intervalMs: 100,
    enabledDetectors: ["sensitive_region"],
    sensitiveRegions: [region],
    onFrame: (frame) => { frames.push(frame); },
  });
  await loop.tick();
  const firstAt = frames[0]!.unchanged;
  await loop.tick();
  assert.equal(recognitionCalls, 1);
  assert.equal(firstAt, false);
  assert.equal(frames[1]!.unchanged, true);
  assert.equal(frames[0]!.leaks[0]!.kind, "sensitive_region");
  assert.deepEqual(frames[0]!.leaks[0]!.box, region);
  assert.equal(frames[0]!.leaks[0]!.preview, "sensitive region");
  assert.equal(typeof frames[0]!.leaks[0]!.fingerprint, "string");
  assert.deepEqual(frames[1]!.leaks, frames[0]!.leaks);
  await loop.stop();
});

test("disarmed capture keeps the loop alive but skips OCR and detection", async () => {
  let recognitionCalls = 0;
  let emitted = 0;
  let armed = false;
  const loop = new CaptureLoop({
    capture: async () => Buffer.from("frame while off"),
    ocr: { recognize: async () => { recognitionCalls += 1; return []; } },
    intervalMs: 100,
    enabledDetectors: detectorKinds,
    sensitiveRegions: noRegions,
    isArmed: () => armed,
    onFrame: (frame) => { emitted += 1; assert.deepEqual(frame.leaks, []); },
  });
  await loop.tick();
  assert.equal(recognitionCalls, 0);
  assert.equal(emitted, 1);
  armed = true;
  await loop.tick();
  assert.equal(recognitionCalls, 1, "arming forces OCR even when the frame bytes have not changed");
  await loop.stop();
});
