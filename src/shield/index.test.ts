import assert from "node:assert/strict";
import test from "node:test";
import { EventBus } from "../shared/bus.js";
import { loadConfig } from "../shared/config.js";
import { redacted, type Box } from "../shared/events.js";
import type { CaptureFrame, ContentCaptureHandle } from "./capture-loop.js";
import { MaskManager, type MaskBackend } from "./mask-manager.js";
import { startShield } from "./index.js";
import type { LeakCandidate } from "./detectors/types.js";

class FakeMaskBackend implements MaskBackend {
  readonly boxes = new Map<string, Box>();
  readonly enabled = new Set<string>();
  async place(id: string, box: Box): Promise<void> { this.boxes.set(id, { ...box }); }
  async enable(id: string, enabled: boolean): Promise<void> {
    if (enabled) this.enabled.add(id); else this.enabled.delete(id);
  }
}

const secret = (fingerprint: string, kind: LeakCandidate["kind"] = "email"): LeakCandidate => ({
  fingerprint, kind, box: { x: 30, y: 40, w: 90, h: 20 }, preview: redacted(kind),
});

async function createHarness() {
  const config = await loadConfig({ envPath: "/missing/twitchy-test.env" });
  config.env.OBS_WS_URL = "ws://fake-obs";
  const bus = new EventBus();
  const events: Array<{ event: string; payload: any }> = [];
  for (const name of ["leak.detected", "leak.cleared", "shield.state"] as const)
    bus.on(name, (payload) => { events.push({ event: name, payload }); });
  const backend = new FakeMaskBackend();
  let now = 0;
  let masks: MaskManager | undefined;
  let onFrame: ((frame: CaptureFrame) => void | Promise<void>) | undefined;
  let stopWaits: number[] = [];
  const connectCapture: Parameters<typeof startShield>[2] = async (_config, options): Promise<ContentCaptureHandle> => {
    onFrame = options.onFrame;
    const manager = new MaskManager({
      backend,
      maskIds: Array.from({ length: config.maskPoolSize }, (_, index) => `mask-${index + 1}`),
      width: 1920, height: 1080, delayMs: config.delayMs, safetyMarginMs: config.safetyMarginMs,
      now: () => now,
      wait: async (ms) => { stopWaits.push(ms); now += ms; },
    });
    masks = manager;
    return { masks: manager, start() {}, stop: () => manager.stop() };
  };
  const stop = await startShield(bus, config, connectCapture);
  assert.ok(onFrame && masks);
  const emitFrame = async (leaks: LeakCandidate[], at: number): Promise<void> => {
    now = at;
    await masks!.update(leaks, at);
    await onFrame!({
      leaks, unchanged: false, at, startedAt: at, capturedAt: at,
      captureMs: 0, ocrMs: 0, detectMs: 0, totalMs: 0,
    });
  };
  const command = async (action: "panic" | "unblur", at: number): Promise<void> => {
    bus.emit("shield.command", { action, by: "test", at });
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { bus, config, events, backend, get masks() { return masks!; }, emitFrame, command, stop, stopWaits };
}

test("unblur during panic lifts panic without clearing events or active leak masks", async () => {
  const h = await createHarness();
  await h.command("panic", 0);
  await h.emitFrame([secret("during-panic")], 10);
  const detected = h.events.filter((item) => item.event === "leak.detected");
  assert.equal(detected.length, 1);
  const id = detected[0]!.payload.id;
  assert.ok(h.backend.enabled.size > 0);

  await h.command("unblur", 20);
  assert.equal(h.events.filter((item) => item.event === "leak.cleared").length, 0);
  assert.ok(h.backend.enabled.size > 0, "secret is still masked after lifting the panic");
  await h.emitFrame([secret("during-panic")], 30);
  assert.equal(h.events.filter((item) => item.event === "leak.detected").length, 1);
  assert.equal(detected[0]!.payload.id, id);
  assert.equal(detected[0]!.payload.totalBlocked, 1, "lifting panic does not count an already active leak again");
  await h.stop();
});

test("ordinary unblur clears only current leaks; a previously cleared secret can be masked and counted again", async () => {
  const h = await createHarness();
  const first = secret("older-secret");
  await h.emitFrame([first], 0);
  await h.emitFrame([], 10);
  // Use the configured lifetime boundary (first absent frame + delay + margin).
  const hold = h.config.delayMs + h.config.safetyMarginMs;
  await h.emitFrame([], 10 + hold);
  assert.equal(h.events.filter((item) => item.event === "leak.cleared").length, 1);

  const current = secret("current-secret");
  await h.emitFrame([current], 20 + hold);
  await h.command("unblur", 21 + hold);
  const clearedIds = h.events.filter((item) => item.event === "leak.cleared").map((item) => item.payload.id);
  assert.equal(clearedIds.length, 2, "unblur clears the currently masked leak");
  await h.emitFrame([first], 22 + hold);
  const detections = h.events.filter((item) => item.event === "leak.detected");
  assert.equal(detections.length, 3);
  assert.equal(detections[2]!.payload.totalBlocked, 3);
  assert.ok(h.backend.enabled.size > 0, "the previously cleared fingerprint is masked again");
  await h.stop();
});

test("sensitive regions survive unblur without leak.cleared or repeat leak.detected", async () => {
  const h = await createHarness();
  const region = secret("region-0", "sensitive_region");
  await h.emitFrame([region], 0);
  await h.emitFrame([region], 50);
  assert.equal(h.events.filter((item) => item.event === "leak.detected").length, 1);
  await h.command("unblur", 60);
  assert.equal(h.events.filter((item) => item.event === "leak.cleared").length, 0);
  assert.ok(h.backend.enabled.size > 0);
  await h.emitFrame([region], 70);
  assert.equal(h.events.filter((item) => item.event === "leak.detected").length, 1);
  await h.stop();
});

test("leak.cleared follows the first absent frame plus delay and safety margin", async () => {
  const h = await createHarness();
  const candidate = secret("timed-secret");
  await h.emitFrame([candidate], 0);
  await h.emitFrame([], 200);
  await h.emitFrame([], 200 + 1_099);
  assert.equal(h.events.filter((item) => item.event === "leak.cleared").length, 0);
  await h.emitFrame([], 200 + 1_100);
  assert.equal(h.events.filter((item) => item.event === "leak.cleared").length, 1);
  await h.stop();
});

test("stop holds on-screen masks for one finite delay window", async () => {
  const h = await createHarness();
  await h.emitFrame([secret("at-stop")], 100);
  const result = await Promise.race([
    h.stop().then(() => "stopped"),
    new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 100)),
  ]);
  assert.equal(result, "stopped");
  assert.deepEqual(h.stopWaits, [1_100]);
  assert.equal(h.backend.enabled.size, 0);
});

test("resync adopts enabled OBS masks and holds them through the reconnect delay", async () => {
  const h = await createHarness();
  const recovered = { x: 120, y: 220, w: 80, h: 30 };
  h.backend.boxes.set("mask-1", recovered);
  h.backend.enabled.add("mask-1");
  await h.masks.resync([{ id: "mask-1", box: recovered }]);
  assert.equal(h.backend.enabled.has("mask-1"), true);
  await h.masks.expire(1_099);
  assert.equal(h.backend.enabled.has("mask-1"), true);
  await h.masks.expire(1_100);
  assert.equal(h.backend.enabled.has("mask-1"), false);
  await h.stop();
});
