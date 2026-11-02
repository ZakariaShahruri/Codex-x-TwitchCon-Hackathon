import { isIPv6 } from "node:net";
import type { OCRTextLine } from "../ocr/types.js";
import { candidatesForRanges, originalRangeToCompact } from "./text.js";
import type { LeakCandidate, TextRange } from "./types.js";

/** Four dotted octets, not part of a longer dotted run (`1.3.6.1.4.1`) or word (`v1.2.3.4`). A port or CIDR suffix may follow. */
const IPV4 = /(?<![\w.-])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w-]|\.\d)/g;
/** A run of hex digits with at least two colons; `isIPv6` decides whether it is an address. A sentence-ending `.` may follow. */
const IPV6 = /(?<![\w:.])[0-9a-f]*:[0-9a-f:]*:[0-9a-f:]*(?![\w:]|\.\w)/gi;
/** A version number is not an address: `version 1.2.0.4`, `build 2.0.1.7`, `v 1.0.0.1`. */
const VERSION_BEFORE = /\b(?:v|ver|version|build|release|rev)\s*[:=]?\s*$/i;
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

/** Global unicast (2000::/3) only: loopback, link-local (`fe80::`) and private (`fd00::`) addresses stay unmasked. */
function isPublicIpv6(value: string): boolean {
  const first = value.split(":")[0] ?? "";
  return isIPv6(value) && first.length === 4 && /^[23]/.test(first) && value.split(":").filter(Boolean).length >= 3;
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
    if (!isPublicIpv6(match[0])) continue;
    const range = originalRangeToCompact(text, match.index!, match.index! + match[0].length);
    if (range) ranges.push(range);
  }
  return ranges;
}

export function detectIps(lines: readonly OCRTextLine[]): LeakCandidate[] {
  return lines.flatMap((line) => candidatesForRanges(line, "ip", "IP address", rangesOf(line)));
}
