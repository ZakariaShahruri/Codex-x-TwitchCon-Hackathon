import assert from "node:assert/strict";
import test from "node:test";
import type { Box } from "../../shared/events.js";
import type { OCRTextLine } from "../ocr/types.js";
import { detectApiKeys, detectCards, detectEmails, detectIps, detectPasswords, detectPhones, detectQrCodes, detectSeedPhrases, detectSensitiveRegions, detectWatchlist } from "./index.js";
import { absorbedBySeedPhrases, isValidMnemonic } from "./seed-phrase.js";

function line(text: string, words: string[] = text.split(/\s+/u), y = 20): OCRTextLine {
  let x = 0;
  const wordBoxes = words.map((word) => {
    const box: Box = { x, y, w: word.length * 10, h: 12 };
    x += box.w + 2;
    return { text: word, box };
  });
  return { text, box: { x: 0, y, w: x, h: 12 }, words: wordBoxes };
}

/** Every text detector, so near-miss lists also guard the Tier 2 ones against false alarms. */
const detectAllText = (lines: OCRTextLine[]) =>
  [...detectApiKeys(lines), ...detectEmails(lines), ...detectPasswords(lines), ...detectPhones(lines), ...detectCards(lines),
    ...detectIps(lines), ...detectSeedPhrases(lines)];

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

function fragment(text: string, x: number, y: number, h = 24): OCRTextLine {
  const box: Box = { x, y, w: Math.round(text.length * h * 0.6), h };
  return { text, box, words: [{ text, box }] };
}

test("live Leak Gauntlet OCR damage still detects the secret", () => {
  // Exact Vision readings from the first live Gauntlet run: `l`/`I` read as `|` in a proportional font,
  // and `3` read as Cyrillic `З`.
  const jwt = `${"eyJ"}hbGciOiJlUz|1NiJ9.eyJzdWliOiJnYXVudGxldCJ9.AExpEN2Xuy7_P67|t8SPMEVTcanN3fnpyuFFLpMOTWu`;
  assert.equal(detectApiKeys([line(jwt)]).length, 1);
  assert.equal(detectApiKeys([line(jwt)])[0]?.fingerprint, detectApiKeys([line(jwt.replace(/\|/g, "l"))])[0]?.fingerprint);
  assert.equal(detectApiKeys([line(`$ ${"ghu_"}wЗI6xmI80s0aCzTtDly4dc0MGKCnQyxBQNCv`)]).length, 1);
  assert.equal(detectApiKeys([line(`${"Alza"}8fxNcUbm0QA0fRbcID8ktd314JvUPMRhJlo`)]).length, 1);
  assert.equal(detectApiKeys([line(`${"rk_"}test_wqdNPi×3UGyT50uuxn6SanN0u9GFdia68L5f`)]).length, 1);
  assert.equal(detectApiKeys([line("SERVICE_T0KEN=Gm1gGc66ExD8q0qvcYQ1P9QS1zcC7fuDsPRc")]).length, 1);
  assert.equal(detectPasswords([line("PASSW0RD=Gauntlet-kFep9R6kCz")]).length, 1);
  // Small text: the underscore after a prefix vanishes, and `1` reads as `]` mid-token.
  assert.equal(detectApiKeys([line(`$ ${"hf"} aHmy7Jb6JU55B9s7ZpYQUxHLbs3cd3oyFhtb`)]).length, 1);
  assert.equal(detectApiKeys([line(`${"ghu"} w3I6xml80s0aCzTtDly4dcOMGKCnQyxBQNCv`)]).length, 1);
  assert.equal(detectApiKeys([line(`${"sk"} live 51HxYzAbCdEfGhIjKlMnOpQrSt`)]).length, 1);
  assert.equal(detectApiKeys([line("SERVICE_TOKEN=Gm1gGc66ExD8qoqvcYQ]P9QS1zcC7fuDsPRc")]).length, 1);
  assert.equal(detectApiKeys([line("const first = items[0] ?? fallback")]).length, 0);
  assert.equal(detectApiKeys([line(`${"ghp"}_GvugN™MWJZ8LPOwvYLyYZJChCiCvEyW14xо0`)]).length, 1, "`M` read as `™`");
  assert.equal(detectApiKeys([line("café résumé naïve façade über straße")]).length, 0);
});

test("same-row OCR fragments join, other rows and distant columns do not", () => {
  // Vision returned `password:` and its value as two lines on one row.
  const label = fragment("password:", 120, 383);
  const value = fragment("Gauntlet-XiMCDn2Jxx", label.box.x + label.box.w + 14, 385);
  const [hit] = detectPasswords([value, label]);
  assert.ok(hit);
  assert.deepEqual(hit.box, value.box);

  assert.equal(detectPasswords([label, fragment("Gauntlet-XiMCDn2Jxx", 120, 430)]).length, 0, "next row");
  assert.equal(detectPasswords([label, fragment("Gauntlet-XiMCDn2Jxx", label.box.x + label.box.w + 400, 383)]).length, 0, "far column");
  assert.equal(detectPasswords([label, fragment("Gauntlet-XiMCDn2Jxx", label.box.x + label.box.w + 14, 383, 60)]).length, 0, "different size");
});

test("a URL credential is a password, not an email address", () => {
  for (const text of ["DATABASE_URL=postgres://demo:Gauntlet-vGH3rqgn3N@db.invalid/app", "postgres://demo: Gauntlet-vGH3rqgn3N@db.invalid/app"]) {
    assert.equal(detectEmails([line(text)]).length, 0, text);
    assert.equal(detectPasswords([line(text)]).length, 1, text);
  }
  assert.equal(detectEmails([line("mailto: demo.person@example.invalid")]).length, 1);
});

test("watchlist matches whole short words and OCR-normalized multiword values", () => {
  const short = { id: "short", label: "robot", value: "R2D2" };
  const exactWord = line("message: R2-D2 arrived", ["message:", "R2-D2", "arrived"]);
  const [shortHit] = detectWatchlist([exactWord], [short]);
  assert.ok(shortHit);
  assert.equal(shortHit.preview, "watchlist: robot");
  assert.equal(shortHit.preview.includes(short.value), false);
  assertOnlyMatchedWord(shortHit, exactWord.words[1]!);
  assert.equal(detectWatchlist([line("R2D2X")], [short]).length, 0, "short values require an exact whole word");
  assert.equal(detectWatchlist([line("R2D2")], [{ id: "tiny", label: "unit", value: "R2D" }]).length, 0);

  const person = { id: "person", label: "family member", value: "Jane Doe" };
  const ocrVariant = line("DM: Jäne D0e joined", ["DM:", "Jäne", "D0e", "joined"]);
  const [personHit] = detectWatchlist([ocrVariant], [person]);
  assert.ok(personHit);
  assert.deepEqual(personHit.box, {
    x: ocrVariant.words[1]!.box.x, y: 20,
    w: ocrVariant.words[1]!.box.w + 2 + ocrVariant.words[2]!.box.w, h: 12,
  });
  assert.equal(personHit.fingerprint, detectWatchlist([line("Jane Doe")], [person])[0]?.fingerprint);
});

test("watchlist handles a scaled typo tolerance and same-row OCR fragments without masking neighbors", () => {
  const address = { id: "address", label: "home address", value: "742 Evergreen Terrace Apartment 5B" };
  const first = fragment("742 Evergreem", 120, 383);
  const second = fragment("Terrace Apartment 5B", first.box.x + first.box.w + 14, 385);
  const note = fragment("meeting tomorrow", second.box.x + second.box.w + 14, 383);
  const [hit] = detectWatchlist([note, second, first], [address]);
  assert.ok(hit);
  assert.equal(hit.kind, "watchlist");
  assert.equal(hit.preview, "watchlist: home address");
  assert.equal(hit.box.x, first.box.x);
  assert.equal(hit.box.x + hit.box.w, second.box.x + second.box.w);
  assert.ok(hit.box.x + hit.box.w < note.box.x);

  const exact = { id: "street", label: "home", value: "742 Evergreen Terrace" };
  const label = fragment("742 Evergreen", 120, 483);
  const value = fragment("Terrace", label.box.x + label.box.w + 14, 485);
  assert.equal(detectWatchlist([value, label], [exact]).length, 1, "same-row fragments join into one OCR line");
  assert.equal(detectWatchlist([label, fragment("Terrace", 120, 530)], [exact]).length, 0, "separate rows do not join");
});

test("watchlist near-miss names do not fuzzy-match short or ordinary similar names", () => {
  const entries = [
    { id: "person", label: "family", value: "Jane Doe" },
    { id: "address", label: "home", value: "742 Evergreen Terrace" },
    { id: "name", label: "contact", value: "Alexandra Montgomery" },
  ];
  const nearMisses = ["Jane Dole", "Jane Do", "742 Evergreen Terraceway", "Alexandria Montgomery", "Alexandra Monastery"];
  for (const text of nearMisses) assert.deepEqual(detectWatchlist([line(text)], entries), [], text);
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
    // Real JWTs are lowercase-heavy base64url; a bare one in a log line has no label to lean on.
    `session restored from ${"eyJ"}hbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`,
  ];
  for (const text of secrets) {
    const lines = [line(text)];
    assert.notEqual([...detectApiKeys(lines), ...detectEmails(lines), ...detectPasswords(lines)].length, 0, text);
  }
});

test("detectors avoid prose, code references, versions and placeholders", () => {
  const nearMisses = [
    "KEY=$(VAR}",
    "DB_PASSWORD=$(cat /run/secrets/db)",
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
    assert.deepEqual(detectAllText(lines), [], text);
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
    const leaks = detectAllText(observations);
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

test("phone detector catches real formats and boxes only the number", () => {
  const hits = [
    "+44 20 7946 0958",
    "+1 (555) 010-4477",
    "Call me at (555) 010-4477 tonight",
    "555-010-4477",
    "555.010.4477",
    "+33 6 12 34 56 78",
    "Mobile: 06 12 34 56 78",
    "tel=0612345678",
    "WhatsApp: +49 151 23456789",
    "my number is +1 555 010 4477 or 2026",
    "PHONE_NUMBER=+61 2 5550 1234",
  ];
  for (const text of hits) assert.equal(detectPhones([line(text)]).length, 1, text);

  const observation = line("call +44 20 7946 0958 now");
  const [hit] = detectPhones([observation]);
  assert.ok(hit);
  assert.equal(hit.preview, "phone number");
  assert.deepEqual(hit.box, { x: observation.words[1]!.box.x, y: 20, w: observation.words[4]!.box.x + observation.words[4]!.box.w - observation.words[1]!.box.x, h: 12 });
  assert.equal(detectPhones([line("+1 (555) 010-4477")])[0]?.fingerprint, detectPhones([line("+1 555 010 4477")])[0]?.fingerprint);
});

test("phone detector ignores dates, times, versions, IPs, IDs and durations", () => {
  const nearMisses = [
    "2026-11-02 13:45:07",
    "12:30:45.123",
    "192.168.100.200",
    "10.0.0.1:5432",
    "v18.3.1",
    "Order #555-010-4477",
    "ticket INC-555-010-4477",
    "duration 00:12:34",
    "1730532000000",
    "request_id=550e8400-e29b-41d4-a716-446655440000",
    "555-0100",
    "ISBN 978-3-16-148410-0",
    "11/02/2026",
    "+15 XP",
    "v555.010.4477",
    "555-010-4477-2",
    "Build 2024.11.02.1234",
  ];
  for (const text of nearMisses) assert.deepEqual(detectPhones([line(text)]), [], text);
});

test("card detector needs an issuer prefix, a valid length and a Luhn check", () => {
  const hits = [
    "4242 4242 4242 4242",
    "4242424242424242",
    "5555-5555-5555-4444",
    "3782 822463 10005",
    "6011 1111 1111 1117",
    "card: 4000056655665556",
    "4242 4242 4242 4242 12/28 123",
    "4242 4242 4242 4242 12",
    "2223 0031 2200 3222",
  ];
  for (const text of hits) assert.equal(detectCards([line(text)]).length, 1, text);
  const [hit] = detectCards([line("Visa 4242 4242 4242 4242 exp 12/28")]);
  assert.equal(hit?.preview, "credit card");

  const nearMisses = [
    "4242 4242 4242 4241",
    "1234 5678 9012 3456",
    "9999 9999 9999 9995",
    "1730532000000",
    "0000 0000 0000 0000",
    "4111-1111 1111-1111",
    "3.14159265358979323",
    "+44 20 7946 0958",
    "GB82 WEST 1234 5698 7654 32",
    "4444 4444 4444 4444",
    "order 4417229011853006",
  ];
  for (const text of nearMisses) assert.deepEqual(detectCards([line(text)]), [], text);
});

test("QR detector masks the whole code with a margin and ignores other barcodes", () => {
  const qr = { payload: "otpauth://totp/Twitch:demo?secret=FAKE", symbology: "VNBarcodeSymbology(_rawValue: VNBarcodeSymbologyQR)", box: { x: 100, y: 100, w: 200, h: 200 } };
  const [hit] = detectQrCodes([qr, { payload: "4006381333931", symbology: "VNBarcodeSymbologyEAN13", box: { x: 0, y: 0, w: 90, h: 40 } }]);
  assert.ok(hit);
  assert.equal(detectQrCodes([qr]).length, 1);
  assert.equal(hit.kind, "qr_code");
  assert.equal(hit.preview, "QR code");
  assert.deepEqual(hit.box, { x: 84, y: 84, w: 232, h: 232 });
  assert.equal(hit.fingerprint, detectQrCodes([{ ...qr, box: { x: 500, y: 50, w: 200, h: 200 } }])[0]?.fingerprint, "same payload, same leak");
  assert.notEqual(hit.fingerprint, detectQrCodes([{ ...qr, payload: "https://example.invalid/other" }])[0]?.fingerprint);
});

test("IP detector masks public IPv4 and IPv6 addresses and boxes only the address", () => {
  for (const [text, address] of [
    ["Your IP address is 203.0.113.42", "203.0.113.42"],
    ["ssh root@198.51.100.7", "root@198.51.100.7"],
    ["listening on 81.2.69.160:8080", "81.2.69.160:8080"],
    ["IPv4:185.199.108.153", "IPv4:185.199.108.153"],
    ["Public IPv6 2a02:6b8:b010:9020:1::2", "2a02:6b8:b010:9020:1::2"],
    ["server 2001:db8:85a3::8a2e:370:7334.", "2001:db8:85a3::8a2e:370:7334."],
  ]) {
    const observation = line(text);
    const candidates = detectIps([observation]);
    assert.equal(candidates.length, 1, text);
    assert.equal(candidates[0]!.kind, "ip");
    assert.equal(candidates[0]!.preview.includes(address), false);
    assertOnlyMatchedWord(candidates[0]!, observation.words.find((word) => word.text === address)!);
  }
});

test("IP detector ignores private, local and well-known addresses, versions, OIDs and times", () => {
  for (const text of [
    "connected to 192.168.100.200:5432",
    "10.0.0.12 gateway",
    "172.20.4.1",
    "localhost 127.0.0.1",
    "link-local 169.254.12.4",
    "CGNAT 100.72.3.9",
    "netmask 255.255.255.0",
    "bind 0.0.0.0:3000",
    "dns 8.8.8.8 and 1.1.1.1",
    "version 1.2.0.4",
    "build 2.0.1.7",
    "v1.4.0.2",
    "Chrome 120.0.6099.129",
    "oid 1.3.6.1.4.1",
    "02.11.20.26",
    "loopback ::1",
    "fe80::1ff:fe23:4567:890a",
    "fd00::1",
    "13:45:07 INFO stream started",
    "mac 00:1a:2b:3c:4d:5e",
    "std::vector<int>",
    "beef::cafe",
  ]) assert.deepEqual(detectIps([line(text)]), [], text);
});

const VALID_12 = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const VALID_12_B = "letter advice cage absurd amount doctor acoustic avoid letter advice cage above";
const VALID_24 = `${"zoo ".repeat(23)}vote`;

test("BIP39 checksum accepts the official test vectors and rejects word swaps", () => {
  for (const phrase of [VALID_12, VALID_12_B, VALID_24, `${"abandon ".repeat(11)}about`]) assert.equal(isValidMnemonic(phrase.split(" ")), true, phrase);
  assert.equal(isValidMnemonic("abandon ".repeat(12).trim().split(" ")), false);
  assert.equal(isValidMnemonic(VALID_12.split(" ").reverse()), false);
  assert.equal(isValidMnemonic(VALID_12.split(" ").slice(0, 11)), false);
});

test("seed phrase detector masks a phrase on one line, in a file and across rows", () => {
  const single = detectSeedPhrases([line(VALID_12)]);
  assert.equal(single.length, 1);
  assert.equal(single[0]!.kind, "seed_phrase");
  assert.equal(single[0]!.preview.includes("legal"), false);

  const env = line(`MNEMONIC="${VALID_12_B}"`);
  assert.equal(detectSeedPhrases([env]).length, 1);

  const words = VALID_24.split(" ");
  const rows = [0, 1, 2, 3].map((row) => line(words.slice(row * 6, row * 6 + 6).join(" "), undefined, 20 + row * 40));
  const [grid] = detectSeedPhrases(rows);
  assert.ok(grid);
  assert.deepEqual([grid.box.y, grid.box.y + grid.box.h], [20, 152]);
});

test("seed phrase detector reads numbered wallet grids in number order and tolerates one unreadable cell", () => {
  const words = VALID_12_B.split(" ");
  // Three columns read row by row, so reading order is 1 5 9 2 6 10 …; the numbers restore the real order.
  const rows = [0, 1, 2, 3].map((row) => {
    const cells = [row + 1, row + 5, row + 9].flatMap((number) => [`${number}.`, words[number - 1]!]);
    return line(cells.join(" "), cells, 20 + row * 40);
  });
  const [grid] = detectSeedPhrases(rows);
  assert.ok(grid);
  assert.equal(grid.fingerprint, detectSeedPhrases([line(VALID_12_B)])[0]!.fingerprint);

  rows[0] = line("1. 5. ###### 9. cage", ["1.", "letter", "5.", "######", "9.", "cage"], 20);
  assert.equal(detectSeedPhrases(rows).length, 1, "one unreadable cell");
  rows[1] = line("2. ??? 6. ??? 10. advice", ["2.", "???", "6.", "???", "10.", "advice"], 60);
  assert.equal(detectSeedPhrases(rows).length, 0, "three unreadable cells");
});

test("seed phrase detector labels lower the bar; unlabeled word lists need the checksum", () => {
  // A grocery list of 12 wordlist words that fails the checksum.
  const ordinary = "apple banana cherry orange lemon grape mango olive onion garlic pepper tomato";
  assert.equal(isValidMnemonic(ordinary.split(" ")), false);
  assert.deepEqual(detectSeedPhrases([line(ordinary)]), []);
  assert.equal(detectSeedPhrases([line("Secret Recovery Phrase", undefined, 0), line(ordinary, undefined, 40)]).length, 1);
});

test("seed phrase detector ignores prose and numbered instructions made of common words", () => {
  for (const lines of [
    [line("We want to build a better world for every family and their friends, so join us today")],
    [line("you can also use the zoo map to find the lion, the tiger and the zebra near the gate")],
    ...[[
      "1. Open the app", "2. Enter your email", "3. Wait for the code", "4. Copy the code", "5. Paste it here", "6. Accept the terms",
      "7. Choose a name", "8. Pick a theme", "9. Allow access", "10. Enable alerts", "11. Invite a friend", "12. Enjoy the show",
    ].map((text, index) => line(text, undefined, 20 + index * 30))],
  ]) assert.deepEqual(detectSeedPhrases(lines), [], lines.map((l) => l.text).join(" / "));
});

test("a seed phrase is one leak even when its label also reads as a secret", () => {
  const lines = [line(`Secret Recovery Phrase: ${VALID_12}`)];
  const all = [...detectApiKeys(lines), ...detectPasswords(lines), ...detectSeedPhrases(lines)];
  assert.deepEqual(absorbedBySeedPhrases(all).map((leak) => leak.kind), ["seed_phrase"]);
  const email = detectEmails([line("streamer@example.invalid")]);
  assert.deepEqual(absorbedBySeedPhrases([...email, ...detectSeedPhrases([line(VALID_12, undefined, 200)])]).map((leak) => leak.kind), ["email", "seed_phrase"]);
});
