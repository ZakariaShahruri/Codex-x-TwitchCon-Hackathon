import type { OCRTextLine } from "../ocr/types.js";
import { candidatesForRanges, originalRangeToCompact } from "./text.js";
import type { LeakCandidate, TextRange } from "./types.js";

/** `+44 20 7946 0958`, `+1 (555) 010-4477`, `+33 6 12 34 56 78`: a `+` country code makes it a phone number. */
const INTERNATIONAL = /\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,6}/g;
/** `(555) 010-4477`, `555-010-4477`, `555.010.4477`: North American, separators required. */
const NORTH_AMERICAN = /(?:\(\d{3}\)\s?|\d{3}[ .-])\d{3}[ .-]\d{4}/g;
/** Any digit run after a phone label: `Mobile: 06 12 34 56 78`, `tel=0612345678`. */
const LABELED = /\b(?:phone|tel|telephone|mobile|cell|whatsapp|sms)(?:[ _-]?(?:number|no\.?|#))?\s*[:=]?\s*((?:\+|\(?\d)[\d ().-]{6,22}\d)/gi;

const digitsOf = (text: string): string => text.replace(/\D/g, "");

/**
 * Not a phone number: part of a longer token (`#555-010-4477`, `v555.010.4477`, `555-010-4477-2`), or
 * a date/time-like value. Phones are rarely glued to letters, `#`, `/`, `:` or `@`.
 */
function isEmbedded(text: string, start: number, end: number): boolean {
  const before = text[start - 1] ?? "";
  const after = text[end] ?? "";
  return /[\p{L}\d#/:@_.-]/u.test(before) || /[\p{L}\d/:@_]/u.test(after) || /^[.-]\d/.test(text.slice(end, end + 2));
}

function rangesOf(line: OCRTextLine): TextRange[] {
  const text = line.text;
  const found: Array<{ start: number; end: number }> = [];
  const add = (start: number, end: number, minDigits: number, maxDigits: number) => {
    const digits = digitsOf(text.slice(start, end)).length;
    if (digits < minDigits || digits > maxDigits || isEmbedded(text, start, end)) return;
    if (found.some((range) => start < range.end && range.start < end)) return;
    found.push({ start, end });
  };
  for (const match of text.matchAll(LABELED)) {
    const value = match[1]!;
    const start = match.index! + match[0].lastIndexOf(value);
    add(start, start + value.length, 7, 15);
  }
  for (const match of text.matchAll(INTERNATIONAL)) {
    // The pattern is greedy, so `+1 555 010 4477 or 2026` can run on; drop trailing groups until it fits.
    let value = match[0];
    while (digitsOf(value).length > 15 && /[ .-]\(?\d+\)?$/.test(value)) value = value.replace(/[ .-]\(?\d+\)?$/, "");
    add(match.index!, match.index! + value.length, 8, 15);
  }
  for (const match of text.matchAll(NORTH_AMERICAN)) add(match.index!, match.index! + match[0].length, 10, 10);
  return found.flatMap(({ start, end }) => originalRangeToCompact(text, start, end) ?? []);
}

/** The shared fingerprint keeps only letters and digits, so one number is one leak however OCR punctuates it. */
export function detectPhones(lines: readonly OCRTextLine[]): LeakCandidate[] {
  return lines.flatMap((line) => candidatesForRanges(line, "phone", "phone number", rangesOf(line)));
}
