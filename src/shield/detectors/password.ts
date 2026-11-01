import type { OCRTextLine } from "../ocr/types.js";
import { candidatesForRanges, originalRangeToCompact } from "./text.js";
import type { LeakCandidate, TextRange } from "./types.js";

const PASSWORD_ASSIGNMENT = /(?:^|[^A-Z0-9_])([A-Z][A-Z0-9_]{0,63})\s*[:=]\s*(?:"([^"\r\n]{1,160})"|'([^'\r\n]{1,160})'|([^#\r\n]{1,160}))/gi;
const PROSE_START = /^(?:please|use|never|do|don't|should|must|keep|store|enter|type|your|the|this|that|is|are|can|remember|avoid|change|set|example)\b/i;

function isPasswordLabel(label: string): boolean {
  return label === "KEY" || /(?:^|_)(?:PASSWORD|PASSWD|PWD|PASSPHRASE|SECRET)$/i.test(label) ||
    /(?:^|_)(?:SECRET_KEY)$/i.test(label);
}

function isCodeReference(value: string): boolean {
  const compact = value.trim().replace(/[;,]+$/, "");
  return /^(?:process\.env|import\.meta\.env|env)\.[A-Z0-9_]+(?:\(\))?$/i.test(compact) ||
    /^(?:undefined|null|nil|none|notset|changeme)$/i.test(compact);
}

export function detectPasswords(lines: readonly OCRTextLine[]): LeakCandidate[] {
  return lines.flatMap((line) => {
    const ranges: TextRange[] = [];
    PASSWORD_ASSIGNMENT.lastIndex = 0;
    for (const match of line.text.matchAll(PASSWORD_ASSIGNMENT)) {
      const label = match[1];
      if (!label || !isPasswordLabel(label) || match.index === undefined) continue;
      const value = match[2] ?? match[3] ?? match[4];
      if (value === undefined) continue;
      const trimmed = value.trim().replace(/\s+#.*$/, "").trim();
      if (!trimmed || isCodeReference(trimmed) || PROSE_START.test(trimmed)) continue;
      const valueOffset = match[0].lastIndexOf(value);
      const range = originalRangeToCompact(line.text, match.index + valueOffset, match.index + valueOffset + value.length);
      if (range) ranges.push(range);
    }
    return candidatesForRanges(line, "password", "password", ranges);
  });
}
