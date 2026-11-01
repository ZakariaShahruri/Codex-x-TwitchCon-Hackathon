import type { OCRTextLine } from "../ocr/types.js";
import { candidatesForRanges, compactText, normalizeLabel, originalRangeToCompact } from "./text.js";
import type { LeakCandidate, TextRange } from "./types.js";

const ASSIGNMENT_LABEL = /[A-Z][A-Z0-9_-]{0,63}/gi;
/** `scheme://user:password@host`; matched on compact text because Vision puts a space after the colon. */
const URL_CREDENTIAL = /[A-Z][A-Z0-9+.-]*:\/\/[^/:@\s]+:([^/@\s]+)@/gi;
const PROSE_START = /^(?:please|use|never|do|don't|should|must|keep|store|enter|type|your|the|this|that|is|are|can|remember|avoid|change|set|example)\b/i;
const TYPE_NAMES = /^(?:string|number|boolean|bool|str|int|bytes|any|unknown|object|none|null|undefined|nil|true|false|optional\[.*\]|string\s*\|\s*undefined)$/i;
const CODE_ROOT = /^(?:process\.env|import\.meta\.env|os\.environ|env|config|settings|req|request|this|self|form|user|args|options|opts|params|props|data|body|input|ctx)\./i;
const PLACEHOLDER =/^(?:[*•●·]{3,}|x{3,}|<[^>]*>|\[[A-Z_ -]+\]|\$\{\{.*\}\}|\$\{.*\}|\$[A-Z_][A-Z0-9_]*|notset|changeme|redacted|hidden)$/i;

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
  for (const match of line.text.matchAll(ASSIGNMENT_LABEL)) {
    const label = match[0];
    if (!label || !isPasswordLabel(label) || match.index === undefined) continue;
    let cursor = match.index + label.length;
    if (line.text[cursor] === "\"" || line.text[cursor] === "'") cursor += 1;
    while (/\s/u.test(line.text[cursor] ?? "")) cursor += 1;
    if (line.text.startsWith(":=", cursor)) cursor += 2;
    else if (line.text[cursor] === ":" || line.text[cursor] === "=") {
      if (line.text[cursor + 1] === "=" || line.text[cursor + 1] === ">") continue;
      cursor += 1;
    } else continue;
    while (/\s/u.test(line.text[cursor] ?? "")) cursor += 1;

    const quote = line.text[cursor] === "\"" || line.text[cursor] === "'" ? line.text[cursor] : undefined;
    const valueStart = quote ? cursor + 1 : cursor;
    let valueEnd: number;
    if (quote) {
      valueEnd = line.text.indexOf(quote, valueStart);
      if (valueEnd < 0) continue;
    } else {
      const valueTail = line.text.slice(valueStart);
      const delimiters = valueTail.startsWith("${") ? /[;,#\r\n]/u : /[;,#}\]\r\n]/u;
      valueEnd = valueTail.search(delimiters);
      valueEnd = valueEnd < 0 ? line.text.length : valueStart + valueEnd;
    }
    const value = line.text.slice(valueStart, valueEnd);
    const trimmed = value.trim().replace(/\s+(?:#|\/\/).*$/, "").trim();
    if (!trimmed || TYPE_NAMES.test(trimmed) || PLACEHOLDER.test(trimmed)) continue;
    if (!quote && (isCodeOrPlaceholder(trimmed) || PROSE_START.test(trimmed))) continue;
    const range = originalRangeToCompact(line.text, valueStart, valueEnd);
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
