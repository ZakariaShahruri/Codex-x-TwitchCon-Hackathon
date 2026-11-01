import { readFile } from "node:fs/promises";
import OBSWebSocket from "obs-websocket-js";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../src/shared/config.js";
import { AppleVisionOCR } from "../src/shield/ocr/index.js";

const SAMPLE_COUNT = Number.parseInt(process.env.OCR_BENCH_SAMPLES ?? "30", 10);
const WARMUP_COUNT = 3;
const EXPECTED_VALUES = [
  "sk-proj-twitchy-fake-0123456789abcdef0123456789",
  "oauth:fake-twitch-token-abcdef0123456789",
  "FAKE_AWS_SECRET_0123456789abcdef",
  "FakePassword123",
];

if (!Number.isInteger(SAMPLE_COUNT) || SAMPLE_COUNT < 5 || SAMPLE_COUNT > 500) {
  throw new Error("OCR_BENCH_SAMPLES must be an integer from 5 to 500");
}

function percentile(samples: number[], p: number): number {
  const ordered = [...samples].sort((a, b) => a - b);
  if (ordered.length === 0) return Number.NaN;
  if (p === 0.5 && ordered.length % 2 === 0) return (ordered[ordered.length / 2 - 1] + ordered[ordered.length / 2]) / 2;
  const index = Math.max(0, Math.ceil(p * ordered.length) - 1);
  return ordered[index];
}

function milliseconds(value: number): string { return Number.isFinite(value) ? `${value.toFixed(1)} ms` : "n/a"; }

interface OCRBenchmark {
  level: "fast" | "accurate";
  timings: number[];
  lastText: string;
  readPerSample: number[];
}

async function benchmarkOCR(png: Buffer, level: "fast" | "accurate"): Promise<OCRBenchmark> {
  const client = new AppleVisionOCR({ level, timeoutMs: 10_000 });
  const timings: number[] = [];
  const readPerSample = EXPECTED_VALUES.map(() => 0);
  let lastText = "";
  try {
    for (let i = 0; i < WARMUP_COUNT; i += 1) {
      const frame = Buffer.from(png);
      await Promise.all([client.recognize(frame), client.barcodes(frame)]);
    }
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const frame = Buffer.from(png);
      const started = performance.now();
      const [lines] = await Promise.all([client.recognize(frame), client.barcodes(frame)]);
      timings.push(performance.now() - started);
      lastText = lines.map((line) => line.text).join("\n");
      const normalized = lastText.toLowerCase().replace(/\s+/g, "");
      EXPECTED_VALUES.forEach((value, index) => {
        if (normalized.includes(value.toLowerCase())) readPerSample[index] += 1;
      });
    }
  } finally {
    await client.close();
  }
  return { level, timings, lastText, readPerSample };
}

async function benchmarkScreenshots(config: Awaited<ReturnType<typeof loadConfig>>): Promise<{ timings: number[]; note: string }> {
  const url = config.env.OBS_WS_URL ?? "ws://127.0.0.1:4455";
  const obs = new OBSWebSocket();
  const timings: number[] = [];
  try {
    await obs.connect(url, config.env.OBS_WS_PASSWORD);
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const started = performance.now();
      const screenshot = await obs.call("GetSourceScreenshot", {
        sourceName: "Twitchy Content",
        imageFormat: "png",
        imageCompressionQuality: -1,
      });
      if (!screenshot.imageData.startsWith("data:image/png;base64,"))
        throw new Error("OBS returned a screenshot in an unexpected format");
      timings.push(performance.now() - started);
    }
    return { timings, note: `${timings.length} source screenshots from OBS Twitchy Content (${url})` };
  } catch (error) {
    return { timings, note: `not reachable or source unavailable: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (obs.identified) await obs.disconnect();
  }
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const fixturePath = "tools/ocr-vision/fixtures/fake-env-1080p.png";
  let fixture: Buffer;
  try { fixture = await readFile(fixturePath); }
  catch { throw new Error(`Missing ${fixturePath}; regenerate it with npm run fixture:ocr`); }

  const screenshots = await benchmarkScreenshots(config);
  const fast = await benchmarkOCR(fixture, "fast");
  const accurate = await benchmarkOCR(fixture, "accurate");
  const budgetMs = config.delayMs - config.safetyMarginMs;
  const fastReadsAll = fast.readPerSample.every((count) => count === SAMPLE_COUNT);
  const accurateReadsAll = accurate.readPerSample.every((count) => count === SAMPLE_COUNT);
  const fastWithinTarget = percentile(fast.timings, 0.95) < 200;
  const chosen = fastReadsAll && fastWithinTarget ? fast : accurateReadsAll ? accurate : fastReadsAll ? fast : accurate;

  console.log(`OCR benchmark: ${new Date().toISOString()} · ${SAMPLE_COUNT} measured samples, ${WARMUP_COUNT} warmups, fixture ${fixturePath} (${fixture.byteLength} bytes)`);
  console.log("| Operation | Samples | p50 | p95 |");
  console.log("|---|---:|---:|---:|");
  console.log(`| OBS screenshot · Twitchy Content | ${screenshots.timings.length || "—"} | ${milliseconds(percentile(screenshots.timings, 0.50))} | ${milliseconds(percentile(screenshots.timings, 0.95))} |`);
  console.log(`| Apple Vision OCR · fast | ${fast.timings.length} | ${milliseconds(percentile(fast.timings, 0.50))} | ${milliseconds(percentile(fast.timings, 0.95))} |`);
  console.log(`| Apple Vision OCR · accurate | ${accurate.timings.length} | ${milliseconds(percentile(accurate.timings, 0.50))} | ${milliseconds(percentile(accurate.timings, 0.95))} |`);
  if (!screenshots.timings.length) console.log(`OBS note: ${screenshots.note}`);
  console.log(`Fast recognition values: ${EXPECTED_VALUES.map((value, index) => `${value} (${fast.readPerSample[index]}/${SAMPLE_COUNT})`).join("; ")}`);
  console.log(`Fast reads every fake key every sample: ${fastReadsAll ? "yes" : "no"}`);
  console.log(`Accurate reads every fake key every sample: ${accurateReadsAll ? "yes" : "no"}`);
  console.log(`Chosen recognition level: ${chosen.level}${chosen === fast && !fastWithinTarget ? " (keys read reliably, but OCR p95 misses the 200 ms target)" : ""}`);
  console.log(`§1 component targets: screenshot p95 <50 ms ${screenshots.timings.length ? (percentile(screenshots.timings, 0.95) < 50 ? "PASS" : "MISS") : "UNMEASURED"}; chosen OCR p95 <200 ms ${percentile(chosen.timings, 0.95) < 200 ? "PASS" : "MISS"}.`);
  if (screenshots.timings.length) {
    const estimatedWorstFrame = config.captureIntervalMs + percentile(screenshots.timings, 0.95) +
      percentile(chosen.timings, 0.95) + 10 + 20;
    console.log(`§1 estimated frame subtotal (capture interval + screenshot p95 + chosen OCR p95 + §1 detector/place targets 10+20 ms): ${estimatedWorstFrame.toFixed(1)} ms vs ${budgetMs} ms available (${estimatedWorstFrame < budgetMs ? "inside" : "outside"}).`);
  } else {
    console.log(`§1 total budget cannot be verified without OBS; OCR plus capture interval and detector/place targets = ${(config.captureIntervalMs + percentile(chosen.timings, 0.95) + 30).toFixed(1)} ms of ${budgetMs} ms, before screenshot latency.`);
  }
  console.log("Recognized fixture lines (synthetic values only):");
  console.log(chosen.lastText);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
