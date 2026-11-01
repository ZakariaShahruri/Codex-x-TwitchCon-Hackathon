import type { Box } from "../shared/events.js";
import type { LeakCandidate } from "./detectors/types.js";

export interface MaskBackend {
  place(maskId: string, box: Box): Promise<void>;
  enable(maskId: string, enabled: boolean): Promise<void>;
}

export interface ExistingMask { id: string; box: Box }

/**
 * One place where detected text is or was on screen. While the latest frame still shows it, `expiresAt` is
 * Infinity: the text may stay on screen until the next capture, so the countdown can only start at the first
 * frame that no longer sees it.
 */
interface ActiveBox {
  fingerprint: string;
  box: Box;
  expiresAt: number;
  padded: boolean;
  /** False for configured sensitive regions, which stay masked through unblur. */
  dismissable: boolean;
}

interface Slot {
  id: string;
  box?: Box;
  enabled: boolean;
}

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

function valid(box: Box): boolean {
  return [box.x, box.y, box.w, box.h].every(Number.isFinite) && box.w > 0 && box.h > 0;
}

/** Pads and clamps detections, merges intersections, then conservatively combines nearest boxes to fit the pool. */
export function planMaskBoxes(
  entries: readonly { box: Box; padded?: boolean }[],
  options: { width: number; height: number; paddingPx: number; poolSize: number },
): Box[] {
  if (!Number.isInteger(options.poolSize) || options.poolSize < 1) throw new Error("Mask pool must contain at least one mask");
  const clamp = (box: Box): Box => {
    const x = Math.max(0, Math.min(options.width, box.x));
    const y = Math.max(0, Math.min(options.height, box.y));
    const right = Math.max(x, Math.min(options.width, box.x + box.w));
    const bottom = Math.max(y, Math.min(options.height, box.y + box.h));
    return { x, y, w: right - x, h: bottom - y };
  };
  const boxes: Box[] = entries.filter((entry) => valid(entry.box)).map((entry) => clamp(entry.padded ? entry.box : {
    x: entry.box.x - options.paddingPx,
    y: entry.box.y - options.paddingPx,
    w: entry.box.w + options.paddingPx * 2,
    h: entry.box.h + options.paddingPx * 2,
  })).filter(valid);

  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        if (!intersects(boxes[i]!, boxes[j]!)) continue;
        boxes[i] = union(boxes[i]!, boxes[j]!);
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
        const combined = union(boxes[i]!, boxes[j]!);
        const overlap = area(boxes[i]!) + area(boxes[j]!) - area(combined);
        const cost = area(combined) - overlap;
        if (cost < bestCost) { bestCost = cost; bestI = i; bestJ = j; }
      }
    }
    boxes[bestI] = union(boxes[bestI]!, boxes[bestJ]!);
    boxes.splice(bestJ, 1);
  }
  return boxes.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Owns active detections, their delay-buffer lifetime and the existing OBS mask pool. */
export class MaskManager {
  private readonly slots: Slot[];
  private readonly active: ActiveBox[] = [];
  private readonly ignored = new Set<string>();
  private readonly holdMs: number;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private panicActive = false;
  private stopped = false;
  private lastUpdateAt: number | undefined;
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
    this.slots = options.maskIds.map((id) => ({ id, enabled: false }));
    for (const [index, existing] of (options.existingMasks ?? []).entries()) {
      const slot = this.slots.find((item) => item.id === existing.id);
      if (!slot || !valid(existing.box)) continue;
      slot.box = { ...existing.box };
      slot.enabled = true;
      this.active.push({ fingerprint: `restart-mask-${index}`, box: { ...existing.box }, expiresAt: this.now() + this.holdMs, padded: true, dismissable: true });
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
      const captureGap = this.lastUpdateAt !== undefined && at - this.lastUpdateAt > this.holdMs;
      const preGapBoxes = captureGap ? this.active.map((item) => ({ ...item, box: { ...item.box } })) : [];
      this.active.splice(0, this.active.length, ...this.active.filter((item) => item.expiresAt > at));
      if (captureGap) {
        for (const previous of preGapBoxes) {
          if (previous.expiresAt <= at && candidates.some((candidate) => valid(candidate.box) && candidate.fingerprint === previous.fingerprint && !this.ignored.has(candidate.fingerprint) && !contains(candidate.box, previous.box))) {
            this.active.push({ ...previous, expiresAt: at + this.holdMs });
          }
        }
      }
      const used = new Set<ActiveBox>();
      for (const candidate of candidates) {
        if (!valid(candidate.box) || this.ignored.has(candidate.fingerprint)) continue;
        const duplicate = this.active.find((item) => used.has(item) && item.fingerprint === candidate.fingerprint && intersects(item.box, candidate.box));
        if (duplicate) {
          duplicate.box = union(duplicate.box, candidate.box);
          continue;
        }
        let match: ActiveBox | undefined;
        let bestArea = Number.POSITIVE_INFINITY;
        for (const item of this.active) {
          if (used.has(item) || item.fingerprint !== candidate.fingerprint || !intersects(item.box, candidate.box)) continue;
          const candidateArea = area(union(item.box, candidate.box));
          if (candidateArea < bestArea) { match = item; bestArea = candidateArea; }
        }
        if (match) {
          // Moved text: the old position left the screen as of this frame, so it keeps its own countdown
          // instead of growing one box along the whole path.
          if (!contains(candidate.box, match.box)) this.active.push({ ...match, box: { ...match.box }, expiresAt: at + this.holdMs });
          match.box = { ...candidate.box };
          match.expiresAt = Number.POSITIVE_INFINITY;
          used.add(match);
        } else {
          const item: ActiveBox = {
            fingerprint: candidate.fingerprint, box: { ...candidate.box }, expiresAt: Number.POSITIVE_INFINITY, padded: false,
            dismissable: candidate.kind !== "sensitive_region",
          };
          this.active.push(item);
          used.add(item);
        }
      }
      // This frame is the first proof these are gone; the delayed output can still show them for holdMs.
      for (const item of this.active) {
        if (!used.has(item) && item.expiresAt === Number.POSITIVE_INFINITY) item.expiresAt = at + this.holdMs;
      }
      await this.render();
      this.lastUpdateAt = at;
    });
  }

  expire(at = this.now()): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return;
      this.active.splice(0, this.active.length, ...this.active.filter((item) => item.expiresAt > at));
      await this.render();
    });
  }

  panicNow(): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) throw new Error("Mask manager has stopped");
      this.panicActive = true;
      await this.render();
    });
  }

  /**
   * During a panic, only lifts the panic: secrets detected under it stay masked. Otherwise dismisses what is
   * masked right now (a false positive) and ignores that text for the session. Sensitive regions always stay.
   */
  unblur(): Promise<void> {
    return this.enqueue(async () => {
      if (this.panicActive) this.panicActive = false;
      else {
        for (const item of this.active) if (item.dismissable) this.ignored.add(item.fingerprint);
        this.active.splice(0, this.active.length, ...this.active.filter((item) => !item.dismissable));
      }
      await this.render();
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
        this.active.push({ fingerprint: `reconnect-${slot.id}-${at}`, box: { ...existing.box }, expiresAt: at + this.holdMs, padded: true, dismissable: true });
        if (existing.box.x <= 0 && existing.box.y <= 0 && existing.box.x + existing.box.w >= this.options.width && existing.box.y + existing.box.h >= this.options.height)
          this.panicActive = true;
      }
      await this.render();
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
      // Text still on screen at shutdown may already be in the delay buffer: hold it a full delay from now.
      const activeExpiry = Math.max(now, ...this.active.map((item) => Math.min(item.expiresAt, now + this.holdMs)));
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

  /** Active boxes are the source of truth: every one is inside a planned target, so any other enabled source can go. */
  private async render(): Promise<void> {
    const targets: Box[] = this.panicActive
      ? [{ x: 0, y: 0, w: this.options.width, h: this.options.height }]
      : planMaskBoxes(this.active, {
        width: this.options.width,
        height: this.options.height,
        paddingPx: this.options.paddingPx ?? 4,
        poolSize: this.slots.length,
      });

    // Reserve still-live sources for targets that contain them before assigning any free slot.
    const orderedTargets = [...targets].sort((a, b) => {
      const containedSlots = (target: Box) => this.slots.filter((slot) => slot.enabled && slot.box && contains(target, slot.box)).length;
      return containedSlots(b) - containedSlots(a);
    });
    const claimed = new Set<Slot>();
    const assignments: Array<{ slot: Slot; target: Box }> = [];
    for (const target of orderedTargets) {
      let slot = this.slots.find((candidate) => !claimed.has(candidate) && candidate.enabled && candidate.box && contains(target, candidate.box));
      slot ??= this.slots.find((candidate) => !claimed.has(candidate) && !candidate.enabled);
      slot ??= this.slots.find((candidate) => !claimed.has(candidate));
      if (!slot) throw new Error("Mask pool allocation failed; refusing to drop a detected mask");
      claimed.add(slot);
      assignments.push({ slot, target });
    }
    // Move sources that are still showing an old box last, after every other target is already covering.
    const movesOldBox = ({ slot, target }: { slot: Slot; target: Box }) => Number(slot.enabled && !contains(target, slot.box!));
    assignments.sort((a, b) => movesOldBox(a) - movesOldBox(b));

    // Place and enable every target before disabling any old slot, so consolidation never uncovers a box.
    for (const { slot, target } of assignments) {
      if (!slot.box || JSON.stringify(slot.box) !== JSON.stringify(target)) await this.options.backend.place(slot.id, target);
      if (!slot.enabled) await this.options.backend.enable(slot.id, true);
      slot.box = { ...target };
      slot.enabled = true;
    }
    for (const slot of this.slots) {
      if (slot.enabled && !claimed.has(slot)) {
        await this.options.backend.enable(slot.id, false);
        slot.enabled = false;
      }
    }
  }

  private async disableAll(): Promise<void> {
    for (const slot of this.slots) {
      if (slot.enabled) await this.options.backend.enable(slot.id, false);
      slot.enabled = false;
    }
  }
}
