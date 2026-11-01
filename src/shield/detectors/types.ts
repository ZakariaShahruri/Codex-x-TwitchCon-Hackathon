import type { Box, LeakKind } from "../../shared/events.js";

/** Transient detector output. `preview` is a fixed redacted label, never matched text. */
export interface LeakCandidate {
  kind: LeakKind;
  box: Box;
  preview: string;
}

export interface TextRange { start: number; end: number }
