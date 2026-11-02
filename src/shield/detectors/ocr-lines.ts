import type { Box } from "../../shared/events.js";
import type { OCRTextLine } from "../ocr/types.js";

/**
 * Cyrillic and Greek letters Vision returns for look-alike Latin glyphs (seen live: `3` read as `З`).
 * Each maps to one UTF-16 unit, so offsets into the text stay valid.
 */
const HOMOGLYPHS: Record<string, string> = {
  А: "A", В: "B", Е: "E", З: "3", І: "I", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", Ѕ: "S", Ј: "J",
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X", ο: "o",
};
const HOMOGLYPH_PATTERN = new RegExp(`[${Object.keys(HOMOGLYPHS).join("")}]`, "gu");

/** Fragments on one row this close (in line heights) are one line that Vision split, e.g. `password:` and its value. */
const MAX_ROW_GAP_HEIGHTS = 2;
const MIN_ROW_OVERLAP = 0.6;
const MAX_HEIGHT_RATIO = 1.5;

const toAscii = (text: string): string => text.replace(HOMOGLYPH_PATTERN, (char) => HOMOGLYPHS[char] ?? char);

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function continuesRow(left: Box, right: Box): boolean {
  const minHeight = Math.min(left.h, right.h);
  if (minHeight <= 0 || Math.max(left.h, right.h) / minHeight > MAX_HEIGHT_RATIO) return false;
  const overlap = Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y);
  const gap = right.x - (left.x + left.w);
  return overlap >= MIN_ROW_OVERLAP * minHeight && gap >= -minHeight / 2 && gap <= MAX_ROW_GAP_HEIGHTS * minHeight;
}

/** Normalizes OCR output before detection: ASCII look-alikes, and same-row fragments joined into one line. */
export function prepareOcrLines(lines: readonly OCRTextLine[]): OCRTextLine[] {
  const rows: Array<{ line: OCRTextLine; last: Box }> = [];
  const byLeft = [...lines].sort((a, b) => a.box.x - b.box.x);
  for (const raw of byLeft) {
    const line: OCRTextLine = {
      text: toAscii(raw.text),
      box: raw.box,
      words: raw.words.map((word) => ({ text: toAscii(word.text), box: word.box })),
    };
    const row = rows.find((candidate) => continuesRow(candidate.last, line.box));
    if (!row) {
      rows.push({ line, last: line.box });
      continue;
    }
    row.line = { text: `${row.line.text} ${line.text}`, box: union(row.line.box, line.box), words: [...row.line.words, ...line.words] };
    row.last = line.box;
  }
  return rows.map((row) => row.line);
}
