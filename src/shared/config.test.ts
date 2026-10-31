import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

test("loads committed defaults and tolerates missing optional secrets", async () => {
  const config = await loadConfig();
  assert.equal(config.delayMs, 1000);
  assert.equal(config.captureIntervalMs, 150);
  assert.equal(config.env.OPENAI_API_KEY, undefined);
});

test("rejects invalid values with a readable key-specific message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "twitchy-config-"));
  try {
    const valid = JSON.parse(await readFile("twitchy.config.json", "utf8")) as Record<string, unknown>;
    valid.webPort = 70000;
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(valid));
    await assert.rejects(loadConfig({ configPath, envPath: join(dir, "missing.env") }), /Invalid config "webPort": must be an integer from 1 to 65535/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
