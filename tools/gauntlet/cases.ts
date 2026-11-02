import { createHash } from "node:crypto";
import type { LeakKind, WatchlistEntryInput } from "../../src/shared/events.js";
import { BIP39_ENGLISH } from "../../src/shield/detectors/bip39-english.js";

export interface GauntletCase {
  id: string;
  kind: LeakKind | null;
  text: string;
  context: string;
  size: "normal" | "flash";
  /** An image shown with the text, served from tools/gauntlet/ (the QR case). */
  image?: string;
}

/** The runner's temporary watchlist: fake people and places, never the streamer's real file. */
export const gauntletWatchlist: readonly WatchlistEntryInput[] = [
  { label: "real name", value: "Marisol Okonkwo-Hart" },
  { label: "home address", value: "1638 Larkspur Lane" },
];

// Token-shaped values are assembled at runtime so repository secret scanners do not
// mistake these synthetic examples for credentials.
const token = (prefix: string, tail: string) => `${prefix}${tail}`;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * A distinct, deterministic random-looking tail per case. Every case needs its own value: the engine treats
 * one value as one leak, so two cases sharing a value would rightly count as a single detection.
 */
function tail(seed: string, length: number, alphabet = BASE62): string {
  let state = [...seed].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16_777_619) >>> 0, 2_166_136_261);
  let result = "";
  while (result.length < length) {
    state = Math.imul(state ^ (state >>> 15), 2_246_822_519) >>> 0;
    state = Math.imul(state ^ (state >>> 13), 3_266_489_917) >>> 0;
    result += alphabet[((state ^ (state >>> 16)) >>> 0) % alphabet.length];
  }
  return result;
}
const long = (seed: string) => tail(seed, 36);
const passphrase = (seed: string) => `Gauntlet-${tail(seed, 10)}`;
const digits = (seed: string, length: number) => tail(seed, length, "0123456789");

/** A Luhn-valid card number with the given issuer prefix, grouped the way the issuer prints it. */
function card(seed: string, prefix: string, length: number, groups: number[]): string {
  const body = `${prefix}${digits(seed, length - prefix.length - 1)}`;
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) {
    let digit = Number(body[body.length - 1 - index]);
    if (index % 2 === 0) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  const number = `${body}${(10 - (sum % 10)) % 10}`;
  let cursor = 0;
  return groups.map((size) => number.slice(cursor, (cursor += size))).join(" ");
}

/** A checksum-valid 12-word BIP39 phrase from deterministic entropy: what a wallet would really show. */
function mnemonic(seed: string): string {
  const entropy = Buffer.from(tail(seed, 32, "0123456789abcdef"), "hex");
  const checksum = createHash("sha256").update(entropy).digest()[0]!.toString(2).padStart(8, "0").slice(0, 4);
  const bits = [...entropy].map((byte) => byte.toString(2).padStart(8, "0")).join("") + checksum;
  return bits.match(/.{11}/g)!.map((chunk) => BIP39_ENGLISH[parseInt(chunk, 2)]!).join(" ");
}

const cases: GauntletCase[] = [
  { id: "sk-project", kind: "api_key", text: token("sk-proj-", long("sk-project")), context: "OpenAI project key", size: "normal" },
  { id: "sk-ant", kind: "api_key", text: token("sk-ant-", long("sk-ant")), context: "Anthropic key", size: "normal" },
  { id: "sk-live", kind: "api_key", text: token("sk_live_", long("sk-live")), context: "Stripe live key", size: "normal" },
  { id: "rk-test", kind: "api_key", text: token("rk_test_", long("rk-test")), context: "Stripe restricted key", size: "normal" },
  { id: "ghp", kind: "api_key", text: token("ghp_", long("ghp")), context: "GitHub token", size: "normal" },
  { id: "gho", kind: "api_key", text: token("gho_", long("gho")), context: "GitHub token", size: "normal" },
  { id: "ghs", kind: "api_key", text: token("ghs_", long("ghs")), context: "GitHub token", size: "normal" },
  { id: "ghu", kind: "api_key", text: token("ghu_", long("ghu")), context: "GitHub token", size: "normal" },
  { id: "ghr", kind: "api_key", text: token("ghr_", long("ghr")), context: "GitHub token", size: "normal" },
  { id: "github-pat", kind: "api_key", text: token("github_pat_", long("github-pat")), context: "GitHub fine-grained token", size: "normal" },
  { id: "glpat", kind: "api_key", text: token("glpat-", long("glpat")), context: "GitLab token", size: "normal" },
  { id: "akia", kind: "api_key", text: token("AKIA", tail("akia", 16, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")), context: "AWS access key", size: "normal" },
  { id: "aiza", kind: "api_key", text: token("AIza", tail("aiza", 35)), context: "Google API key", size: "normal" },
  { id: "xoxb", kind: "api_key", text: token("xoxb-", `${tail("xoxb-1", 12)}-${tail("xoxb-2", 12)}-${tail("xoxb-3", 24)}`), context: "Slack bot token", size: "normal" },
  { id: "hf", kind: "api_key", text: token("hf_", long("hf")), context: "Hugging Face token", size: "normal" },
  { id: "npm", kind: "api_key", text: token("npm_", tail("npm", 36)), context: "npm token", size: "normal" },
  { id: "jwt", kind: "api_key", text: token("eyJ", `hbGciOiJIUzI1NiJ9.eyJzdWIiOiJnYXVudGxldCJ9.${tail("jwt", 43, `${BASE62}-_`)}`), context: "JWT", size: "normal" },
  { id: "bearer", kind: "api_key", text: `Authorization: Bearer ${long("bearer")}`, context: "curl authorization header", size: "normal" },
  { id: "entropy-assignment", kind: "api_key", text: `SERVICE_TOKEN=${long("entropy-assignment")}`, context: "high-entropy .env assignment", size: "normal" },
  { id: "email", kind: "email", text: "STREAMER_EMAIL=demo.person@example.invalid", context: "environment file", size: "normal" },
  { id: "password-env", kind: "password", text: `DB_PASSWORD=${passphrase("password-env")}`, context: ".env", size: "normal" },
  { id: "password-json", kind: "password", text: `"password": "${passphrase("password-json")}"`, context: "JSON", size: "normal" },
  { id: "password-yaml", kind: "password", text: `password: ${passphrase("password-yaml")}`, context: "YAML", size: "normal" },
  { id: "password-code", kind: "password", text: `const password = "${passphrase("password-code")}"`, context: "source code", size: "normal" },
  { id: "password-url", kind: "password", text: `DATABASE_URL=postgres://demo:${passphrase("password-url")}@db.invalid/app`, context: "URL credential", size: "normal" },
  { id: "phone-international", kind: "phone", text: `Call me: +44 20 7946 0${digits("phone-international", 3)}`, context: "UK phone number", size: "normal" },
  { id: "phone-north-america", kind: "phone", text: `cell (555) 01${digits("phone-north-america", 1)}-${digits("phone-na-line", 4)}`, context: "US phone number", size: "normal" },
  { id: "phone-labeled", kind: "phone", text: `Mobile: 06 ${digits("phone-labeled", 8).replace(/(\d\d)(?=\d)/g, "$1 ")}`, context: "French mobile number", size: "normal" },
  { id: "card-visa", kind: "card", text: `Visa ${card("card-visa", "4", 16, [4, 4, 4, 4])} exp 09/29`, context: "credit card", size: "normal" },
  { id: "card-amex", kind: "card", text: `AMEX ${card("card-amex", "37", 15, [4, 6, 5])}`, context: "credit card", size: "normal" },
  { id: "watchlist-name", kind: "watchlist", text: "hey Marisol Okonkwo-Hart, are you live tonight?", context: "watchlist: real name", size: "normal" },
  { id: "watchlist-address", kind: "watchlist", text: "Ship to: 1638 Larkspur Lane, Apt 4", context: "watchlist: home address", size: "normal" },
  { id: "ip-v4", kind: "ip", text: `Your public IP: 203.0.113.${Number(digits("ip-v4", 2)) + 10}`, context: "what's-my-IP page", size: "normal" },
  { id: "ip-v6", kind: "ip", text: `inet6 2a02:6b8:${tail("ip-v6", 4, "0123456789abcdef")}::${tail("ip-v6-host", 3, "123456789abcdef")}`, context: "IPv6 in a terminal", size: "normal" },
  { id: "seed-labeled", kind: "seed_phrase", text: `Secret Recovery Phrase: ${mnemonic("seed-labeled")}`, context: "wallet backup screen", size: "normal" },
  { id: "seed-plain", kind: "seed_phrase", text: mnemonic("seed-plain"), context: "seed phrase pasted in notes, checksum-valid", size: "normal" },
  { id: "qr-login", kind: "qr_code", text: "Scan to sign in on your TV", context: "device login QR code", size: "normal", image: "qr-login.png" },
  { id: "decoy-react-version", kind: null, text: "react@18.3.1", context: "package version", size: "normal" },
  { id: "decoy-password-type", kind: null, text: "password: string", context: "TypeScript type", size: "normal" },
  { id: "decoy-git-remote", kind: null, text: "git@github.com:org/repo.git", context: "SSH Git remote", size: "normal" },
  { id: "decoy-env-var", kind: null, text: "KEY=${VAR}", context: "environment variable reference", size: "normal" },
  { id: "decoy-uuid", kind: null, text: "request_id=550e8400-e29b-41d4-a716-446655440000", context: "log UUID", size: "normal" },
  { id: "decoy-redacted", kind: null, text: "password=****", context: "redacted placeholder", size: "normal" },
  { id: "decoy-timestamp", kind: null, text: "2026-11-02 13:45:07 INFO stream started", context: "log timestamp", size: "normal" },
  { id: "decoy-order-id", kind: null, text: "Order #4417-2290-1185 shipped", context: "order ID", size: "normal" },
  { id: "decoy-non-luhn-card", kind: null, text: "ref 4242 4242 4242 4241", context: "16 digits, fails Luhn", size: "normal" },
  { id: "decoy-ip", kind: null, text: "connected to 192.168.100.200:5432", context: "private IP and port", size: "normal" },
  { id: "decoy-public-dns", kind: null, text: "nameserver 8.8.8.8", context: "public DNS resolver", size: "normal" },
  { id: "decoy-build-number", kind: null, text: "build 2.0.1.7", context: "four-part version", size: "normal" },
  { id: "decoy-word-list", kind: null, text: "apple banana cherry orange lemon grape mango olive onion garlic pepper tomato", context: "12 wordlist words, fails the checksum", size: "normal" },
  { id: "decoy-similar-name", kind: null, text: "hey Marissa Okonkwo-Hart, are you live?", context: "name close to the watchlist", size: "normal" },
];

export const gauntletCases: readonly GauntletCase[] = cases;

/** Briefly visible examples are scored separately because capture can miss the whole flash. */
export const flashCases: readonly GauntletCase[] = [
  { id: "flash-email", kind: "email", text: "demo.flash@example.invalid", context: "alt-tab email flash", size: "flash" },
  { id: "flash-key", kind: "api_key", text: token("sk_live_", long("flash-key")), context: "brief API key flash", size: "flash" },
  { id: "flash-password", kind: "password", text: `PASSWORD=${passphrase("flash-password")}`, context: "brief password flash", size: "flash" },
];
