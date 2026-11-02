import type { LeakKind } from "../../src/shared/events.js";

export interface GauntletCase {
  id: string;
  kind: LeakKind | null;
  text: string;
  context: string;
  size: "normal" | "flash";
}

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
  { id: "decoy-react-version", kind: null, text: "react@18.3.1", context: "package version", size: "normal" },
  { id: "decoy-password-type", kind: null, text: "password: string", context: "TypeScript type", size: "normal" },
  { id: "decoy-git-remote", kind: null, text: "git@github.com:org/repo.git", context: "SSH Git remote", size: "normal" },
  { id: "decoy-env-var", kind: null, text: "KEY=${VAR}", context: "environment variable reference", size: "normal" },
  { id: "decoy-uuid", kind: null, text: "request_id=550e8400-e29b-41d4-a716-446655440000", context: "log UUID", size: "normal" },
  { id: "decoy-redacted", kind: null, text: "password=****", context: "redacted placeholder", size: "normal" },
];

export const gauntletCases: readonly GauntletCase[] = cases;

/** Briefly visible examples are scored separately because capture can miss the whole flash. */
export const flashCases: readonly GauntletCase[] = [
  { id: "flash-email", kind: "email", text: "demo.flash@example.invalid", context: "alt-tab email flash", size: "flash" },
  { id: "flash-key", kind: "api_key", text: token("sk_live_", long("flash-key")), context: "brief API key flash", size: "flash" },
  { id: "flash-password", kind: "password", text: `PASSWORD=${passphrase("flash-password")}`, context: "brief password flash", size: "flash" },
];
