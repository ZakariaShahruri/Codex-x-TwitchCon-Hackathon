import { performance } from "node:perf_hooks";
import type { OCRTextLine } from "../ocr/types.js";
import { detectCustomRules } from "../detectors/index.js";
import { normalizeWatchlistText } from "../detectors/watchlist.js";

/** What the model returns, before anything is trusted. */
export interface RuleDraft {
  supported: boolean;
  reason: string;
  description: string;
  terms: string[];
  patterns: string[];
  positiveExamples: string[];
  negativeExamples: string[];
}

export interface ValidRule { description: string; terms: string[]; patterns: string[] }

/** Ordinary stream screens. A rule that masks any of these would cover half the stream. */
const EVERYDAY_SCREEN = [
  "Welcome back to the stream, chat!", "const response = await fetch(url);", "git status", "On branch main",
  "Settings", "Sign in", "Search", "Followers 1,204", "Today 9:41 AM", "Downloads", "New message",
  "Thanks for the follow!", "npm run dev", "Page 2 of 14", "Order #4417-2290-1185 shipped", "user@example.com",
  "localhost:3000", "Friday, November 1", "Loading…", "Untitled document", "Inbox (3)", "LIVE · 1,032 viewers",
];

const line = (text: string): OCRTextLine => {
  let x = 0;
  const words = text.split(/\s+/u).filter(Boolean).map((word) => {
    const box = { x, y: 0, w: word.length * 10, h: 12 };
    x += box.w + 4;
    return { text: word, box };
  });
  return { text, box: { x: 0, y: 0, w: Math.max(1, x), h: 12 }, words };
};

const matches = (rule: ValidRule, text: string): boolean => detectCustomRules([line(text)], [{ ...rule, id: "check" }]).length > 0;

/** A group that repeats something already repeating, like `(a+)+` or `(\w*)*`, can take exponential time on a near miss. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/;

function patternProblem(source: string): string | undefined {
  if (source.length > 200) return "a pattern is too long";
  if (NESTED_QUANTIFIER.test(source) || /\\[1-9]/.test(source)) return "a pattern could freeze the shield";
  let pattern: RegExp;
  try { pattern = new RegExp(source, "gi"); } catch { return "a pattern is not a valid regular expression"; }
  if (pattern.test("")) return "a pattern matches empty text";
  for (const probe of ["a".repeat(3_000) + "!", "1".repeat(3_000) + "x", "a1-".repeat(1_000) + "\u0000"]) {
    pattern.lastIndex = 0;
    const startedAt = performance.now();
    pattern.test(probe);
    if (performance.now() - startedAt > 15) return "a pattern is too slow to run on every frame";
  }
  return undefined;
}

/**
 * Checks a draft and returns the rule to save, or the reason to tell the streamer. `example` names the model's own example
 * that failed, for the retry only: it can contain the private words, so it is never shown.
 */
export function validateDraft(draft: RuleDraft): { rule: ValidRule } | { error: string; example?: string } {
  if (!draft.supported) return { error: draft.reason.trim().slice(0, 200) || "Twitchy can only hide text it can read on screen." };
  const terms = [...new Set(draft.terms.map((term) => term.trim()).filter(Boolean))];
  const patterns = [...new Set(draft.patterns.map((pattern) => pattern.trim()).filter(Boolean))];
  if (!terms.length && !patterns.length) return { error: "the rule has no phrases or patterns to look for" };
  if (terms.length > 20 || patterns.length > 10) return { error: "the rule has too many phrases or patterns; keep it to one idea" };
  if (terms.some((term) => term.length > 100 || normalizeWatchlistText(term).length < 3)) return { error: "a phrase is too long or too short" };
  for (const pattern of patterns) {
    const problem = patternProblem(pattern);
    if (problem) return { error: problem };
  }

  const description = draft.description.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!description) return { error: "the rule has no description" };
  const rule: ValidRule = { description, terms, patterns };
  // The description is shown on the overlay and dashboard, so it must not contain what the rule hides.
  const descriptionWords = description.split(/[^\p{L}\p{N}]+/u).map(normalizeWatchlistText).filter((word) => word.length >= 3);
  if (matches(rule, description) || terms.some((term) => descriptionWords.some((word) => normalizeWatchlistText(term).includes(word))))
    return { error: "the description repeats what the rule hides; describe it without the private words" };

  const positives = draft.positiveExamples.map((text) => text.trim()).filter(Boolean);
  const negatives = draft.negativeExamples.map((text) => text.trim()).filter(Boolean);
  if (positives.length < 2 || negatives.length < 2) return { error: "the rule needs at least two examples to hide and two to leave alone" };
  const missed = positives.find((text) => !matches(rule, text));
  if (missed !== undefined) return { error: "the rule does not catch one of its own examples to hide", example: missed };
  // Phrases are the streamer's own words; the examples to leave alone test the patterns, which the model invented.
  const patternsOnly: ValidRule = { ...rule, terms: [] };
  const caught = patterns.length ? negatives.find((text) => matches(patternsOnly, text)) : undefined;
  if (caught !== undefined) return { error: "the rule catches one of its own examples to leave alone", example: caught };
  if (EVERYDAY_SCREEN.some((text) => matches(rule, text))) return { error: "the rule is too broad: it would hide ordinary stream text" };
  return { rule };
}
