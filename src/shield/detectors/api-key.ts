import type { OCRTextLine } from "../ocr/types.js";
import { candidatesForRanges, compactText, normalizeLabel, originalRangeToCompact } from "./text.js";
import type { LeakCandidate, TextRange } from "./types.js";

/**
 * Token body after a provider prefix. A real key is ASCII, so a non-ASCII character inside one is OCR junk
 * (seen live: `M` read as `™`); the prefix is specific enough to accept it.
 */
const body = (ascii: string, length: string): string => `(?:${ascii}|[^\\x00-\\x7F]){${length}}`;
const prefixed = (prefix: string, ascii: string, length: string): RegExp => new RegExp(`${prefix}${body(ascii, length)}`, "gi");

const PREFIX_PATTERNS: RegExp[] = [
  prefixed("sk-(?:proj-|ant-)?", "[A-Z0-9_-]", "20,"),
  prefixed("(?:sk|rk)_(?:live|test)_", "[A-Z0-9]", "16,"),
  prefixed("gh[opsur]_", "[A-Z0-9]", "20,"),
  prefixed("github_pat_", "[A-Z0-9_]", "20,"),
  prefixed("glpat-", "[A-Z0-9_-]", "20,"),
  /AKIA[A-Z0-9]{16}(?![A-Z0-9])/gi,
  /A[I1l]za[A-Z0-9_-]{35}/gi, // Vision reads the `I` as `l` or `1`
  prefixed("xox[abprs]-", "[A-Z0-9-]", "20,"),
  prefixed("hf_", "[A-Z0-9]", "30,"),
  prefixed("npm_", "[A-Z0-9]", "36,"),
  /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?![A-Za-z0-9_-])/g,
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

/**
 * Undoes Vision misreads that break token patterns, keeping the length so offsets stay valid: `l`/`I` read as `|`,
 * or as `[`/`]` mid-token; and a dropped underscore after a known prefix (`hf aHmy…` for `hf_aHmy…`), which small
 * text loses because the underscore sits on the baseline.
 */
const tokenText = (text: string): string => text
  .replace(/\|/g, "l")
  .replace(/(?<=[A-Z0-9])[[\]](?=[A-Z0-9])/gi, "l")
  .replace(/\b((?:sk|rk)[_ ](?:live|test)|gh[opsur]|github_pat|hf|npm) (?=[A-Z0-9]{16})/gi, (_, prefix: string) => `${prefix.replace(" ", "_")}_`);

function findRanges(line: OCRTextLine): TextRange[] {
  const compact = compactText(tokenText(line.text));
  const ranges: TextRange[] = [];
  for (const pattern of PREFIX_PATTERNS) {
    for (const match of compact.text.matchAll(pattern)) {
      const start = match.index;
      if (start === undefined) continue;
      const originalStart = compact.sourceOffsets[start];
      // Whitespace stripped by compactText can otherwise join prose to a token, e.g. "token npm_...".
      if (originalStart !== undefined && originalStart > 0 && /[A-Z0-9_]/i.test(line.text[originalStart - 1])) continue;
      ranges.push({ start, end: start + match[0].length });
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

  for (const match of tokenText(line.text).matchAll(BEARER)) {
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
