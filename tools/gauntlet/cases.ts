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
const long = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

const cases: GauntletCase[] = [
  { id: "sk-project", kind: "api_key", text: token("sk-proj-", long), context: "OpenAI project key", size: "normal" },
  { id: "sk-ant", kind: "api_key", text: token("sk-ant-", long), context: "Anthropic key", size: "normal" },
  { id: "sk-live", kind: "api_key", text: token("sk_live_", long), context: "Stripe live key", size: "normal" },
  { id: "rk-test", kind: "api_key", text: token("rk_test_", long), context: "Stripe restricted key", size: "normal" },
  { id: "ghp", kind: "api_key", text: token("ghp_", long), context: "GitHub token", size: "normal" },
  { id: "gho", kind: "api_key", text: token("gho_", long), context: "GitHub token", size: "normal" },
  { id: "ghs", kind: "api_key", text: token("ghs_", long), context: "GitHub token", size: "normal" },
  { id: "ghu", kind: "api_key", text: token("ghu_", long), context: "GitHub token", size: "normal" },
  { id: "ghr", kind: "api_key", text: token("ghr_", long), context: "GitHub token", size: "normal" },
  { id: "github-pat", kind: "api_key", text: token("github_pat_", long), context: "GitHub fine-grained token", size: "normal" },
  { id: "glpat", kind: "api_key", text: token("glpat-", long), context: "GitLab token", size: "normal" },
  { id: "akia", kind: "api_key", text: token("AKIA", "1234567890ABCDEF"), context: "AWS access key", size: "normal" },
  { id: "aiza", kind: "api_key", text: token("AIza", "12345678901234567890123456789012345"), context: "Google API key", size: "normal" },
  { id: "xoxb", kind: "api_key", text: token("xoxb-", "A1B2C3-D4E5F6-G7H8I9-J0K1L2"), context: "Slack bot token", size: "normal" },
  { id: "hf", kind: "api_key", text: token("hf_", long), context: "Hugging Face token", size: "normal" },
  { id: "npm", kind: "api_key", text: token("npm_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AB"), context: "npm token", size: "normal" },
  { id: "jwt", kind: "api_key", text: token("eyJ", "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature_payload"), context: "JWT", size: "normal" },
  { id: "bearer", kind: "api_key", text: `Authorization: Bearer ${long}`, context: "curl authorization header", size: "normal" },
  { id: "entropy-assignment", kind: "api_key", text: `SERVICE_TOKEN=${long}`, context: "high-entropy .env assignment", size: "normal" },
  { id: "email", kind: "email", text: "STREAMER_EMAIL=demo.person@example.invalid", context: "environment file", size: "normal" },
  { id: "password-env", kind: "password", text: "DB_PASSWORD=CorrectHorseBatteryStaple42", context: ".env", size: "normal" },
  { id: "password-json", kind: "password", text: '"password": "CorrectHorseBatteryStaple42"', context: "JSON", size: "normal" },
  { id: "password-yaml", kind: "password", text: "password: CorrectHorseBatteryStaple42", context: "YAML", size: "normal" },
  { id: "password-code", kind: "password", text: 'const password = "CorrectHorseBatteryStaple42"', context: "source code", size: "normal" },
  { id: "password-url", kind: "password", text: "DATABASE_URL=postgres://demo:CorrectHorseBatteryStaple42@db.invalid/app", context: "URL credential", size: "normal" },
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
  { id: "flash-key", kind: "api_key", text: token("sk-live_", long), context: "brief API key flash", size: "flash" },
  { id: "flash-password", kind: "password", text: "PASSWORD=FlashOnlyPassphrase42", context: "brief password flash", size: "flash" },
];
