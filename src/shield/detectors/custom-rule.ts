import type { OCRTextLine } from "../ocr/types.js";
import { candidatesForRanges, originalRangeToCompact } from "./text.js";
import type { LeakCandidate, TextRange } from "./types.js";
import { detectWatchlist } from "./watchlist.js";

/** What the frame loop needs from a compiled rule; the same shape the private store saves. */
export interface CustomRuleMatcher { id: string; description: string; terms: readonly string[]; patterns: readonly string[] }

const compiled = new Map<string, RegExp>();
/** Patterns are validated when the rule is compiled; this caches them so a frame never builds a RegExp. */
function regex(source: string): RegExp {
  let pattern = compiled.get(source);
  if (!pattern) {
    pattern = new RegExp(source, "gi");
    compiled.set(source, pattern);
  }
  return pattern;
}

function patternRanges(line: OCRTextLine, patterns: readonly string[]): TextRange[] {
  const ranges: TextRange[] = [];
  for (const source of patterns) {
    for (const match of line.text.matchAll(regex(source))) {
      if (!match[0]) continue;
      const range = originalRangeToCompact(line.text, match.index!, match.index! + match[0].length);
      if (range) ranges.push(range);
    }
  }
  return ranges;
}

/**
 * Terms match like watchlist entries (OCR-tolerant, whole words when short); patterns are case-insensitive regexes.
 * Only the matched words are masked. Unlike the watchlist, `!unblur` can dismiss a rule's mask, since a model wrote it.
 */
export function detectCustomRules(lines: readonly OCRTextLine[], rules: readonly CustomRuleMatcher[]): LeakCandidate[] {
  const candidates: LeakCandidate[] = [];
  for (const rule of rules) {
    const preview = `rule: ${rule.description}`;
    const terms = rule.terms.map((value, index) => ({ id: `rule:${rule.id}:${index}`, label: rule.description, value }));
    candidates.push(...detectWatchlist(lines, terms).map((hit) => ({ ...hit, kind: "custom_rule" as const, preview })));
    for (const line of lines) candidates.push(...candidatesForRanges(line, "custom_rule", preview, patternRanges(line, rule.patterns)));
  }
  return candidates;
}
