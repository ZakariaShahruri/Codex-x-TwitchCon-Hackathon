import type { OCRTextLine } from "../ocr/types.js";
import { candidatesForRanges, compactText } from "./text.js";
import type { LeakCandidate, TextRange } from "./types.js";

const EMAIL = /(?<![A-Z0-9.!#$%&'*+/=?^_`{|}~-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+(?![A-Z0-9_-])/gi;

export function detectEmails(lines: readonly OCRTextLine[]): LeakCandidate[] {
  return lines.flatMap((line) => {
    const text = compactText(line.text).text;
    const ranges: TextRange[] = [];
    for (const match of text.matchAll(EMAIL)) {
      if (match.index !== undefined) ranges.push({ start: match.index, end: match.index + match[0].length });
    }
    return candidatesForRanges(line, "email", "email address", ranges);
  });
}
