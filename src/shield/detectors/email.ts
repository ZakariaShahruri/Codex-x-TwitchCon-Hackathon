import type { OCRTextLine } from "../ocr/types.js";
import { candidatesForRanges, originalRangeToCompact } from "./text.js";
import type { LeakCandidate, TextRange } from "./types.js";

/** The top-level domain must be letters, so `react@18.3.1` is not an address. */
const EMAIL = /(?<![A-Z0-9.!#$%&'*+/=?^_`{|}~-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,63}(?![A-Z0-9_-])/gi;

/** Not personal addresses: SSH git remotes and retina asset names like `logo@2x.png`. */
function isNotAnAddress(match: string): boolean {
  return /^git@/i.test(match) || /@\d+(?:\.\d+)?x\./i.test(match);
}

export function detectEmails(lines: readonly OCRTextLine[]): LeakCandidate[] {
  return lines.flatMap((line) => {
    const ranges: TextRange[] = [];
    for (const match of line.text.matchAll(EMAIL)) {
      if (match.index === undefined || isNotAnAddress(match[0])) continue;
      const range = originalRangeToCompact(line.text, match.index, match.index + match[0].length);
      if (range) ranges.push(range);
    }
    return candidatesForRanges(line, "email", "email address", ranges);
  });
}
