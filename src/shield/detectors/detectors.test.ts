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

test("OCR readings of the same secret share one fingerprint; different secrets do not", () => {
  // Vision readings of one fake token at different screen offsets (see docs/architecture.md §9).
  const readings = [
    "TWITCH_BOT_TOKEN=oauth: fake-twitch-token-abcdef0123456789",
    "TWITCH_BOT_TOKEN=oauth: fake-twitch-token=abcdef0123456789",
    "TWITCH_BOT_TOKEN=oauth: fake-twitch-token=-abcdef0123456789",
    "TWITCH_BOT_TOKEN=oauth: fake-twitch-tOken-abcdef0l23456789",
  ];
  const fingerprints = readings.map((text) => detectApiKeys([line(text)])[0]?.fingerprint);
  assert.ok(fingerprints[0]);
  assert.equal(new Set(fingerprints).size, 1);

  const other = detectApiKeys([line("TWITCH_BOT_TOKEN=oauth: fake-twitch-token-abcdef0123456780")])[0]?.fingerprint;
  assert.ok(other);
  assert.notEqual(other, fingerprints[0]);
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

test("adversarial streamer-screen corpus covers formats, tooling, code and OCR damage", () => {
  const openAiKey = ["sk-", "proj-", "AbCdEfGhIjKlMnOpQrStUvWx0123456789"].join("");
  const stripeKey = ["sk_", "live_", "51HxYzAbCdEfGhIjKlMnOpQrStUv"].join("");
  const githubToken = "ghp_" + "AbCdEfGhIjKlMnOpQrStUvWx0123456789";
  const npmToken = "npm_" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd";
  const bearerToken = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd";
  const secret = "Q7vN2xLp9rT4wK8mC3zB6aF1";
  const swappedSecret = "Q7vN2xLp9rT4wK8mC3zBOl123".replace("O", "0").replace("l", "1");
  const cases: Array<{ group: string; name: string; lines: string[]; words?: string[][]; shouldDetect: boolean; knownFalseNegative?: boolean }> = [
    { group: ".env", name: "OpenAI key assignment", lines: [`OPENAI_API_KEY=${openAiKey}`], shouldDetect: true },
    { group: ".env", name: "Stripe secret assignment", lines: [`STRIPE_SECRET_KEY=${stripeKey}`], shouldDetect: true },
    { group: ".env", name: "database URL password", lines: ["DATABASE_URL=postgres://dev:Passw0rd-Db-2026@localhost:5432/app"], shouldDetect: true },
    { group: ".env", name: "mail password", lines: ["SMTP_PASSWORD=Mail-Pass_77"], shouldDetect: true },
    { group: "JSON", name: "camelCase apiKey", lines: [`{ \"apiKey\": \"${openAiKey}\" }`], shouldDetect: true },
    { group: "JSON", name: "quoted password property", lines: ['{ "password": "P@ssword-json-77" }'], shouldDetect: true },
    { group: "JSON", name: "authorization bearer value", lines: [`{ \"Authorization\": \"Bearer ${bearerToken}\" }`], shouldDetect: true },
    { group: "JSON", name: "password nested after unrelated property", lines: [`{ \"mode\": \"dev\", \"password\": \"P@ssword-nested-77\" }`], shouldDetect: true },
    { group: "YAML", name: "GitHub token key", lines: [`github_token: ${githubToken}`], shouldDetect: true },
    { group: "YAML", name: "nested database password", lines: ["database:", "  password: yaml-Pass-77!"], shouldDetect: true },
    { group: "docker-compose", name: "environment key value", lines: [`environment: [\"API_TOKEN=${githubToken}\"]`], shouldDetect: true },
    { group: "docker-compose", name: "Postgres password", lines: ["POSTGRES_PASSWORD=Compose-Pass-771"], shouldDetect: true },
    { group: "shell history", name: "export token", lines: [`export ACCESS_TOKEN=${bearerToken}`], shouldDetect: true },
    { group: "shell history", name: "curl Authorization header", lines: [`curl -H 'Authorization: Bearer ${bearerToken}' https://api.example.test`], shouldDetect: true },
    { group: "curl -H", name: "X-API-Key header", lines: [`curl -H 'X-API-Key: ${openAiKey}' https://service.example.test`], shouldDetect: true },
    { group: "npm output", name: "npmrc authToken config", lines: [`//registry.npmjs.org/:_authToken=${npmToken}`], shouldDetect: true },
    { group: "npm output", name: "npm error echoes private token", lines: [`npm ERR! Invalid token ${npmToken}`], shouldDetect: true },
    { group: "pip output", name: "index URL embeds password", lines: ["Looking in indexes: https://builder:pip-Pass-771@packages.example.test/simple"], shouldDetect: true },
    { group: "pip output", name: "pip config password assignment", lines: ["global.password = 'Pip-Secret-771'"], shouldDetect: true },
    { group: "git output", name: "remote URL embeds access token", lines: [`remote: https://x-access-token:${githubToken}@github.com/org/repo.git`], shouldDetect: true },
    { group: "git log", name: "patch adds environment secret", lines: [`+AWS_SECRET_ACCESS_KEY=${secret}`], shouldDetect: true },
    { group: "TypeScript", name: "const apiKey literal", lines: [`const apiKey = '${openAiKey}';`], shouldDetect: true },
    { group: "TypeScript", name: "clientSecret camelCase", lines: [`const clientSecret = '${secret}';`], shouldDetect: true },
    { group: "TypeScript", name: "password property assignment", lines: [`const config = { password: 'TS-Pass-771' };`], shouldDetect: true },
    { group: "Python", name: "password assignment", lines: [`password = '${secret}'`], shouldDetect: true },
    { group: "Python", name: "uppercase key in dict", lines: [`settings = {\"API_KEY\": \"${openAiKey}\"}`], shouldDetect: true },
    { group: "Python", name: "Bearer header", lines: [`headers = {\"Authorization\": \"Bearer ${bearerToken}\"}`], shouldDetect: true },
    { group: "Go", name: "short declaration password", lines: [`password := \"Go-Pass-771!\"`], shouldDetect: true },
    { group: "Go", name: "API key literal", lines: [`apiKey := \"${openAiKey}\"`], shouldDetect: true },
    { group: "VS Code", name: "editor shows .env token", lines: [`GITHUB_TOKEN=${githubToken}`], shouldDetect: true },
    { group: "VS Code", name: "integrated terminal npm auth", lines: [`npm config set //registry.npmjs.org/:_authToken ${npmToken}`], shouldDetect: true },
    { group: "VS Code", name: "search result reveals email", lines: ["const owner = \"dev.team@example.com\";"], shouldDetect: true },
    { group: "OCR colon", name: "space after assignment colon", lines: [`OPENAI_API_KEY: ${openAiKey}`], shouldDetect: true },
    { group: "OCR equals", name: "space after equals", lines: [`DB_PASSWORD = ${secret}`], shouldDetect: true },
    { group: "OCR O/0", name: "O replaced with zero in assigned value", lines: [`API_TOKEN=${swappedSecret}`], shouldDetect: true },
    { group: "OCR l/1", name: "lowercase l replaced with one in assigned value", lines: [`CLIENT_SECRET=${swappedSecret}`], shouldDetect: true },
    { group: "OCR words", name: "API key split between OCR words", lines: [`OPENAI_API_KEY = ${openAiKey}`], words: [["OPENAI_API_KEY", "=", openAiKey.slice(0, 15), openAiKey.slice(15)]], shouldDetect: true },
    { group: "OCR words", name: "password split between OCR words", lines: ["DB_PASSWORD: Q7vN2xLp 9rT4wK8m C3zB6aF1"], words: [["DB_PASSWORD:", "Q7vN2xLp", "9rT4wK8m", "C3zB6aF1"]], shouldDetect: true },
    { group: "OCR wrap", name: "API key wraps after prefix", lines: [`OPENAI_API_KEY=${openAiKey.slice(0, 18)}`, openAiKey.slice(18)], shouldDetect: true, knownFalseNegative: true },
    { group: "OCR wrap", name: "email wraps across rendered lines", lines: ["contact=streamer@exa", "mple.invalid"], shouldDetect: true, knownFalseNegative: true },
    { group: ".env near miss", name: "ordinary node environment", lines: ["NODE_ENV=production"], shouldDetect: false },
    { group: ".env near miss", name: "token endpoint URL", lines: ["TOKEN_URL=https://id.example.test/oauth/token"], shouldDetect: false },
    { group: ".env near miss", name: "placeholder password", lines: ["DB_PASSWORD=change-me"], shouldDetect: false },
    { group: ".env near miss", name: "placeholder type string", lines: ["DB_PASSWORD=string"], shouldDetect: false },
    { group: "JSON near miss", name: "null password property", lines: ['{ "password": null }'], shouldDetect: false },
    { group: "JSON near miss", name: "password type declaration", lines: ['{ "password": "string" }'], shouldDetect: false },
    { group: "YAML near miss", name: "package version", lines: ["image: node:22.10.1"], shouldDetect: false },
    { group: "docker-compose near miss", name: "port mapping", lines: ["ports: [\"8080:80\"]"], shouldDetect: false },
    { group: "shell near miss", name: "curl content type header", lines: [`curl -H 'Content-Type: application/json' https://api.example.test`], shouldDetect: false },
    { group: "npm near miss", name: "install version output", lines: ["npm install @types/node@22.10.1"], shouldDetect: false },
    { group: "pip near miss", name: "pinned dependency output", lines: ["Successfully installed requests-2.31.0 urllib3-2.0.7"], shouldDetect: false },
    { group: "git log near miss", name: "commit hash and summary", lines: ["commit deadbeef0123456789abcdef0123456789abcdef", "Fix password form validation"], shouldDetect: false },
    { group: "git near miss", name: "SSH remote URL", lines: ["git@github.com:org/private-repo.git"], shouldDetect: false },
    { group: "TypeScript near miss", name: "password type annotation", lines: ["password: string;"], shouldDetect: false },
    { group: "Python near miss", name: "env lookup call", lines: ['password = os.getenv("DB_PASSWORD")'], shouldDetect: false },
    { group: "Go near miss", name: "package version string", lines: ["const version = \"v1.2.3\""], shouldDetect: false },
    { group: "VS Code near miss", name: "problems panel help text", lines: ["Password must be a string with at least 8 characters"], shouldDetect: false },
    { group: "VS Code near miss", name: "filename in explorer", lines: [".env.example   package.json   tsconfig.json"], shouldDetect: false },
    { group: "OCR near miss", name: "numbered version resembles email", lines: ["react@18.3.1"], shouldDetect: false },
    { group: "OCR near miss", name: "split shell variable placeholder", lines: ["DB_PASSWORD=${DB_ PASSWORD}"], shouldDetect: false },
  ];

  assert.ok(cases.length >= 40);
  const failures: string[] = [];
  const knownFalseNegatives: string[] = [];
  for (const item of cases) {
    const observations = item.lines.map((text, index) => line(text, item.words?.[index]));
    const leaks = [...detectApiKeys(observations), ...detectEmails(observations), ...detectPasswords(observations)];
    if (item.knownFalseNegative && leaks.length === 0) {
      knownFalseNegatives.push(`${item.group}: ${item.name}`);
      continue;
    }
    if ((leaks.length > 0) !== item.shouldDetect)
      failures.push(`${item.shouldDetect ? "FALSE NEGATIVE" : "FALSE POSITIVE"} [${item.group}] ${item.name}: ${item.lines.join(" / ")}`);
  }
  for (const item of knownFalseNegatives) console.log(`[detector corpus] KNOWN FALSE NEGATIVE: ${item}`);
  assert.deepEqual(knownFalseNegatives, ["OCR wrap: API key wraps after prefix", "OCR wrap: email wraps across rendered lines"]);
  assert.deepEqual(failures, []);
});
