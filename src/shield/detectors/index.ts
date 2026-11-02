import type { OCRTextLine } from "../ocr/types.js";
import { detectApiKeys as apiKeys } from "./api-key.js";
import { detectEmails as emails } from "./email.js";
import { prepareOcrLines } from "./ocr-lines.js";
import { detectPasswords as passwords } from "./password.js";
import { detectWatchlist as watchlist, type WatchlistMatchEntry } from "./watchlist.js";
import type { LeakCandidate } from "./types.js";

// Text detectors take raw OCR lines; each normalizes them the same way first.
export const detectApiKeys = (lines: readonly OCRTextLine[]): LeakCandidate[] => apiKeys(prepareOcrLines(lines));
export const detectEmails = (lines: readonly OCRTextLine[]): LeakCandidate[] => emails(prepareOcrLines(lines));
export const detectPasswords = (lines: readonly OCRTextLine[]): LeakCandidate[] => passwords(prepareOcrLines(lines));
export const detectWatchlist = (lines: readonly OCRTextLine[], entries: readonly WatchlistMatchEntry[]): LeakCandidate[] => watchlist(prepareOcrLines(lines), entries);
export { detectSensitiveRegions } from "./sensitive-region.js";
export type { LeakCandidate } from "./types.js";
