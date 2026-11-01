import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { AppleVisionOCR } from "./apple-vision.js";
import type { LeakKind } from "../../shared/events.js";
import { CaptureLoop } from "../capture-loop.js";

const fixturePath = new URL("../../../tools/ocr-vision/fixtures/screen.png", import.meta.url);
const executablePath = `${process.cwd()}/tools/ocr-vision/.build/twitchy-ocr`;
const supported = process.platform === "darwin" && existsSync(executablePath) && existsSync(fixturePath);

test("Apple Vision finds fixture words with boxes in the expected canvas regions", { skip: !supported }, async () => {
  const png = readFileSync(fixturePath);
  const ocr = new AppleVisionOCR({ timeoutMs: 5_000 });
  try {
    const [lines, barcodes] = await Promise.all([ocr.recognize(png), ocr.barcodes(png)]);
    assert.ok(lines.some((line) => line.text.includes("streamer@example.com")));

    const words = lines.flatMap((line) => line.words);
    const email = words.find((word) => word.text === "streamer@example.com");
    assert.ok(email, "recognized email word should include a word-level box");
    assert.ok(email.box.x >= 270 && email.box.x <= 330, `email x=${email.box.x} should be near the fixture's second token`);
    assert.ok(email.box.y >= 55 && email.box.y <= 105, `email y=${email.box.y} should be on the first fixture line`);
    assert.ok(email.box.w >= 550 && email.box.w <= 720, `email width=${email.box.w} should cover the address`);

    const secret = words.find((word) => word.text.includes("sk-demo-secret-123"));
    assert.ok(secret, "recognized fake API key should have a word-level box");
    assert.ok(secret.box.x >= 175 && secret.box.x <= 225, `secret x=${secret.box.x} should follow the API_KEY label`);
    assert.ok(secret.box.y >= 155 && secret.box.y <= 205, `secret y=${secret.box.y} should be on the second fixture line`);
    assert.ok(secret.box.w >= 600 && secret.box.w <= 780, `secret width=${secret.box.w} should cover the whole key token`);
    assert.deepEqual(barcodes, []);
  } finally {
    await ocr.close();
  }
});

const engineFixtures = ["fake-env-1080p.png", "fake-env-1080p-12px.png"];

for (const name of engineFixtures) {
  const fixture = new URL(`../../../tools/ocr-vision/fixtures/${name}`, import.meta.url);
  const engineSupported = process.platform === "darwin" && existsSync(executablePath) && existsSync(fixture);

  test(`accurate engine OCR detects every leak in ${name}`, { skip: !engineSupported }, async () => {
    const png = readFileSync(fixture);
    const ocr = new AppleVisionOCR({ level: "accurate", timeoutMs: 10_000 });
    const frames: Array<{ leaks: Array<{ kind: LeakKind; box: { x: number; y: number; w: number; h: number } }> }> = [];
    const loop = new CaptureLoop({
      capture: async () => png,
      ocr,
      intervalMs: 150,
      enabledDetectors: ["api_key", "email", "password", "sensitive_region"],
      sensitiveRegions: [],
      onFrame: (frame) => { frames.push(frame); },
    });
    try {
      await loop.tick();
    } finally {
      await loop.stop();
      await ocr.close();
    }
    assert.equal(frames.length, 1);
    const leaks = frames[0]!.leaks;
    assert.deepEqual(leaks.map((leak) => leak.kind).sort(), ["api_key", "api_key", "api_key", "email", "password"]);
    assert.ok(leaks.every(({ box }) => box.w > 0 && box.h > 0 && box.x >= 0 && box.y >= 0 && box.x + box.w <= 1920 && box.y + box.h <= 1080));
  });
}
