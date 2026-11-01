import { createHash } from "node:crypto";
import type { Box } from "../../shared/events.js";
import type { OCRTextLine } from "../ocr/types.js";
import type { LeakCandidate, TextRange } from "./types.js";

export interface CompactText {
  text: string;
  /** Maps each compact UTF-16 offset back to the original line string. */
  sourceOffsets: number[];
}

export function compactText(text: string): CompactText {
  const chars: string[] = [];
  const sourceOffsets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/u.test(text[index])) continue;
    chars.push(text[index]);
    sourceOffsets.push(index);
  }
  return { text: chars.join(""), sourceOffsets };
}

/** `clientSecret`, `client-secret` and `CLIENT_SECRET` all become `CLIENT_SECRET`. */
export function normalizeLabel(label: string): string {
  return label.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toUpperCase();
}

export function originalRangeToCompact(text: string, start: number, end: number): TextRange | undefined {
  let compactStart = 0;
  let compactEnd = 0;
  let compactIndex = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/u.test(text[index])) continue;
    if (index < start) compactStart = compactIndex + 1;
    if (index < end) compactEnd = compactIndex + 1;
    compactIndex += 1;
  }
  return compactEnd > compactStart ? { start: compactStart, end: compactEnd } : undefined;
}

/** Map a matched compact-text span to the union of only the OCR word boxes it overlaps. */
export function wordUnionForRange(line: OCRTextLine, range: TextRange): Box | undefined {
  const compact = compactText(line.text).text;
  const mapped: Array<{ start: number; end: number; box: Box }> = [];
  let cursor = 0;
  for (const word of line.words) {
    const text = compactText(word.text).text;
    if (!text) continue;
    let start = compact.indexOf(text, cursor);
    if (start < 0) start = compact.indexOf(text);
    if (start < 0) continue;
    const end = start + text.length;
    mapped.push({ start, end, box: word.box });
    cursor = end;
  }

  const boxes = mapped
    .filter((word) => word.start < range.end && range.start < word.end)
    .map((word) => word.box)
    .filter((box) => [box.x, box.y, box.w, box.h].every(Number.isFinite) && box.w > 0 && box.h > 0);
  if (boxes.length === 0) {
    // OCR normally supplies word boxes. If it supplies none, the line box is the only safe geometry.
    if (line.words.length === 0 && line.box.w > 0 && line.box.h > 0) return line.box;
    return undefined;
  }

  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * Identity of a matched secret that survives OCR noise between frames: Vision reads the same `-` as `=` or `=-`,
 * and confuses O/0 and l/I/1. Without this, one key would count as several leaks while it moves on screen.
 */
export function leakFingerprint(matched: string): string {
  const stable = matched.toLowerCase().replace(/o/g, "0").replace(/[il]/g, "1").replace(/[^a-z0-9]/g, "");
  return createHash("sha256").update(stable).digest("hex");
}

export function candidatesForRanges(
  line: OCRTextLine,
  kind: LeakCandidate["kind"],
  preview: string,
  ranges: readonly TextRange[],
): LeakCandidate[] {
  const sorted = [...ranges].filter((range) => range.end > range.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  const compact = compactText(line.text).text;
  return merged.flatMap((range) => {
    const box = wordUnionForRange(line, range);
    if (!box) return [];
    return [{ kind, box, preview, fingerprint: leakFingerprint(compact.slice(range.start, range.end)) }];
  });
}
