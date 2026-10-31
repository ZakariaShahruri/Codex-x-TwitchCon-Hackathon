import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import type { Box, LeakKind } from "./events.js";

export interface Config {
  delayMs: number;
  captureIntervalMs: number;
  safetyMarginMs: number;
  maskPoolSize: number;
  enabledDetectors: LeakKind[];
  sensitiveRegions: Box[];
  armOnStart: boolean;
  webPort: number;
  rulesModel: string;
  env: {
    TWITCH_CLIENT_ID?: string; TWITCH_BOT_TOKEN?: string; TWITCH_BOT_USER_ID?: string;
    TWITCH_BROADCASTER_ID?: string; OBS_WS_URL?: string; OBS_WS_PASSWORD?: string;
    OPENAI_API_KEY?: string;
  };
}

const detectorKinds: LeakKind[] = ["api_key", "email", "password", "phone", "card", "ip", "seed_phrase", "qr_code", "watchlist", "custom_rule", "sensitive_region"];
const envKeys = ["TWITCH_CLIENT_ID", "TWITCH_BOT_TOKEN", "TWITCH_BOT_USER_ID", "TWITCH_BROADCASTER_ID", "OBS_WS_URL", "OBS_WS_PASSWORD", "OPENAI_API_KEY"] as const;
type Raw = Omit<Config, "env">;

/** OBS caps one Render Delay filter at 500 ms; obs:setup stacks ceil(delayMs / 500) filters. Above 2 s the frame buffers cost too much GPU memory. */
export const RENDER_DELAY_FILTER_MAX_MS = 500;
const MAX_DELAY_MS = 2_000;

function fail(key: string, message: string): never { throw new Error(`Invalid config "${key}": ${message}`); }
function numberValue(value: unknown, key: string, min: number, max: number, integer = true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max)
    fail(key, `must be ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
  return value;
}

function validate(value: unknown): Raw {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("root", "must be a JSON object");
  const raw = value as Record<string, unknown>;
  const delayMs = numberValue(raw.delayMs, "delayMs", 1, MAX_DELAY_MS);
  const captureIntervalMs = numberValue(raw.captureIntervalMs, "captureIntervalMs", 1, 10_000);
  const safetyMarginMs = numberValue(raw.safetyMarginMs, "safetyMarginMs", 0, 60_000);
  if (captureIntervalMs + safetyMarginMs >= delayMs) fail("delayMs", "must exceed captureIntervalMs + safetyMarginMs");
  const maskPoolSize = numberValue(raw.maskPoolSize, "maskPoolSize", 1, 256);
  if (!Array.isArray(raw.enabledDetectors) || raw.enabledDetectors.some((item) => typeof item !== "string" || !detectorKinds.includes(item as LeakKind)))
    fail("enabledDetectors", `must be an array of recognized leak kinds`);
  if (!Array.isArray(raw.sensitiveRegions) || raw.sensitiveRegions.some((item) => {
    if (!item || typeof item !== "object") return true;
    const b = item as Record<string, unknown>;
    return ["x", "y", "w", "h"].some((k) => typeof b[k] !== "number" || !Number.isFinite(b[k])) || (b.w as number) <= 0 || (b.h as number) <= 0;
  })) fail("sensitiveRegions", "must be an array of boxes with finite x/y and positive w/h");
  if (typeof raw.armOnStart !== "boolean") fail("armOnStart", "must be a boolean");
  const webPort = numberValue(raw.webPort, "webPort", 1, 65535);
  if (typeof raw.rulesModel !== "string" || !raw.rulesModel.trim()) fail("rulesModel", "must be a non-empty string");
  return { delayMs, captureIntervalMs, safetyMarginMs, maskPoolSize,
    enabledDetectors: [...raw.enabledDetectors] as LeakKind[], sensitiveRegions: raw.sensitiveRegions as Box[],
    armOnStart: raw.armOnStart, webPort, rulesModel: raw.rulesModel };
}

export async function loadConfig(options: { configPath?: string; envPath?: string } = {}): Promise<Config> {
  const configPath = options.configPath ?? "twitchy.config.json";
  let json: unknown;
  try { json = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) { throw new Error(`Could not load ${configPath}: ${error instanceof Error ? error.message : String(error)}`); }
  const rawEnv = options.envPath === undefined ? ".env" : options.envPath;
  let fileEnv: NodeJS.Dict<string> = {};
  try { fileEnv = parseEnv(await readFile(rawEnv, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Could not load ${rawEnv}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const env = Object.fromEntries(envKeys.flatMap((key) => {
    const val = process.env[key] ?? fileEnv[key];
    return val === undefined || val === "" ? [] : [[key, val]];
  })) as Config["env"];
  return { ...validate(json), env };
}
