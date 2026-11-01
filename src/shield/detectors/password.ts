import type { OCRTextLine } from "../ocr/types.js";
import { candidatesForRanges, compactText, normalizeLabel, originalRangeToCompact } from "./text.js";
import type { LeakCandidate, TextRange } from "./types.js";

/** `label = value`, `label: value`, `label := value` and `"label": "value"`, but not `label == value` or `label => value`. */
const PASSWORD_ASSIGNMENT = /(?:^|[^A-Z0-9_])([A-Z][A-Z0-9_-]{0,63})["']?\s*(?::=|[:=](?![=>]))\s*(?:"([^"\r\n]{1,160})"|'([^'\r\n]{1,160})'|([^#\r\n]{1,160}))/gi;
/** `scheme://user:password@host`; matched on compact text because Vision puts a space after the colon. */
const URL_CREDENTIAL = /[A-Z][A-Z0-9+.-]*:\/\/[^/:@\s]+:([^/@\s]+)@/gi;
const PROSE_START = /^(?:please|use|never|do|don't|should|must|keep|store|enter|type|your|the|this|that|is|are|can|remember|avoid|change|set|example)\b/i;
const TYPE_NAMES = /^(?:string|number|boolean|bool|str|int|bytes|any|unknown|object|none|null|undefined|nil|true|false|optional\[.*\]|string\s*\|\s*undefined)$/i;
const CODE_ROOT = /^(?:process\.env|import\.meta\.env|os\.environ|env|config|settings|req|request|this|self|form|user|args|options|opts|params|props|data|body|input|ctx)\./i;
const PLACEHOLDER =/^(?:[*•●·]{3,}|x{3,}|<[^>]*>|\[[A-Z_ -]+\]|\$\{.*\}|\$[A-Z_][A-Z0-9_]*|notset|changeme|redacted|hidden)$/i;

function isPasswordLabel(rawLabel: string): boolean {
  const label = normalizeLabel(rawLabel);
  return label === "KEY" || /(?:^|_)(?:PASSWORD|PASSWD|PWD|PASSPHRASE|SECRET|SECRET_KEY)$/.test(label);
}

/**
 * Code that refers to a secret rather than containing it: `req.body.password`, `os.getenv("X")`, `input()`,
 * `string`, `password;`, `env.X ?? ''`. A plain `.env` value such as `my.secret` is still treated as a secret.
 */
function isCodeOrPlaceholder(value: string): boolean {
  const raw = value.trim();
  const statementEnd = /[;,]$/.test(raw);
  const compact = raw.replace(/[;,]+$/, "").trim();
  if (TYPE_NAMES.test(compact) || PLACEHOLDER.test(compact)) return true;
  if (/^[A-Z_$][\w$.]*\(.*\)/i.test(compact) || /\s(?:\?\?|\|\||&&|\?)\s/.test(compact)) return true;
  if (/^[A-Z_$][\w$]*$/i.test(compact)) return statementEnd || isPasswordLabel(compact);
  if (/^[A-Z_$][\w$]*(?:\??\.[A-Z_$][\w$]*)+$/i.test(compact)) return statementEnd || CODE_ROOT.test(compact);
  return false;
}

function assignmentRanges(line: OCRTextLine): TextRange[] {
  const ranges: TextRange[] = [];
  for (const match of line.text.matchAll(PASSWORD_ASSIGNMENT)) {
    const label = match[1];
    if (!label || !isPasswordLabel(label) || match.index === undefined) continue;
    const quoted = match[2] ?? match[3];
    const value = quoted ?? match[4];
    if (value === undefined) continue;
    const trimmed = value.trim().replace(/\s+(?:#|\/\/).*$/, "").trim();
    if (!trimmed || PLACEHOLDER.test(trimmed)) continue;
    if (quoted === undefined && (isCodeOrPlaceholder(trimmed) || PROSE_START.test(trimmed))) continue;
    const valueOffset = match[0].lastIndexOf(value);
    const range = originalRangeToCompact(line.text, match.index + valueOffset, match.index + valueOffset + value.length);
    if (range) ranges.push(range);
  }
  return ranges;
}

function urlCredentialRanges(line: OCRTextLine): TextRange[] {
  const compact = compactText(line.text).text;
  const ranges: TextRange[] = [];
  for (const match of compact.matchAll(URL_CREDENTIAL)) {
    const password = match[1];
    if (!password || match.index === undefined || PLACEHOLDER.test(password)) continue;
    const start = match.index + match[0].lastIndexOf(`${password}@`);
    ranges.push({ start, end: start + password.length });
  }
  return ranges;
}

export function detectPasswords(lines: readonly OCRTextLine[]): LeakCandidate[] {
  return lines.flatMap((line) => candidatesForRanges(line, "password", "password", [...assignmentRanges(line), ...urlCredentialRanges(line)]));
}
