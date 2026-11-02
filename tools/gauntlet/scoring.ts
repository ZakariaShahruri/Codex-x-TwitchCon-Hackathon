import type { Box, LeakKind } from "../../src/shared/events.js";

export interface GauntletRunCase {
  id: string;
  kind: LeakKind | null;
  region: Box;
  paintedAt: number;
  hiddenAt: number;
  flash?: boolean;
}

export interface GauntletLeakEvent {
  id: string;
  kind: LeakKind;
  box: Box;
  at: number;
}

export interface GauntletClearEvent { id: string; at: number }

export interface ScoredCase {
  id: string;
  status: "blocked" | "missed" | "pending";
  latencyMs?: number;
  leakId?: string;
}

export interface GauntletScore {
  headline: { blocked: number; eligible: number; falseAlarms: number; p50Ms: number; p95Ms: number; everyMaskUpBeforeAir: boolean };
  flash: { blocked: number; eligible: number; results: ScoredCase[] };
  cases: ScoredCase[];
  falseAlarmLeakIds: string[];
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function percentile(samples: readonly number[], fraction: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? 0;
}

/** Pure deterministic scorer. Mask-live timestamps come from the runner's OBS observations. */
export function scoreGauntlet(input: {
  cases: readonly GauntletRunCase[];
  detected: readonly GauntletLeakEvent[];
  cleared: readonly GauntletClearEvent[];
  maskLiveAt: ReadonlyMap<string, number>;
  enabledDetectors: readonly LeakKind[];
  delayMs: number;
}): GauntletScore {
  const clearAt = new Map(input.cleared.map((event) => [event.id, event.at]));
  const unusedEvents = new Set(input.detected.map((_, index) => index));
  const results: ScoredCase[] = [];
  const latencies: number[] = [];
  let eligible = 0;
  let blocked = 0;

  for (const example of input.cases) {
    if (example.kind && !input.enabledDetectors.includes(example.kind)) {
      results.push({ id: example.id, status: "pending" });
      continue;
    }
    if (!example.flash) eligible += 1;
    const matchIndex = example.kind === null ? undefined : input.detected.findIndex((event, index) =>
      unusedEvents.has(index) && event.kind === example.kind && overlaps(event.box, example.region) &&
      event.at >= example.paintedAt && event.at <= example.hiddenAt + input.delayMs);
    if (matchIndex === undefined || matchIndex < 0) {
      results.push({ id: example.id, status: "missed" });
      continue;
    }
    unusedEvents.delete(matchIndex);
    const event = input.detected[matchIndex]!;
    const liveAt = input.maskLiveAt.get(event.id);
    const latencyMs = liveAt === undefined ? undefined : liveAt - example.paintedAt;
    const stayedThroughAir = (clearAt.get(event.id) ?? Number.POSITIVE_INFINITY) >= example.hiddenAt + input.delayMs;
    const coveredBeforeAir = liveAt !== undefined && liveAt <= example.paintedAt + input.delayMs;
    const isBlocked = coveredBeforeAir && stayedThroughAir;
    if (isBlocked && !example.flash) blocked += 1;
    if (latencyMs !== undefined && Number.isFinite(latencyMs) && !example.flash) latencies.push(latencyMs);
    results.push({ id: example.id, status: isBlocked ? "blocked" : "missed", ...(latencyMs === undefined ? {} : { latencyMs }), leakId: event.id });
  }

  const falseAlarmLeakIds = [...unusedEvents].map((index) => input.detected[index]!.id);
  const headlineResults = results.filter((result) => !input.cases.find((example) => example.id === result.id)?.flash);
  const flashResults = results.filter((result) => input.cases.find((example) => example.id === result.id)?.flash);
  const flashEligible = flashResults.filter((result) => result.status !== "pending").length;
  return {
    headline: {
      blocked,
      eligible,
      falseAlarms: falseAlarmLeakIds.length,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      everyMaskUpBeforeAir: eligible > 0 && blocked === eligible,
    },
    flash: { blocked: flashResults.filter((result) => result.status === "blocked").length, eligible: flashEligible, results: flashResults },
    cases: headlineResults,
    falseAlarmLeakIds,
  };
}
