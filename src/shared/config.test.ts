import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

test("loads committed defaults and tolerates missing optional secrets", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const defaults = JSON.parse(await readFile("twitchy.config.json", "utf8")) as Record<string, unknown>;
    const config = await loadConfig({ envPath: join(tmpdir(), "twitchy-missing.env") });
    assert.equal(config.delayMs, defaults.delayMs);
    assert.equal(config.captureIntervalMs, defaults.captureIntervalMs);
    assert.equal(config.env.OPENAI_API_KEY, undefined);
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});

test("reads secrets from the .env file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "twitchy-env-"));
  try {
    const envPath = join(dir, ".env");
    await writeFile(envPath, 'export OBS_WS_PASSWORD="hunter 2"\nUNRELATED=x\n');
    const config = await loadConfig({ envPath });
    assert.equal(config.env.OBS_WS_PASSWORD ?? "", process.env.OBS_WS_PASSWORD ?? "hunter 2");
    assert.equal("UNRELATED" in config.env, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("loads the optional Twitch token-renewal values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "twitchy-env-"));
  const saved = { secret: process.env.TWITCH_CLIENT_SECRET, refresh: process.env.TWITCH_BOT_REFRESH_TOKEN };
  delete process.env.TWITCH_CLIENT_SECRET;
  delete process.env.TWITCH_BOT_REFRESH_TOKEN;
  try {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "TWITCH_CLIENT_SECRET=app-secret\nTWITCH_BOT_REFRESH_TOKEN=refresh-value\n");
    const config = await loadConfig({ envPath });
    assert.equal(config.env.TWITCH_CLIENT_SECRET, "app-secret");
    assert.equal(config.env.TWITCH_BOT_REFRESH_TOKEN, "refresh-value");
  } finally {
    if (saved.secret !== undefined) process.env.TWITCH_CLIENT_SECRET = saved.secret;
    if (saved.refresh !== undefined) process.env.TWITCH_BOT_REFRESH_TOKEN = saved.refresh;
    await rm(dir, { recursive: true, force: true });
  }
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

test("rejects a delay beyond what stacked Render Delay filters should carry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "twitchy-config-"));
  try {
    const valid = JSON.parse(await readFile("twitchy.config.json", "utf8")) as Record<string, unknown>;
    valid.delayMs = 2500;
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(valid));
    await assert.rejects(loadConfig({ configPath, envPath: join(dir, "missing.env") }), /Invalid config "delayMs"/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
