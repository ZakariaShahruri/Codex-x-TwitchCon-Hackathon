import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { detectApiKeys, detectEmails, detectPasswords } from "../detectors/index.js";
import { AppleVisionOCR } from "./apple-vision.js";

interface Fixture {
  width: number;
  height: number;
  fontSize: number;
  theme: string;
  font: string;
  secrets: Array<{ kind: string; line: number; box: { x: number; y: number; w: number; h: number } }>;
}

const directory = new URL("../../../tools/ocr-vision/fixtures/full-resolution/", import.meta.url);
const executable = `${process.cwd()}/tools/ocr-vision/.build/twitchy-ocr`;
const fixtureNames = existsSync(directory)
  ? readdirSync(directory).filter((name) => name.endsWith(".json")).sort()
  : [];
const supported = process.platform === "darwin" && existsSync(executable) && fixtureNames.length > 0;

test("full-resolution OCR matrix reports recall, latency and secret glyph box coverage", { skip: !supported }, async () => {
  const ocr = new AppleVisionOCR({ level: "accurate", timeoutMs: 10_000 });
  const summaries: string[] = [];
  const boxMisses: string[] = [];
  try {
    for (const metadataName of fixtureNames) {
      const base = metadataName.slice(0, -5);
      const fixture = JSON.parse(readFileSync(new URL(metadataName, directory), "utf8")) as Fixture;
      const png = readFileSync(new URL(`${base}.png`, directory));
      const started = performance.now();
      const lines = await ocr.recognize(png);
      const latencyMs = performance.now() - started;
      const detected = [...detectApiKeys(lines), ...detectEmails(lines), ...detectPasswords(lines)];
      let found = 0;
      let covered = 0;
      let coveredWithMaskPadding = 0;
      for (const secret of fixture.secrets) {
        const box = detected.find((candidate) => Math.abs(candidate.box.y + candidate.box.h / 2 - (secret.box.y + secret.box.h / 2)) < fixture.fontSize * 2)?.box;
        if (!box) continue;
        found += 1;
        if (box.x <= secret.box.x && box.y <= secret.box.y &&
            box.x + box.w >= secret.box.x + secret.box.w && box.y + box.h >= secret.box.y + secret.box.h) covered += 1;
        else boxMisses.push(`${base} ${secret.kind}: detector ${JSON.stringify(box)} vs glyphs ${JSON.stringify(secret.box)}`);
        const padding = 4;
        if (box.x - padding <= secret.box.x && box.y - padding <= secret.box.y &&
            box.x + box.w + padding >= secret.box.x + secret.box.w &&
            box.y + box.h + padding >= secret.box.y + secret.box.h) coveredWithMaskPadding += 1;
      }
      summaries.push(`${base}: recall ${found}/${fixture.secrets.length}, OCR ${latencyMs.toFixed(1)}ms, detector boxes ${covered}/${found}, +4px mask padding ${coveredWithMaskPadding}/${found}`);
    }
  } finally {
    await ocr.close();
  }
  for (const summary of summaries) console.log(`[full-resolution OCR] ${summary}`);
  for (const miss of boxMisses) console.log(`[full-resolution OCR] BOX COVERAGE MISS: ${miss}`);
  assert.equal(fixtureNames.length, 20, "expected 5 font sizes × 2 themes × 2 monospace fonts");
});
