import assert from "node:assert/strict";
import test from "node:test";
import type { Box } from "../shared/events.js";
import type { LeakCandidate } from "./detectors/types.js";
import { MaskManager, type MaskBackend } from "./mask-manager.js";

const DELAY_MS = 1_000;
const SAFETY_MARGIN_MS = 100;
const HOLD_MS = DELAY_MS + SAFETY_MARGIN_MS;
const WIDTH = 1_600;
const HEIGHT = 900;
const POOL_SIZE = 12;

class SeededRandom {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0 || 0x6d2b79f5; }
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x1_0000_0000;
  }
  int(max: number): number { return Math.floor(this.next() * max); }
  chance(probability: number): boolean { return this.next() < probability; }
}

class FakeClock { now = 0; set(at: number): void { this.now = at; } }

class SimulatedMasks implements MaskBackend {
  readonly boxes = new Map<string, Box>();
  readonly enabled = new Set<string>();
  async place(id: string, box: Box): Promise<void> { this.boxes.set(id, { ...box }); }
  async enable(id: string, enabled: boolean): Promise<void> {
    if (enabled) this.enabled.add(id); else this.enabled.delete(id);
  }
}

interface Secret {
  id: string;
  box: Box;
  visible: boolean;
  missedLastFrame: boolean;
}

interface Obligation { id: string; box: Box; until: number }

function candidate(secret: Secret): LeakCandidate {
  return { kind: "api_key", box: { ...secret.box }, preview: "API key", fingerprint: secret.id };
}

function contains(outer: Box, inner: Box): boolean {
  return outer.x <= inner.x && outer.y <= inner.y &&
    outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h;
}

function seededScenario(seed: number): Promise<void> {
  return runScenario(seed);
}

async function runScenario(seed: number): Promise<void> {
  const random = new SeededRandom(seed);
  const clock = new FakeClock();
  const backend = new SimulatedMasks();
  const maskIds = Array.from({ length: POOL_SIZE }, (_, index) => `mask-${index + 1}`);
  const manager = new MaskManager({
    backend,
    maskIds,
    width: WIDTH,
    height: HEIGHT,
    delayMs: DELAY_MS,
    safetyMarginMs: SAFETY_MARGIN_MS,
    paddingPx: 4,
    now: () => clock.now,
    wait: async (ms) => { clock.now += ms; },
  });
  const secrets: Secret[] = Array.from({ length: 18 }, (_, index) => ({
    id: `secret-${seed}-${index}`,
    box: {
      x: 24 + (index % 6) * 250,
      y: 24 + Math.floor(index / 6) * 230,
      w: 38,
      h: 18,
    },
    visible: index < 15, // Force >12 concurrent secrets to exercise pool exhaustion on every seed.
    missedLastFrame: false,
  }));
  const obligations: Obligation[] = [];
  const dismissed = new Set<string>();
  const previouslyDetected = new Set<string>();
  const lastCapturedBoxes = new Map<string, Box>();
  const previouslyVisible = new Set<string>();
  const trace: string[] = [];
  let armed = true;
  let now = 0;
  let panicCommandSeen = false;
  let panicLiftSeen = false;
  let offCommandSeen = false;
  let onCommandSeen = false;

  const snapshot = () => [...backend.enabled].flatMap((id) => {
    const box = backend.boxes.get(id);
    return box ? [box] : [];
  });
  const verifyCoverage = (at: number): void => {
    const masks = snapshot();
    for (const obligation of obligations) {
      if (obligation.until < at || dismissed.has(obligation.id)) continue;
      if (!masks.some((mask) => contains(mask, obligation.box))) {
        throw new Error(`seed=${seed} t=${at} secret=${obligation.id} box=${JSON.stringify(obligation.box)} uncovered; active=${JSON.stringify(manager.activeBoxes.map((item) => ({ id: item.fingerprint, box: item.box, until: item.expiresAt })))}; masks=${JSON.stringify(masks)}; trace=${trace.slice(-30).join(" | ")}`);
      }
    }
  };
  const doUnblur = async (at: number): Promise<void> => {
    const wasPanic = manager.panic;
    const activeIds = manager.activeBoxes.map((item) => item.fingerprint);
    await manager.unblur();
    trace.push(`unblur@${at}${wasPanic ? " (panic lift)" : " (dismiss)"}`);
    if (wasPanic) panicLiftSeen = true;
    else for (const id of activeIds) dismissed.add(id);
    verifyCoverage(at);
  };
  const tick = async (at: number, frame: number): Promise<void> => {
    now = at;
    clock.set(at);
    trace.push(`frame${frame}@${at}`);

    // Ensure both shield states and panic/unblur semantics are exercised, in addition to random commands.
    if (frame === 5 || (frame > 0 && random.chance(0.025))) {
      armed = false;
      offCommandSeen = true;
      trace.push(`off@${at}`);
    } else if (frame === 8 || (frame > 0 && random.chance(0.04))) {
      armed = true;
      onCommandSeen = true;
      trace.push(`on@${at}`);
    }
    if (frame === 10 || (frame > 0 && random.chance(0.035))) {
      await manager.panicNow();
      panicCommandSeen = true;
      trace.push(`panic@${at}`);
      verifyCoverage(at);
    }
    if (frame === 12 || (frame > 0 && random.chance(0.055))) await doUnblur(at);
    else if (frame > 0 && random.chance(0.025)) await doUnblur(at);

    // Add a delayed-output coverage obligation for every secret that remains live while armed,
    // even when simulated OCR misses it on this frame.
    if (armed) {
      for (const secret of secrets) {
        if (secret.visible && !dismissed.has(secret.id))
          obligations.push({ id: secret.id, box: { ...secret.box }, until: at + DELAY_MS });
      }
    }

    const detected: LeakCandidate[] = [];
    for (const secret of secrets) {
      if (!secret.visible || !armed || dismissed.has(secret.id)) {
        secret.missedLastFrame = false;
        continue;
      }
      const forcedMiss = frame === 3 && secret.id === secrets[0]!.id;
      const previousBox = lastCapturedBoxes.get(secret.id);
      const stayedPut = previousBox !== undefined && contains(previousBox, secret.box) && contains(secret.box, previousBox);
      const randomMiss = frame > 0 && previouslyVisible.has(secret.id) && previouslyDetected.has(secret.id) && stayedPut && !secret.missedLastFrame && random.chance(0.035);
      const missed = forcedMiss || randomMiss;
      secret.missedLastFrame = missed;
      if (!missed) {
        detected.push(candidate(secret));
        previouslyDetected.add(secret.id);
      }
      else trace.push(`OCR-miss:${secret.id}@${at}`);
    }

    try {
      await manager.update(detected, at);
    } catch (error) {
      throw new Error(`seed=${seed} frame=${frame}: MaskManager threw ${error instanceof Error ? error.message : String(error)}; trace=${trace.slice(-10).join(" | ")}`, { cause: error });
    }
    if (seed === 28 && frame === 4) trace.push(`active=${JSON.stringify(manager.activeBoxes.map((item) => ({ fingerprint: item.fingerprint, box: item.box, expiresAt: item.expiresAt })))}`);
    verifyCoverage(at);
  };

  const frameCount = 48 + random.int(25);
  for (let frame = 0; frame < frameCount; frame += 1) {
    // Scene changes occur at capture timestamps; during a capture gap, the last sampled scene persists.
    if (frame > 0) {
      for (const secret of secrets) {
        if (secret.visible && random.chance(0.035)) {
          secret.visible = false;
          trace.push(`gone:${secret.id}@${now}`);
        } else if (!secret.visible && random.chance(0.065)) {
          secret.visible = true;
          trace.push(`appeared:${secret.id}@${now}`);
        } else if (secret.visible && !(frame === 3 && secret.id === secrets[0]!.id)) {
          if (random.chance(0.18)) {
            secret.box = {
              ...secret.box,
              x: 12 + random.int(WIDTH - 64),
              y: 12 + random.int(HEIGHT - 44),
            };
            trace.push(`jump:${secret.id}@${now}`);
          } else {
            secret.box = {
              ...secret.box,
              x: Math.max(4, Math.min(WIDTH - 46, secret.box.x + random.int(25) - 12)),
              y: Math.max(4, Math.min(HEIGHT - 26, secret.box.y + random.int(17) - 8)),
            };
          }
        }
      }
    }
    await tick(now, frame);
    previouslyVisible.clear();
    for (const secret of secrets) {
      lastCapturedBoxes.set(secret.id, { ...secret.box });
      if (secret.visible) previouslyVisible.add(secret.id);
    }

    const interval = random.chance(0.09) ? 401 + random.int(2_600) : 100 + random.int(301);
    const nextAt = now + interval;
    // During a capture gap the mask sources remain enabled; check the delayed obligations throughout it.
    for (let sample = now + 50; sample < nextAt; sample += 50) {
      if (armed) {
        for (const secret of secrets) {
          if (secret.visible && !dismissed.has(secret.id))
            obligations.push({ id: secret.id, box: { ...secret.box }, until: sample + DELAY_MS });
        }
      }
      verifyCoverage(sample);
    }
    now = nextAt;
  }

  assert.equal(panicCommandSeen, true, `seed ${seed}: did not exercise panic`);
  assert.equal(panicLiftSeen, true, `seed ${seed}: did not exercise unblur during panic`);
  assert.equal(offCommandSeen, true, `seed ${seed}: did not exercise off`);
  assert.equal(onCommandSeen, true, `seed ${seed}: did not exercise on`);

  // Clear any panic, then prove expired detections do not leave enabled sources stuck.
  clock.set(now);
  if (manager.panic) await manager.unblur();
  await manager.update([], now);
  const goneAt = now;
  await manager.expire(goneAt + HOLD_MS + 400);
  assert.equal(backend.enabled.size, 0, `seed ${seed}: mask remained enabled past delay + safety + one frame`);
}

async function verifyScrollingBound(): Promise<void> {
  const backend = new SimulatedMasks();
  const manager = new MaskManager({
    backend,
    maskIds: ["scroll-1", "scroll-2", "scroll-3"],
    width: 5_000,
    height: 400,
    delayMs: DELAY_MS,
    safetyMarginMs: SAFETY_MARGIN_MS,
    paddingPx: 4,
    now: () => 0,
    wait: async () => {},
  });
  for (let frame = 0; frame < 120; frame += 1) {
    const box = { x: 100 + frame * 12, y: 140, w: 60, h: 20 };
    await manager.update([{ kind: "api_key", box, preview: "API key", fingerprint: "one-scrolling-secret" }], frame * 150);
    const masks = [...backend.enabled].map((id) => backend.boxes.get(id)!);
    const width = Math.max(...masks.map((mask) => mask.x + mask.w)) - Math.min(...masks.map((mask) => mask.x));
    assert.ok(width <= 500, `scrolling mask grew to ${width}px at frame ${frame}`);
  }
}

const fastSeeds = Number(process.env.MASK_SIM_SEEDS ?? 24);

test(`MaskManager seeded lifetime simulation (${fastSeeds} seeds)`, async () => {
  for (let seed = 1; seed <= fastSeeds; seed += 1) await seededScenario(seed);
  await verifyScrollingBound();
});
