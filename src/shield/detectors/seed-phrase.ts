import { createHash } from "node:crypto";
import type { Box } from "../../shared/events.js";
import type { OCRTextLine } from "../ocr/types.js";
import { BIP39_ENGLISH } from "./bip39-english.js";
import { leakFingerprint } from "./text.js";
import type { LeakCandidate } from "./types.js";

const WORD_INDEX = new Map(BIP39_ENGLISH.map((word, index) => [word, index]));
/** Mnemonic lengths BIP39 allows, longest first. */
const LENGTHS = [24, 21, 18, 15, 12];
const SHORTEST = 12;
/** Wallet setup screens and `.env` files name what they show. */
const LABEL = /mnemonic|(?:seed|recovery|secret|backup)[\s_-]*(?:phrase|words)/i;

interface Token {
  /** A BIP39 word, or undefined for any other word (which breaks a run). */
  word?: string;
  /** The `7` in `7. orbit`, as wallets number their grids. */
  number?: number;
  /** Grid cells hold one word; `3. Open the app` is a numbered instruction, not a cell. */
  alone?: boolean;
  box: Box;
}

/** Vision reads a lowercase `l` as a capital `I` (`abiIity`); try that before giving up on a word. */
function bip39Word(raw: string): string | undefined {
  const lower = raw.toLowerCase();
  if (WORD_INDEX.has(lower)) return lower;
  const fixed = raw.replace(/I/g, "l").toLowerCase();
  return WORD_INDEX.has(fixed) ? fixed : undefined;
}

/** Reading order across the frame: rows top to bottom, then words left to right (prepared lines are already one per row). */
function tokensOf(lines: readonly OCRTextLine[]): Token[] {
  const tokens: Token[] = [];
  const rows = [...lines].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  for (const line of rows) {
    let pending: number | undefined;
    let lastNumbered: Token | undefined;
    for (const ocrWord of line.words) {
      for (const piece of ocrWord.text.split(/[^A-Za-z0-9]+/).filter(Boolean)) {
        const numbered = /^(\d{1,2})([A-Za-z]*)$/.exec(piece);
        if (numbered && !numbered[2]) { pending = Number(numbered[1]); continue; }
        const letters = numbered ? numbered[2]! : piece;
        const number = numbered ? Number(numbered[1]) : pending;
        pending = undefined;
        const token: Token = { word: /^[A-Za-z]+$/.test(letters) ? bip39Word(letters) : undefined, number, box: ocrWord.box };
        if (number === undefined) {
          if (lastNumbered) lastNumbered.alone = false;
          lastNumbered = undefined;
        } else {
          token.alone = true;
          lastNumbered = token;
        }
        tokens.push(token);
      }
    }
  }
  return tokens;
}

/** The BIP39 checksum: the last ENT/32 bits must equal the first bits of SHA-256(entropy). One random list in 16+ passes. */
export function isValidMnemonic(words: readonly string[]): boolean {
  if (!LENGTHS.includes(words.length) || words.some((word) => !WORD_INDEX.has(word))) return false;
  const bits = words.map((word) => WORD_INDEX.get(word)!.toString(2).padStart(11, "0")).join("");
  const checksumBits = words.length / 3;
  const entropyBits = bits.slice(0, bits.length - checksumBits);
  const entropy = Buffer.from(entropyBits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const hash = createHash("sha256").update(entropy).digest()[0]!.toString(2).padStart(8, "0");
  return hash.slice(0, checksumBits) === bits.slice(-checksumBits);
}

function union(boxes: readonly Box[]): Box {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  return {
    x: left, y: top,
    w: Math.max(...boxes.map((box) => box.x + box.w)) - left,
    h: Math.max(...boxes.map((box) => box.y + box.h)) - top,
  };
}

const candidate = (tokens: readonly Token[]): LeakCandidate => ({
  kind: "seed_phrase",
  box: union(tokens.map((token) => token.box)),
  preview: "seed phrase",
  fingerprint: leakFingerprint(tokens.map((token) => token.word).join(" ")),
});

/** A numbered grid (`1. orbit  2. lunar …`): wallets show it this way, so the numbers fix the order. One unreadable cell is tolerated. */
function numberedPhrase(tokens: readonly Token[]): Token[] | undefined {
  const byNumber = new Map<number, Token>();
  for (const token of tokens) {
    if (token.word && token.alone && token.number && token.number <= 24 && !byNumber.has(token.number)) byNumber.set(token.number, token);
  }
  const fits = LENGTHS.some((length) => {
    let present = 0;
    for (let number = 1; number <= length; number += 1) if (byNumber.has(number)) present += 1;
    return present >= length - 1;
  });
  return fits ? [...byNumber.entries()].sort(([a], [b]) => a - b).map(([, token]) => token) : undefined;
}

/**
 * Runs of BIP39 words in reading order. Unlabeled, a run counts only where a 12–24 word stretch passes the checksum,
 * so ordinary lists of common words stay unmasked; next to a "seed phrase" or `MNEMONIC` label, 12 words are enough.
 */
function runPhrases(tokens: readonly Token[], labeled: boolean): Token[][] {
  const runs: Token[][] = [[]];
  for (const token of tokens) {
    if (token.word) runs[runs.length - 1]!.push(token);
    else if (runs[runs.length - 1]!.length) runs.push([]);
  }
  return runs.filter((run) => run.length >= SHORTEST).flatMap((run) => {
    if (labeled) return [run];
    for (const length of LENGTHS) {
      for (let start = 0; start + length <= run.length; start += 1) {
        if (isValidMnemonic(run.slice(start, start + length).map((token) => token.word!))) return [run];
      }
    }
    return [];
  });
}

export function detectSeedPhrases(lines: readonly OCRTextLine[]): LeakCandidate[] {
  const tokens = tokensOf(lines);
  if (tokens.filter((token) => token.word).length < SHORTEST - 1) return [];
  const numbered = numberedPhrase(tokens);
  if (numbered) return [candidate(numbered)];
  return runPhrases(tokens, lines.some((line) => LABEL.test(line.text))).map(candidate);
}

const inside = (inner: Box, outer: Box): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/** One phrase is one leak: `Secret Recovery Phrase: …` also reads as a labeled secret, and the phrase mask already covers it. */
export function absorbedBySeedPhrases(leaks: readonly LeakCandidate[]): LeakCandidate[] {
  const phrases = leaks.filter((leak) => leak.kind === "seed_phrase");
  if (!phrases.length) return [...leaks];
  return leaks.filter((leak) => leak.kind === "seed_phrase" || !phrases.some((phrase) => inside(leak.box, phrase.box)));
}
