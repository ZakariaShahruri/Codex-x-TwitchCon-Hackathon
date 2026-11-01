import assert from "node:assert/strict";
import test from "node:test";
import type { Box } from "../../shared/events.js";
import type { OCRTextLine } from "../ocr/types.js";
import { detectApiKeys, detectEmails, detectPasswords, detectSensitiveRegions } from "./index.js";

function line(text: string, words: string[] = text.split(/\s+/u)): OCRTextLine {
  let x = 0;
  const wordBoxes = words.map((word) => {
    const box: Box = { x, y: 20, w: word.length * 10, h: 12 };
    x += box.w + 2;
    return { text: word, box };
  });
  return { text, box: { x: 0, y: 20, w: x, h: 12 }, words: wordBoxes };
}

function assertOnlyMatchedWord(candidate: { box: Box }, word: { box: Box }): void {
  assert.deepEqual(candidate.box, word.box);
}

test("API key detector recognizes provider prefixes and OCR-spaced assignments", () => {
  const key = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345";
  const observation = line(`OPENAI_API_KEY : ${key}`, ["OPENAI_API_KEY", ":", key]);
  const [candidate] = detectApiKeys([observation]);
  assert.ok(candidate);
  assert.equal(candidate.kind, "api_key");
  assert.equal(candidate.preview.includes(key), false);
  assertOnlyMatchedWord(candidate, observation.words[2]!);

  for (const token of ["ghp_abcdefghijklmnopqrstuvwxyz123456", "AKIA1234567890ABCDEF", "xoxb-FAKE-FAKE-FAKE-FAKE-FAKE"]) {
    assert.equal(detectApiKeys([line(token)]).length, 1, token);
  }
});

test("email detector tolerates OCR whitespace and boxes only the address", () => {
  const address = "streamer@example.invalid";
  const observation = line(`EMAIL : ${address}`, ["EMAIL", ":", address]);
  const [candidate] = detectEmails([observation]);
  assert.ok(candidate);
  assert.equal(candidate.kind, "email");
  assertOnlyMatchedWord(candidate, observation.words[2]!);
});

test("password detector masks only assigned values including OCR-spaced values", () => {
  const observation = line('DB_PASSWORD : "correct horse battery staple"', ["DB_PASSWORD", ":", '"correct', "horse", "battery", 'staple"']);
  const [candidate] = detectPasswords([observation]);
  assert.ok(candidate);
  assert.equal(candidate.kind, "password");
  assert.deepEqual(candidate.box, { x: observation.words[2]!.box.x, y: 20, w: observation.words.slice(2).reduce((n, word) => n + word.box.w, 0) + 6, h: 12 });

  const keyLine = line("KEY = value-from-env", ["KEY", "=", "value-from-env"]);
  const [keyCandidate] = detectPasswords([keyLine]);
  assert.ok(keyCandidate);
  assertOnlyMatchedWord(keyCandidate, keyLine.words[2]!);
});

test("sensitive regions preserve valid canvas boxes and reject invalid boxes", () => {
  const region = { x: 100, y: 80, w: 240, h: 90 };
  const [candidate] = detectSensitiveRegions([region, { x: 0, y: 0, w: 0, h: 12 }]);
  assert.ok(candidate);
  assert.equal(candidate.kind, "sensitive_region");
  assert.deepEqual(candidate.box, region);
  assert.equal(candidate.preview, "sensitive region");
  assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/u);
});

test("connection-string passwords and Bearer tokens mask only the secret", () => {
  const url = line("DATABASE_URL=postgres://demo: FakePassword123@localhost:5432/app", ["DATABASE_URL=postgres://demo:", "FakePassword123@localhost:5432/app"]);
  const [password] = detectPasswords([url]);
  assert.ok(password);
  assertOnlyMatchedWord(password, url.words[1]!);

  const header = line("Authorization: Bearer AbCdEfGhIjKlMnOpQrStUvWxYz0123456789xyz");
  const [token] = detectApiKeys([header]);
  assert.ok(token);
  assertOnlyMatchedWord(token, header.words[2]!);
});

test("detectors catch common real-world secrets", () => {
  const secrets = [
    "DATABASE_URL=postgres://demo:FakePassword123@localhost:5432/app",
    "mysql://root:s3cr3t@db.internal/app",
    '"password": "hunter2-Secret"',
    "password = 'hunter2'",
    "Password: hunter2",
    'password := "hunter2"',
    'user.password = "hunter2"',
    'clientSecret = "a8Fk2mQ9zX"',
    "DB_PASSWORD=hunter2",
    "PASSWORD=my.secret",
    "SMTP_PASSWORD=Tr0ub4dor&3",
    "password: correct horse battery staple",
    "export OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWx",
    'const apiKey = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx"',
    '"api_key": "Zx8Qm2Lp9Tr4Vw7Ks1Jd6Hf3Ng5Yb0Ca"',
    "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx",
    "AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW",
    // Stripe-shaped fakes are assembled at runtime so GitHub push protection doesn't flag them.
    `${"sk_"}live_51HxYzAbCdEfGhIjKlMnOpQrSt`,
    `STRIPE_SECRET_KEY=${"sk_"}test_AbCdEfGhIjKlMnOpQrSt`,
    "glpat-AbCdEfGhIjKlMnOpQrSt",
    "hf_AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    "npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "ghs_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "gho_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "xoxa-AbCdEfGhIjKlMnOpQrStUv",
    "TWITCH_BOT_TOKEN=oauth: fake-twitch-token-abcdef0123456789",
    "contact: john.doe@gmail.com",
  ];
  for (const text of secrets) {
    const lines = [line(text)];
    assert.notEqual([...detectApiKeys(lines), ...detectEmails(lines), ...detectPasswords(lines)].length, 0, text);
  }
});

test("detectors avoid prose, code references, versions and placeholders", () => {
  const nearMisses = [
    "const response = await client.get('/health')",
    "The API key is stored safely in the environment",
    "request_id=550e8400-e29b-41d4-a716-446655440000",
    "commit deadbeef0123456789abcdef0123456789abcdef",
    "version v1.2.3",
    "OPENAI_API_KEY: sk-test",
    "PASSWORD: process.env.PASSWORD",
    "PASSWORD: Please keep this value private",
    "added react@18.3.1 and obs-websocket-js@5.0.6",
    "npm install @types/node@22.10.1",
    "img src=logo@2x.png",
    "git clone git@github.com:twitchy/shield.git",
    "password: ********",
    "password: <hidden>",
    "password: string",
    "SECRET: string;",
    "isPassword: true",
    "const password = req.body.password;",
    "this.password = password;",
    "password: hashedPassword,",
    "if (password == null) return;",
    "if (password != confirm)",
    "(password) => hash(password)",
    'password = os.getenv("DB_PASSWORD")',
    "password = input()",
    "password: process.env.DB_PASSWORD ?? ''",
    "password: ${{ secrets.DB_PASSWORD }}",
    "DB_PASSWORD=${DB_PASSWORD}",
    "postgres://user:${DB_PASS}@localhost/app",
    "TOKEN_URL=https://id.twitch.tv/oauth2/token",
    "TOKEN_EXPIRES_AT=1730419200000000000000",
  ];
  for (const text of nearMisses) {
    const lines = [line(text)];
    assert.deepEqual([...detectApiKeys(lines), ...detectEmails(lines), ...detectPasswords(lines)], [], text);
  }
});
