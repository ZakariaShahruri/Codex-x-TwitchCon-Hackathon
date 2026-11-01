import { EventBus } from "./shared/bus.js";
import { loadConfig } from "./shared/config.js";
import type { StartTrack, StopTrack } from "./shared/track.js";
import { start as startShield } from "./shield/index.js";
import { start as startTwitch } from "./twitch/index.js";
import { start as startWeb } from "./web/index.js";

const STOP_TIMEOUT_MS = 3_000;
const tracks: [string, StartTrack][] = [["shield", startShield], ["twitch", startTwitch], ["web", startWeb]];

const config = await loadConfig();
const bus = new EventBus();
const stops: [string, StopTrack][] = [];
let stopping = false;

async function shutdown(code: number): Promise<never> {
  if (stopping) process.exit(code);
  stopping = true;
  console.log("Shutting down Twitchy.");
  const timeout = setTimeout(() => {
    console.error(`Shutdown took over ${STOP_TIMEOUT_MS} ms; exiting anyway.`);
    process.exit(code || 1);
  }, STOP_TIMEOUT_MS);
  for (const [name, stop] of stops.reverse()) {
    try { await stop(); }
    catch (error) { console.error(`Stopping ${name} failed:`, error); }
  }
  clearTimeout(timeout);
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

for (const [name, start] of tracks) {
  try { stops.push([name, await start(bus, config)]); }
  catch (error) {
    console.error(`Starting ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    await shutdown(1);
  }
}
console.log("Twitchy ready.");
