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
  assert.deepEqual(detectSensitiveRegions([region, { x: 0, y: 0, w: 0, h: 12 }]), [
    { kind: "sensitive_region", box: region, preview: "sensitive region" },
  ]);
});

test("detectors avoid prose, code references, UUIDs, hashes and versions", () => {
  const nearMisses = [
    "const response = await client.get('/health')",
    "The API key is stored safely in the environment",
    "request_id=550e8400-e29b-41d4-a716-446655440000",
    "commit deadbeef0123456789abcdef0123456789abcdef",
    "version v1.2.3",
    "OPENAI_API_KEY: sk-test",
    "PASSWORD: process.env.PASSWORD",
    "PASSWORD: Please keep this value private",
  ].map((text) => line(text));
  assert.deepEqual(detectApiKeys(nearMisses), []);
  assert.deepEqual(detectEmails(nearMisses), []);
  assert.deepEqual(detectPasswords(nearMisses), []);
});
