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

test("masks refresh through lastSeen + delay + safety margin, then expire", async () => {
  const backend = new FakeMasks();
  const masks = manager(backend, { maskIds: ["m1"] });
  await masks.update([leak("secret-a", { x: 20, y: 30, w: 40, h: 20 })], 100);
  assert.equal(backend.enabled.has("m1"), true);
  await masks.update([leak("secret-a", { x: 24, y: 32, w: 40, h: 20 })], 500);
  assert.deepEqual(backend.boxes.get("m1"), { x: 16, y: 26, w: 52, h: 30 });
  await masks.expire(1_599);
  assert.equal(backend.enabled.has("m1"), true);
  await masks.expire(1_600);
  assert.equal(backend.enabled.has("m1"), false);
});

test("pads and merges overlapping boxes", () => {
  assert.deepEqual(planMaskBoxes([
    { box: { x: 20, y: 30, w: 40, h: 20 }, keepUntil: 10 },
    { box: { x: 62, y: 35, w: 25, h: 10 }, keepUntil: 20 },
  ], { width: 200, height: 100, paddingPx: 4, poolSize: 4 }), [
    { box: { x: 16, y: 26, w: 75, h: 28 }, keepUntil: 20 },
  ]);
});

test("pool exhaustion merges boxes into a larger covering mask instead of dropping one", () => {
  const plan = planMaskBoxes([
    { box: { x: 10, y: 20, w: 20, h: 10 }, keepUntil: 100 },
    { box: { x: 200, y: 100, w: 30, h: 20 }, keepUntil: 200 },
  ], { width: 400, height: 300, paddingPx: 4, poolSize: 1 });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0]!.box, { x: 6, y: 16, w: 228, h: 108 });
  assert.equal(plan[0]!.keepUntil, 200);
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

test("panic covers the full canvas; unblur clears masks and ignores seen text", async () => {
  const backend = new FakeMasks();
  const masks = manager(backend);
  const candidate = leak("private-fingerprint", { x: 30, y: 40, w: 20, h: 10 });
  await masks.update([candidate], 0);
  await masks.panicNow();
  assert.deepEqual(backend.boxes.get("m1"), { x: 0, y: 0, w: 400, h: 300 });
  assert.equal(masks.panic, true);
  await masks.expire(99_999);
  assert.equal(backend.enabled.has("m1"), true);
  assert.deepEqual(backend.boxes.get("m1"), { x: 0, y: 0, w: 400, h: 300 });
  await masks.unblur();
  assert.equal(masks.panic, false);
  assert.equal(backend.enabled.size, 0);
  await masks.update([candidate], 10);
  assert.equal(backend.enabled.size, 0);
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
  await stopping.update([leak("still-buffered", { x: 40, y: 50, w: 30, h: 20 })], 1_900);
  await stopping.stop();
  assert.deepEqual(waited, [1_100]);
  assert.equal(maskStayedUpDuringWait, true);
  assert.equal(stoppingBackend.enabled.has("m1"), false);
});
