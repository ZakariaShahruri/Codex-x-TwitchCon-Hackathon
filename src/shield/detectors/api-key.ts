import type { OCRTextLine } from "../ocr/types.js";
import { candidatesForRanges, compactText, normalizeLabel, originalRangeToCompact } from "./text.js";
import type { LeakCandidate, TextRange } from "./types.js";

const PREFIX_PATTERNS: RegExp[] = [
  /(?<![A-Z0-9_])sk-(?:proj-|ant-)?[A-Z0-9_-]{20,}/gi,
  /(?<![A-Z0-9_])(?:sk|rk)_(?:live|test)_[A-Z0-9]{16,}/gi,
  /(?<![A-Z0-9_])gh[opsur]_[A-Z0-9]{20,}/gi,
  /(?<![A-Z0-9_])github_pat_[A-Z0-9_]{20,}/gi,
  /(?<![A-Z0-9_])glpat-[A-Z0-9_-]{20,}/gi,
  /(?<![A-Z0-9_])AKIA[A-Z0-9]{16}(?![A-Z0-9])/gi,
  /(?<![A-Z0-9_])AIza[A-Z0-9_-]{35}/gi,
  /(?<![A-Z0-9_])xox[abprs]-[A-Z0-9-]{20,}/gi,
  /(?<![A-Z0-9_])hf_[A-Z0-9]{30,}/gi,
  /(?<![A-Z0-9_])npm_[A-Z0-9]{36,}/gi,
  /(?<![A-Z0-9_])eyJ[A-Z0-9_-]{5,}\.[A-Z0-9_-]{5,}\.[A-Z0-9_-]{5,}(?![A-Z0-9_-])/g,
];

const CREDENTIAL_ASSIGNMENT = /([A-Z][A-Z0-9_-]{0,63})["']?[:=]["']?([A-Z0-9~._:/+@=-]{16,})/gi;
/** Matched on the original line so the space after `Bearer` is required. */
const BEARER = /\bBearer\s+([A-Z0-9._~+/-]{20,}=*)/gi;

function isCredentialLabel(rawLabel: string): boolean {
  const label = normalizeLabel(rawLabel);
  if (/_(?:URL|URI|ENDPOINT|HOST|PATH|FILE|NAME|TYPE|ID|EXPIRY|EXPIRES|EXPIRES_AT|TTL|LENGTH)$/.test(label)) return false;
  return label === "KEY" || label === "TOKEN" || label === "SECRET" ||
    /(?:^|_)(?:API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|TOKEN|SECRET|AUTH_?TOKEN|BEARER_?TOKEN|CREDENTIALS?)(?:_|$)/.test(label);
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  return [...counts.values()].reduce((sum, count) => {
    const probability = count / value.length;
    return sum - probability * Math.log2(probability);
  }, 0);
}

function looksLikeHighEntropyCredential(value: string): boolean {
  if (/^[A-Z][A-Z0-9+.-]*:\/\//i.test(value)) return false;
  return value.length >= 24 && new Set(value).size >= 12 && entropy(value) >= 3.45;
}

function findRanges(line: OCRTextLine): TextRange[] {
  const compact = compactText(line.text);
  const ranges: TextRange[] = [];
  for (const pattern of PREFIX_PATTERNS) {
    for (const match of compact.text.matchAll(pattern)) {
      const start = match.index;
      if (start !== undefined) ranges.push({ start, end: start + match[0].length });
    }
  }

  for (const match of compact.text.matchAll(CREDENTIAL_ASSIGNMENT)) {
    if (!match[1] || !match[2] || match.index === undefined || !isCredentialLabel(match[1])) continue;
    const originalStart = compact.sourceOffsets[match.index];
    if (originalStart !== undefined && originalStart > 0 && /[A-Z0-9_]/i.test(line.text[originalStart - 1])) continue;
    if (!looksLikeHighEntropyCredential(match[2])) continue;
    const valueStart = match.index + match[0].lastIndexOf(match[2]);
    ranges.push({ start: valueStart, end: valueStart + match[2].length });
  }

  for (const match of line.text.matchAll(BEARER)) {
    const token = match[1];
    if (!token || match.index === undefined || !looksLikeHighEntropyCredential(token)) continue;
    const start = match.index + match[0].lastIndexOf(token);
    const range = originalRangeToCompact(line.text, start, start + token.length);
    if (range) ranges.push(range);
  }
  return ranges;
}

export function detectApiKeys(lines: readonly OCRTextLine[]): LeakCandidate[] {
  return lines.flatMap((line) => candidatesForRanges(line, "api_key", "API key", findRanges(line)));
}
