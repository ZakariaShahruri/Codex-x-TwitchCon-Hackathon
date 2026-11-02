import { isIPv6 } from "node:net";
import type { OCRTextLine } from "../ocr/types.js";
import { candidatesForRanges, originalRangeToCompact } from "./text.js";
import type { LeakCandidate, TextRange } from "./types.js";

/**
 * Four dotted octets, not part of a longer number or dotted run (`1.3.6.1.4.1`). A port or CIDR suffix may follow. Letters
 * may touch it, because live OCR reads `root@203.0.113.7 -p 22` as `rootQ203…` or `…113.7-p`; `v1.2.3.4` is caught as a version below.
 */
const IPV4 = /(?<![\d.-])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d|\.\d|-\d)/g;
/**
 * Hex groups joined by at least two colons; `isIPv6` decides whether it is an address. Live OCR puts a space beside a colon
 * (`2001: db8::1`), reads a colon as `•`, and reads `1` as `l` or `0` as `O`, so those are allowed here and folded before validating.
 * A sentence-ending `.` may follow.
 */
const IPV6 = /(?<![\w:.])[0-9a-flio|]{0,4}(?:[ ]?[:•-]{1,2}[ ]?[0-9a-flio|]{0,4}){2,8}(?![\w:]|\.\w)/gi;
const foldOcr = (value: string): string => value.replace(/\s/g, "").replace(/[•-]/g, ":").replace(/:{3,}/g, "::").replace(/[lIi|]/g, "1").replace(/[oO]/g, "0");
/** A version number is not an address: `version 1.2.0.4`, `build 2.0.1.7`, `v 1.0.0.1`. */
const VERSION_BEFORE = /(?:\b|_)(?:v|ver|version|build|release|rev)\s*[:=]?\s*$/i;
/** Public DNS resolvers everyone types; they reveal nothing about the streamer. */
const PUBLIC_RESOLVERS = new Set(["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9", "149.112.112.112", "208.67.222.222", "208.67.220.220"]);

/** Only an address that can identify the streamer on the internet: not private, loopback, link-local, CGNAT or multicast. */
function isPublicIpv4(octets: number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

/**
 * Global unicast (2000::/3) only: loopback, link-local (`fe80::`) and private (`fd00::`) addresses stay unmasked. OCR often
 * reads `::` as one colon, so 4+ hex groups with a hex letter also count; dates and times (`2024:10:31:12`) have no letter.
 */
function isPublicIpv6(value: string): boolean {
  const groups = value.split(":").filter(Boolean);
  const first = value.split(":")[0] ?? "";
  if (first.length !== 4 || !/^[23]/.test(first) || groups.length < 3) return false;
  if (isIPv6(value)) return true;
  return groups.length >= 4 && groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group)) && /[a-f]/i.test(value);
}

function rangesOf(line: OCRTextLine): TextRange[] {
  const text = line.text;
  const ranges: TextRange[] = [];
  for (const match of text.matchAll(IPV4)) {
    const parts = match.slice(1, 5);
    if (parts.some((part) => part.length > 1 && part.startsWith("0"))) continue;
    const octets = parts.map(Number);
    if (octets.some((octet) => octet > 255) || !isPublicIpv4(octets) || PUBLIC_RESOLVERS.has(match[0])) continue;
    if (VERSION_BEFORE.test(text.slice(Math.max(0, match.index! - 12), match.index!))) continue;
    const range = originalRangeToCompact(text, match.index!, match.index! + match[0].length);
    if (range) ranges.push(range);
  }
  for (const match of text.matchAll(IPV6)) {
    if (!isPublicIpv6(foldOcr(match[0]))) continue;
    const range = originalRangeToCompact(text, match.index!, match.index! + match[0].length);
    if (range) ranges.push(range);
  }
  return ranges;
}

export function detectIps(lines: readonly OCRTextLine[]): LeakCandidate[] {
  return lines.flatMap((line) => candidatesForRanges(line, "ip", "IP address", rangesOf(line)));
}
