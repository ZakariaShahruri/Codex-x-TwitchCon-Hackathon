import assert from "node:assert/strict";
import test from "node:test";
import type { Box } from "../shared/events.js";
import type { LeakCandidate } from "./detectors/types.js";
import { MaskManager, planMaskBoxes, type MaskBackend } from "./mask-manager.js";

class FakeMasks implements MaskBackend {
  readonly boxes = new Map<string, Box>();
  readonly enabled = new Set<string>();
  readonly calls: string[] = [];
  async place(id: string, box: Box): Promise<void> { this.boxes.set(id, { ...box }); this.calls.push(`place:${id}`); }
  async enable(id: string, enabled: boolean): Promise<void> {
    if (enabled) this.enabled.add(id); else this.enabled.delete(id);
    this.calls.push(`${enabled ? "enable" : "disable"}:${id}`);
  }
}

const leak = (fingerprint: string, box: Box, kind: LeakCandidate["kind"] = "api_key"): LeakCandidate => ({
  kind, box, preview: "API key", fingerprint,
});

function manager(backend: FakeMasks, extra: Partial<ConstructorParameters<typeof MaskManager>[0]> = {}): MaskManager {
  return new MaskManager({
    backend, maskIds: ["m1", "m2"], width: 400, height: 300,
    delayMs: 1_000, safetyMarginMs: 100, paddingPx: 4,
    now: () => 0, wait: async () => {}, ...extra,
  });
}

test("a mask lives until the first frame without the text + delay + safety margin", async () => {
  const backend = new FakeMasks();
  const masks = manager(backend, { maskIds: ["m1"] });
  await masks.update([leak("secret-a", { x: 20, y: 30, w: 40, h: 20 })], 100);
  assert.equal(backend.enabled.has("m1"), true);
  await masks.update([leak("secret-a", { x: 24, y: 32, w: 40, h: 20 })], 500);
  assert.deepEqual(backend.boxes.get("m1"), { x: 16, y: 26, w: 52, h: 30 });
  // Still on screen in the last frame: it may stay there until the next capture, so it never expires on its own.
  await masks.expire(5_000);
  assert.equal(backend.enabled.has("m1"), true);
  // The frame at 5000 is the first proof it is gone; the delayed output shows it until 5000 + 1000 + 100.
  await masks.update([], 5_000);
  await masks.expire(6_099);
  assert.equal(backend.enabled.has("m1"), true);
  await masks.expire(6_100);
  assert.equal(backend.enabled.has("m1"), false);
});

test("a capture gap keeps the mask until a later frame proves the text is gone", async () => {
  const backend = new FakeMasks();
  const masks = manager(backend, { maskIds: ["m1"] });
  await masks.update([leak("secret-a", { x: 20, y: 30, w: 40, h: 20 })], 0);
  // OBS hiccup: no frames for 3 s. The old rule (lastSeen + 1100) would have dropped the mask at 1100.
  await masks.expire(3_000);
  assert.equal(backend.enabled.has("m1"), true);
  await masks.update([], 3_000);
  await masks.update([], 4_099);
  assert.equal(backend.enabled.has("m1"), true);
  await masks.update([], 4_100);
  assert.equal(backend.enabled.has("m1"), false);
});

test("a secret redetected after an OCR miss and long capture gap keeps its prior position covered", async () => {
  const backend = new FakeMasks();
  const masks = manager(backend, { maskIds: ["m1", "m2"] });
  const beforeGap = leak("same-secret", { x: 20, y: 30, w: 40, h: 20 });
  const afterGap = leak("same-secret", { x: 220, y: 130, w: 40, h: 20 });
  await masks.update([beforeGap], 0);
  await masks.update([], 100); // One OCR miss marks it absent.
  await masks.update([afterGap], 2_500); // No frame arrived during the gap; the text may have stayed at the old pixels.

  const covers = (box: Box) => [...backend.enabled].some((id) => {
    const mask = backend.boxes.get(id)!;
    return mask.x <= box.x && mask.y <= box.y && mask.x + mask.w >= box.x + box.w && mask.y + mask.h >= box.y + box.h;
  });
  assert.equal(covers(beforeGap.box), true, "old pixels remain in the delay buffer through the recovered capture");
  assert.equal(covers(afterGap.box), true, "the newly observed position is masked too");
  await masks.expire(3_599);
  assert.equal(covers(beforeGap.box), true);
  await masks.expire(3_600);
  assert.equal(covers(beforeGap.box), false, "the old trail expires one hold window after re-detection");
});

test("scrolling text keeps only its recent trail covered instead of one ever-growing box", async () => {
  const backend = new FakeMasks();
  const masks = manager(backend, { maskIds: ["m1", "m2", "m3"], width: 1920, height: 1080 });
  const frameMs = 150;
  const position = (frame: number): Box => ({ x: 200, y: 900 - frame * 20, w: 600, h: 30 });
  const covered = (box: Box) => [...backend.enabled].some((id) => {
    const mask = backend.boxes.get(id)!;
    return mask.x <= box.x && mask.y <= box.y && mask.x + mask.w >= box.x + box.w && mask.y + mask.h >= box.y + box.h;
  });
  for (let frame = 0; frame < 40; frame += 1) {
    const at = frame * frameMs;
    await masks.update([leak("scrolling-key", position(frame))], at);
    // Position p left the screen at the next frame, so the delayed output can show it until then + 1100 ms.
    for (let previous = 0; previous <= frame; previous += 1) {
      const goneAt = previous === frame ? Number.POSITIVE_INFINITY : (previous + 1) * frameMs;
      if (goneAt + 1_100 > at) assert.ok(covered(position(previous)), `frame ${frame}: position ${previous} uncovered`);
    }
  }
  const tallest = Math.max(...[...backend.enabled].map((id) => backend.boxes.get(id)!.h));
  assert.ok(tallest <= 220, `30px key scrolled for 6 s should not leave a ${tallest}px mask`);
});

test("pads and merges overlapping boxes", () => {
  assert.deepEqual(planMaskBoxes([
    { box: { x: 20, y: 30, w: 40, h: 20 } },
    { box: { x: 62, y: 35, w: 25, h: 10 } },
  ], { width: 200, height: 100, paddingPx: 4, poolSize: 4 }), [
    { x: 16, y: 26, w: 75, h: 28 },
  ]);
});

test("pool exhaustion merges boxes into a larger covering mask instead of dropping one", () => {
  const plan = planMaskBoxes([
    { box: { x: 10, y: 20, w: 20, h: 10 } },
    { box: { x: 200, y: 100, w: 30, h: 20 } },
  ], { width: 400, height: 300, paddingPx: 4, poolSize: 1 });
  assert.deepEqual(plan, [{ x: 6, y: 16, w: 228, h: 108 }]);
});

test("live pool exhaustion expands an existing mask before releasing no coverage", async () => {
  const backend = new FakeMasks();
  const masks = manager(backend);
  await masks.update([
    leak("left", { x: 20, y: 20, w: 20, h: 15 }),
    leak("right", { x: 210, y: 20, w: 20, h: 15 }),
  ], 0);
  const oldLeft = backend.boxes.get("m1")!;
  const oldRight = backend.boxes.get("m2")!;
  await masks.update([
    leak("left", { x: 20, y: 20, w: 20, h: 15 }),
    leak("right", { x: 210, y: 20, w: 20, h: 15 }),
    leak("middle", { x: 100, y: 20, w: 20, h: 15 }),
  ], 100);
  assert.equal(backend.enabled.size, 2);
  assert.ok(backend.boxes.get("m1")!.x <= oldLeft.x && backend.boxes.get("m1")!.x + backend.boxes.get("m1")!.w >= 120);
  assert.deepEqual(backend.boxes.get("m2"), oldRight);
});

test("panic covers the full canvas; unblur lifts it but keeps secrets detected under it masked", async () => {
  const backend = new FakeMasks();
  const masks = manager(backend);
  const candidate = leak("real-secret", { x: 30, y: 40, w: 20, h: 10 });
  await masks.update([candidate], 0);
  await masks.panicNow();
  assert.deepEqual(backend.boxes.get("m1"), { x: 0, y: 0, w: 400, h: 300 });
  assert.equal(masks.panic, true);
  await masks.expire(99_999);
  assert.equal(backend.enabled.has("m1"), true);
  assert.deepEqual(backend.boxes.get("m1"), { x: 0, y: 0, w: 400, h: 300 });
  await masks.update([candidate], 100_000);
  await masks.unblur();
  assert.equal(masks.panic, false);
  assert.equal(masks.isIgnored("real-secret"), false);
  assert.deepEqual([...backend.enabled].map((id) => backend.boxes.get(id)), [{ x: 26, y: 36, w: 28, h: 18 }]);
});

test("unblur dismisses only what is masked now, never earlier secrets or sensitive regions", async () => {
  const backend = new FakeMasks();
  const masks = manager(backend, { maskIds: ["m1", "m2", "m3"] });
  const earlier = leak("api-key-shown-earlier", { x: 10, y: 10, w: 40, h: 10 });
  const falsePositive = leak("false-positive", { x: 100, y: 100, w: 40, h: 10 });
  const region = leak("region", { x: 300, y: 200, w: 50, h: 50 }, "sensitive_region");
  await masks.update([earlier], 0);
  await masks.update([], 150);
  await masks.update([falsePositive, region], 2_000);
  await masks.unblur();
  assert.equal(masks.isIgnored("false-positive"), true);
  assert.equal(masks.isIgnored("region"), false);
  assert.deepEqual([...backend.enabled].map((id) => backend.boxes.get(id)), [{ x: 296, y: 196, w: 58, h: 58 }]);

  await masks.update([earlier, falsePositive, region], 2_150);
  assert.equal(masks.isIgnored("api-key-shown-earlier"), false);
  const shown = [...backend.enabled].map((id) => backend.boxes.get(id)!).sort((a, b) => a.y - b.y);
  assert.deepEqual(shown, [{ x: 6, y: 6, w: 48, h: 18 }, { x: 296, y: 196, w: 58, h: 58 }]);
});

test("unblur is serialized after an in-flight placement and cannot be undone by it", async () => {
  const state = new FakeMasks();
  let release!: () => void;
  let block = true;
  const backend: MaskBackend = {
    place: async (id, box) => {
      if (block) await new Promise<void>((resolve) => { release = resolve; });
      state.boxes.set(id, { ...box });
    },
    enable: (id, enabled) => state.enable(id, enabled),
  };
  const masks = manager(state, { backend, maskIds: ["m1"] });
  const candidate = leak("dismiss-this", { x: 20, y: 30, w: 40, h: 20 });
  const placement = masks.update([candidate], 0);
  await new Promise((resolve) => setImmediate(resolve));
  const dismissal = masks.unblur();
  release();
  await placement;
  await dismissal;
  assert.equal(state.enabled.size, 0);
  block = false;
  await masks.update([candidate], 10);
  assert.equal(state.enabled.size, 0);
});

test("enabled masks survive restart hold and graceful stop for the full delay horizon", async () => {
  const firstBackend = new FakeMasks();
  const first = manager(firstBackend, { maskIds: ["m1"], now: () => 0 });
  await first.update([leak("secret", { x: 40, y: 50, w: 30, h: 20 })], 0);

  let now = 500;
  const restartBackend = new FakeMasks();
  restartBackend.boxes.set("m1", firstBackend.boxes.get("m1")!);
  restartBackend.enabled.add("m1");
  const restarted = manager(restartBackend, {
    maskIds: ["m1"], now: () => now,
    existingMasks: [{ id: "m1", box: restartBackend.boxes.get("m1")! }],
  });
  await restarted.expire(now + 1_099);
  assert.equal(restartBackend.enabled.has("m1"), true);
  now += 1_100;
  await restarted.expire(now);
  assert.equal(restartBackend.enabled.has("m1"), false);

  const stoppingBackend = new FakeMasks();
  const waited: number[] = [];
  let maskStayedUpDuringWait = false;
  const stopping = manager(stoppingBackend, {
    maskIds: ["m1"], now: () => 2_000,
    wait: async (ms) => { waited.push(ms); maskStayedUpDuringWait = stoppingBackend.enabled.has("m1"); },
  });
  // Still on screen at shutdown: it may already be in the delay buffer, so hold a full delay from now.
  await stopping.update([leak("still-buffered", { x: 40, y: 50, w: 30, h: 20 })], 1_900);
  await stopping.stop();
  assert.deepEqual(waited, [1_100]);
  assert.equal(maskStayedUpDuringWait, true);
  assert.equal(stoppingBackend.enabled.has("m1"), false);
});
