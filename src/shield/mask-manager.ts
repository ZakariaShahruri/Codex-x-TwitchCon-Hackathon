import type { Box } from "../shared/events.js";
import type { LeakCandidate } from "./detectors/types.js";

export interface MaskBackend {
  place(maskId: string, box: Box): Promise<void>;
  enable(maskId: string, enabled: boolean): Promise<void>;
}

export interface ExistingMask { id: string; box: Box }

interface ActiveBox {
  fingerprint: string;
  box: Box;
  expiresAt: number;
  lastSeen: number;
  padded: boolean;
}

interface Slot {
  id: string;
  box?: Box;
  enabled: boolean;
  keepUntil: number;
}

interface PlannedBox { box: Box; keepUntil: number }

export interface MaskManagerOptions {
  backend: MaskBackend;
  maskIds: readonly string[];
  width: number;
  height: number;
  delayMs: number;
  safetyMarginMs: number;
  paddingPx?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  existingMasks?: readonly ExistingMask[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function area(box: Box): number { return box.w * box.h; }

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function intersects(a: Box, b: Box): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

function contains(outer: Box, inner: Box): boolean {
  return outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h;
}

function boxesOverlap(a: Box, b: Box): boolean { return intersects(a, b); }

function valid(box: Box): boolean {
  return [box.x, box.y, box.w, box.h].every(Number.isFinite) && box.w > 0 && box.h > 0;
}

/** Pads and clamps detections, merges intersections, then conservatively combines nearest boxes to fit the pool. */
export function planMaskBoxes(
  entries: readonly { box: Box; keepUntil: number; padded?: boolean }[],
  options: { width: number; height: number; paddingPx: number; poolSize: number },
): PlannedBox[] {
  if (!Number.isInteger(options.poolSize) || options.poolSize < 1) throw new Error("Mask pool must contain at least one mask");
  const clamp = (box: Box): Box => {
    const x = Math.max(0, Math.min(options.width, box.x));
    const y = Math.max(0, Math.min(options.height, box.y));
    const right = Math.max(x, Math.min(options.width, box.x + box.w));
    const bottom = Math.max(y, Math.min(options.height, box.y + box.h));
    return { x, y, w: right - x, h: bottom - y };
  };
  let boxes: PlannedBox[] = entries.filter((entry) => valid(entry.box)).map((entry) => {
    const source = entry.padded ? entry.box : {
      x: entry.box.x - options.paddingPx,
      y: entry.box.y - options.paddingPx,
      w: entry.box.w + options.paddingPx * 2,
      h: entry.box.h + options.paddingPx * 2,
    };
    return { box: clamp(source), keepUntil: entry.keepUntil };
  }).filter((entry) => valid(entry.box));

  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        if (!intersects(boxes[i]!.box, boxes[j]!.box)) continue;
        boxes[i] = { box: union(boxes[i]!.box, boxes[j]!.box), keepUntil: Math.max(boxes[i]!.keepUntil, boxes[j]!.keepUntil) };
        boxes.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }

  while (boxes.length > options.poolSize) {
    let bestI = 0;
    let bestJ = 1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const combined = union(boxes[i]!.box, boxes[j]!.box);
        const overlap = area(boxes[i]!.box) + area(boxes[j]!.box) - area(combined);
        const cost = area(combined) - overlap;
        if (cost < bestCost) { bestCost = cost; bestI = i; bestJ = j; }
      }
    }
    boxes[bestI] = {
      box: union(boxes[bestI]!.box, boxes[bestJ]!.box),
      keepUntil: Math.max(boxes[bestI]!.keepUntil, boxes[bestJ]!.keepUntil),
    };
    boxes.splice(bestJ, 1);
  }
  return boxes.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

/** Owns active detections, their delay-buffer lifetime and the existing OBS mask pool. */
export class MaskManager {
  private readonly slots: Slot[];
  private readonly active: ActiveBox[] = [];
  private readonly seen = new Set<string>();
  private readonly ignored = new Set<string>();
  private readonly holdMs: number;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private panicActive = false;
  private stopped = false;
  private operations: Promise<void> = Promise.resolve();

  constructor(private readonly options: MaskManagerOptions) {
    if (!Number.isFinite(options.width) || options.width <= 0 || !Number.isFinite(options.height) || options.height <= 0)
      throw new Error("Mask canvas width and height must be positive");
    if (!Number.isFinite(options.delayMs) || options.delayMs < 0 || !Number.isFinite(options.safetyMarginMs) || options.safetyMarginMs < 0)
      throw new Error("Mask delayMs and safetyMarginMs must be non-negative");
    if (!Number.isFinite(options.paddingPx ?? 4) || (options.paddingPx ?? 4) < 0) throw new Error("Mask paddingPx must be non-negative");
    if (options.maskIds.length < 1 || new Set(options.maskIds).size !== options.maskIds.length) throw new Error("Mask pool must have unique mask IDs");
    this.holdMs = options.delayMs + options.safetyMarginMs;
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? sleep;
    this.slots = options.maskIds.map((id) => ({ id, enabled: false, keepUntil: 0 }));
    for (const [index, existing] of (options.existingMasks ?? []).entries()) {
      const slot = this.slots.find((item) => item.id === existing.id);
      if (!slot || !valid(existing.box)) continue;
      slot.box = { ...existing.box };
      slot.enabled = true;
      slot.keepUntil = this.now() + this.holdMs;
      this.active.push({ fingerprint: `restart-mask-${index}`, box: { ...existing.box }, lastSeen: this.now(), expiresAt: slot.keepUntil, padded: true });
      if (existing.box.x <= 0 && existing.box.y <= 0 && existing.box.x + existing.box.w >= options.width && existing.box.y + existing.box.h >= options.height)
        this.panicActive = true;
    }
  }

  get panic(): boolean { return this.panicActive; }
  get activeBoxes(): readonly Readonly<ActiveBox>[] { return this.active; }
  isIgnored(fingerprint: string): boolean { return this.ignored.has(fingerprint); }

  update(candidates: readonly LeakCandidate[], at = this.now()): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) throw new Error("Mask manager has stopped");
      this.active.splice(0, this.active.length, ...this.active.filter((item) => item.expiresAt > at));
      const used = new Set<ActiveBox>();
      for (const candidate of candidates) {
        if (!valid(candidate.box) || this.ignored.has(candidate.fingerprint)) continue;
        this.seen.add(candidate.fingerprint);
        const duplicate = this.active.find((item) => used.has(item) && item.fingerprint === candidate.fingerprint && boxesOverlap(item.box, candidate.box));
        if (duplicate) {
          duplicate.box = union(duplicate.box, candidate.box);
          duplicate.lastSeen = at;
          duplicate.expiresAt = at + this.holdMs;
          continue;
        }
        let match: ActiveBox | undefined;
        let bestArea = Number.POSITIVE_INFINITY;
        for (const item of this.active) {
          if (used.has(item) || item.fingerprint !== candidate.fingerprint || !boxesOverlap(item.box, candidate.box)) continue;
          const candidateArea = area(union(item.box, candidate.box));
          if (candidateArea < bestArea) { match = item; bestArea = candidateArea; }
        }
        if (match) {
          match.box = union(match.box, candidate.box);
          match.lastSeen = at;
          match.expiresAt = at + this.holdMs;
          used.add(match);
        } else {
          const item: ActiveBox = { fingerprint: candidate.fingerprint, box: { ...candidate.box }, lastSeen: at, expiresAt: at + this.holdMs, padded: false };
          this.active.push(item);
          used.add(item);
        }
      }
      await this.render(at);
    });
  }

  expire(at = this.now()): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return;
      this.active.splice(0, this.active.length, ...this.active.filter((item) => item.expiresAt > at));
      await this.render(at);
    });
  }

  panicNow(): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) throw new Error("Mask manager has stopped");
      this.panicActive = true;
      await this.render(this.now());
    });
  }

  unblur(): Promise<void> {
    return this.enqueue(async () => {
      for (const fingerprint of this.seen) this.ignored.add(fingerprint);
      for (const item of this.active) this.ignored.add(item.fingerprint);
      this.active.length = 0;
      this.panicActive = false;
      await this.disableAll();
    });
  }

  /** Reconcile source IDs and enabled geometry after an OBS websocket reconnect. */
  resync(existingMasks: readonly ExistingMask[]): Promise<void> {
    return this.enqueue(async () => {
      const byId = new Map(existingMasks.map((item) => [item.id, item]));
      const at = this.now();
      for (const slot of this.slots) {
        const existing = byId.get(slot.id);
        slot.enabled = existing !== undefined;
        if (!existing) continue;
        if (!valid(existing.box)) throw new Error(`Cannot recover mask ${slot.id}: invalid transform`);
        slot.box = { ...existing.box };
        slot.keepUntil = Math.max(slot.keepUntil, at + this.holdMs);
        this.active.push({ fingerprint: `reconnect-${slot.id}-${at}`, box: { ...existing.box }, lastSeen: at, expiresAt: slot.keepUntil, padded: true });
        if (existing.box.x <= 0 && existing.box.y <= 0 && existing.box.x + existing.box.w >= this.options.width && existing.box.y + existing.box.h >= this.options.height)
          this.panicActive = true;
      }
      await this.render(at);
    });
  }

  /** Hold current masks through the entire delay horizon after shutdown; panic remains until explicit unblur. */
  stop(): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return;
      this.stopped = true;
      if (this.panicActive) return;
      if (!this.slots.some((slot) => slot.enabled)) {
        this.active.length = 0;
        return;
      }
      const now = this.now();
      const activeExpiry = Math.max(now, ...this.active.map((item) => item.expiresAt));
      const waitMs = Math.max(this.holdMs, activeExpiry - now);
      if (waitMs > 0) await this.wait(waitMs);
      await this.disableAll();
      this.active.length = 0;
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operations.then(operation);
    this.operations = result.then(() => {}, () => {});
    return result;
  }

  private async render(at: number): Promise<void> {
    const all = this.active.map((item) => ({ box: item.box, keepUntil: item.expiresAt, padded: item.padded }));
    for (const slot of this.slots) {
      if (slot.enabled && slot.box && slot.keepUntil > at) all.push({ box: slot.box, keepUntil: slot.keepUntil, padded: true });
    }
    const targets: PlannedBox[] = this.panicActive
      ? [{ box: { x: 0, y: 0, w: this.options.width, h: this.options.height }, keepUntil: Number.POSITIVE_INFINITY }]
      : planMaskBoxes(all, {
        width: this.options.width,
        height: this.options.height,
        paddingPx: this.options.paddingPx ?? 4,
        poolSize: this.slots.length,
      });

    // Reserve still-live sources for targets that contain them before assigning any free slot.
    const orderedTargets = [...targets].sort((a, b) => {
      const containedSlots = (target: PlannedBox) => this.slots.filter((slot) => slot.enabled && slot.box && contains(target.box, slot.box)).length;
      return containedSlots(b) - containedSlots(a);
    });
    const claimed = new Set<Slot>();
    const assignments: Array<{ slot: Slot; target: PlannedBox }> = [];
    for (const target of orderedTargets) {
      let slot = this.slots.find((candidate) => !claimed.has(candidate) && candidate.enabled && candidate.box && contains(target.box, candidate.box));
      slot ??= this.slots.find((candidate) => !claimed.has(candidate) && !candidate.enabled);
      slot ??= this.slots.find((candidate) => !claimed.has(candidate) && candidate.enabled && candidate.keepUntil <= at);
      if (!slot) throw new Error("Mask pool allocation failed; refusing to drop a detected mask");
      claimed.add(slot);
      assignments.push({ slot, target });
    }

    // Place and enable every target before disabling any old slot, so consolidation never uncovers a box.
    for (const { slot, target } of assignments) {
      if (!slot.box || JSON.stringify(slot.box) !== JSON.stringify(target.box)) await this.options.backend.place(slot.id, target.box);
      if (!slot.enabled) await this.options.backend.enable(slot.id, true);
      slot.box = { ...target.box };
      slot.enabled = true;
      slot.keepUntil = target.keepUntil;
    }
    for (const slot of this.slots) {
      if (slot.enabled && !claimed.has(slot)) {
        const covered = assignments.some(({ target }) => contains(target.box, slot.box!));
        if (covered || slot.keepUntil <= at) {
          await this.options.backend.enable(slot.id, false);
          slot.enabled = false;
          slot.keepUntil = 0;
        } else {
          // Keep an old source visible if no replacement geometry proves it covered.
          throw new Error(`Cannot safely reclaim enabled mask ${slot.id}; its box is not covered by the current mask plan`);
        }
      }
    }
  }

  private async disableAll(): Promise<void> {
    for (const slot of this.slots) {
      if (slot.enabled) await this.options.backend.enable(slot.id, false);
      slot.enabled = false;
      slot.keepUntil = 0;
    }
  }
}
