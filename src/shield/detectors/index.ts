import type { OCRTextLine } from "../ocr/types.js";
import { detectApiKeys as apiKeys } from "./api-key.js";
import { detectCards as cards } from "./card.js";
import { detectEmails as emails } from "./email.js";
import { detectIps as ips } from "./ip.js";
import { prepareOcrLines } from "./ocr-lines.js";
import { detectPasswords as passwords } from "./password.js";
import { detectPhones as phones } from "./phone.js";
import { detectSeedPhrases as seedPhrases } from "./seed-phrase.js";
import { detectWatchlist as watchlist, type WatchlistMatchEntry } from "./watchlist.js";
import type { LeakCandidate } from "./types.js";

// Text detectors take raw OCR lines; each normalizes them the same way first.
export const detectApiKeys = (lines: readonly OCRTextLine[]): LeakCandidate[] => apiKeys(prepareOcrLines(lines));
export const detectEmails = (lines: readonly OCRTextLine[]): LeakCandidate[] => emails(prepareOcrLines(lines));
export const detectPasswords = (lines: readonly OCRTextLine[]): LeakCandidate[] => passwords(prepareOcrLines(lines));
export const detectPhones = (lines: readonly OCRTextLine[]): LeakCandidate[] => phones(prepareOcrLines(lines));
export const detectCards = (lines: readonly OCRTextLine[]): LeakCandidate[] => cards(prepareOcrLines(lines));
export const detectIps = (lines: readonly OCRTextLine[]): LeakCandidate[] => ips(prepareOcrLines(lines));
export const detectSeedPhrases = (lines: readonly OCRTextLine[]): LeakCandidate[] => seedPhrases(prepareOcrLines(lines));
export { absorbedBySeedPhrases } from "./seed-phrase.js";
export { detectQrCodes } from "./qr-code.js";
export const detectWatchlist = (lines: readonly OCRTextLine[], entries: readonly WatchlistMatchEntry[]): LeakCandidate[] => watchlist(prepareOcrLines(lines), entries);
export { detectSensitiveRegions } from "./sensitive-region.js";
export type { LeakCandidate } from "./types.js";
