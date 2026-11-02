import { createHash } from "node:crypto";
import type { OCRTextLine } from "../ocr/types.js";
import { compactText, candidatesForRanges } from "./text.js";
import type { LeakCandidate, TextRange } from "./types.js";

export interface WatchlistMatchEntry { id: string; label: string; value: string }

/** Normalizes punctuation and spacing away and folds common Vision character confusions. */
export function normalizeWatchlistText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en-US")
    .replace(/[o0]/gu, "0").replace(/[il1|]/gu, "1").replace(/[^\p{L}\p{N}]/gu, "");
}

function allowedDistance(length: number): number {
  if (length <= 8) return 0;
  if (length <= 24) return 1;
  return Math.min(3, Math.floor(length / 12));
}

function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    let minimum = row;
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      // Insertions/deletions cost two: a one-letter longer real name is often a different person.
      current[column] = Math.min(current[column - 1]! + 2, previous[column]! + 2, previous[column - 1]! + cost);
      minimum = Math.min(minimum, current[column]!);
    }
    if (minimum > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length]!;
}

interface TokenRange { normalized: string; start: number; end: number }

function lineTokens(line: OCRTextLine): TokenRange[] {
  const compact = compactText(line.text).text;
  const words = line.words.length ? line.words : [{ text: line.text, box: line.box }];
  let cursor = 0;
  return words.flatMap((word) => {
    const source = compactText(word.text).text;
    if (!source) return [];
    const start = compact.indexOf(source, cursor);
    if (start < 0) return [];
    cursor = start + source.length;
    const normalized = normalizeWatchlistText(word.text);
    return normalized ? [{ normalized, start, end: cursor }] : [];
  });
}

function matchedRanges(line: OCRTextLine, value: string): TextRange[] {
  const target = normalizeWatchlistText(value);
  if (!target) return [];
  const limit = allowedDistance(target.length);
  const tokens = lineTokens(line);
  const ranges: TextRange[] = [];
  for (let start = 0; start < tokens.length; start += 1) {
    let candidate = "";
    for (let end = start; end < tokens.length; end += 1) {
      candidate += tokens[end]!.normalized;
      if (candidate.length > target.length + limit) break;
      if (candidate.length < target.length - limit) continue;
      if (target.length <= 4 && end !== start) break;
      if (editDistance(target, candidate, limit) <= limit) {
        ranges.push({ start: tokens[start]!.start, end: tokens[end]!.end });
        break;
      }
    }
  }
  return ranges;
}

/** Matches each private entry within one prepared OCR line and boxes only the matching words. */
export function detectWatchlist(lines: readonly OCRTextLine[], entries: readonly WatchlistMatchEntry[]): LeakCandidate[] {
  const candidates: LeakCandidate[] = [];
  for (const line of lines) {
    for (const entry of entries) {
      const hits = candidatesForRanges(line, "watchlist", `watchlist: ${entry.label}`, matchedRanges(line, entry.value));
      const stableFingerprint = createHash("sha256").update(`watchlist-entry:${entry.id}`).digest("hex");
      candidates.push(...hits.map((hit) => ({ ...hit, fingerprint: stableFingerprint })));
    }
  }
  return candidates;
}
