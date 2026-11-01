import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppleVisionOCR } from "./apple-vision.js";

async function mockHelper(script: string): Promise<{ directory: string; executable: string }> {
  const directory = await mkdtemp(join(tmpdir(), "twitchy-ocr-process-"));
  const executable = join(directory, "mock-ocr");
  await writeFile(executable, `#!/usr/bin/env node\n${script}\n`);
  await chmod(executable, 0o755);
  return { directory, executable };
}

const successResponse = JSON.stringify({ ok: true, width: 10, height: 10, text: [], barcodes: [], error: null });

test("restarts the helper after a crash and retries the frame once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "twitchy-ocr-restart-"));
  const marker = join(directory, "crashed-once");
  const helper = await mockHelper(`
const fs = require('node:fs');
const marker = ${JSON.stringify(marker)};
let data = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  data = Buffer.concat([data, chunk]);
  if (data.length >= 4 && data.length >= data.readUInt32BE(0) + 4) {
    if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'yes'); process.exit(9); }
    process.stdout.write(${JSON.stringify(successResponse)} + '\\n');
    data = Buffer.alloc(0);
  }
});
`);
  const ocr = new AppleVisionOCR({ executablePath: helper.executable, timeoutMs: 2_000 });
  try {
    assert.deepEqual(await ocr.recognize(new Uint8Array([1, 2, 3])), []);
  } finally {
    await ocr.close();
    await rm(helper.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("kills a hung helper and reports a frame-specific timeout", async () => {
  const helper = await mockHelper("process.stdin.resume();");
  const ocr = new AppleVisionOCR({ executablePath: helper.executable, timeoutMs: 40 });
  try {
    await assert.rejects(ocr.recognize(new Uint8Array([1])), /timed out after 40 ms/);
  } finally {
    await ocr.close();
    await rm(helper.directory, { recursive: true, force: true });
  }
});
