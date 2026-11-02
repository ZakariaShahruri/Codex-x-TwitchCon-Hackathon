import type { OCRTextLine } from "../ocr/types.js";
import { candidatesForRanges, originalRangeToCompact } from "./text.js";
import type { LeakCandidate, TextRange } from "./types.js";

/** 13–19 digits, optionally grouped by single spaces or dashes (`4242 4242 4242 4242`, `3782-822463-10005`). */
const CARD = /(?<![\d.,/-])\d(?:[ -]?\d){12,18}(?![\d.,/-]?\d)/g;

/** Issuer prefixes and lengths: Visa, Mastercard, Amex, Discover, JCB, Diners, UnionPay. */
const ISSUERS: Array<{ prefix: RegExp; lengths: number[] }> = [
  { prefix: /^4/, lengths: [13, 16, 19] },
  { prefix: /^(?:5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/, lengths: [16] },
  { prefix: /^3[47]/, lengths: [15] },
  { prefix: /^(?:6011|65|64[4-9])/, lengths: [16, 17, 18, 19] },
  { prefix: /^35(?:2[89]|[3-8]\d)/, lengths: [16, 17, 18, 19] },
  { prefix: /^3(?:0[0-5]|[689])/, lengths: [14, 15, 16, 17, 18, 19] },
  { prefix: /^62/, lengths: [16, 17, 18, 19] },
];

function luhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Real card numbers use one separator style; `1234-5678 9012` mixes them and is something else. */
const consistentSeparators = (value: string): boolean => !(value.includes(" ") && value.includes("-"));

export function isCardNumber(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (!consistentSeparators(value) || /^(\d)\1+$/.test(digits)) return false;
  return ISSUERS.some(({ prefix, lengths }) => prefix.test(digits) && lengths.includes(digits.length)) && luhn(digits);
}

export function detectCards(lines: readonly OCRTextLine[]): LeakCandidate[] {
  return lines.flatMap((line) => {
    const ranges: TextRange[] = [];
    for (const match of line.text.matchAll(CARD)) {
      // The run can include a following group (`4242 4242 4242 4242 12`); try dropping trailing groups.
      let value = match[0];
      while (!isCardNumber(value) && /[ -]\d+$/.test(value)) value = value.replace(/[ -]\d+$/, "");
      if (!isCardNumber(value)) continue;
      const range = originalRangeToCompact(line.text, match.index!, match.index! + value.length);
      if (range) ranges.push(range);
    }
    return candidatesForRanges(line, "card", "credit card", ranges);
  });
}
