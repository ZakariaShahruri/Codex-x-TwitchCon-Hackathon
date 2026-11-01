import type { Box } from "../../shared/events.js";
import type { LeakCandidate } from "./types.js";

export function detectSensitiveRegions(regions: readonly Box[]): LeakCandidate[] {
  return regions
    .filter((box) => [box.x, box.y, box.w, box.h].every(Number.isFinite) && box.w > 0 && box.h > 0)
    .map((box) => ({ kind: "sensitive_region", box: { ...box }, preview: "sensitive region" }));
}
