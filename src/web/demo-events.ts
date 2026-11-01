import { EventBus } from "../shared/bus.js";
import { loadConfig } from "../shared/config.js";
import { redacted } from "../shared/events.js";
import { start } from "./index.js";

const config = await loadConfig();
const bus = new EventBus();
const stop = await start(bus, config);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const at = () => Date.now();
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

const scenarios = [
  { id: "demo-email", kind: "email" as const, preview: "j…@gmail.com", box: { x: 260, y: 160, w: 370, h: 56 } },
  { id: "demo-key", kind: "api_key" as const, preview: "sk-…9aF", box: { x: 900, y: 470, w: 430, h: 58 } },
  { id: "demo-password", kind: "password" as const, preview: "password field", box: { x: 540, y: 760, w: 330, h: 52 } },
  { id: "demo-address", kind: "watchlist" as const, preview: "watchlist: home address", box: { x: 1230, y: 210, w: 410, h: 62 } },
  { id: "demo-qr", kind: "qr_code" as const, preview: "QR code", box: { x: 300, y: 570, w: 150, h: 150 } },
];
let cycle = 0;
async function runCycle() {
  const base = cycle++ * 10;
  bus.emit("shield.state", { status: "armed", at: at() });
  bus.emit("private.state", { watchlist: [{ id: "home", label: "home address" }], rules: [], at: at() });
  await delay(900);
  for (let index = 0; index < scenarios.length; index += 1) {
    const leak = scenarios[index]!;
    bus.emit("leak.detected", { ...leak, id: `${leak.id}-${base}`, preview: redacted(leak.preview), totalBlocked: base + index + 1, at: at() });
    await delay(index === 0 ? 180 : 1_150);
  }
  for (const leak of scenarios) {
    bus.emit("leak.cleared", { id: `${leak.id}-${base}`, at: at() });
    await delay(180);
  }
  bus.emit("shield.state", { status: "degraded", reason: "Demo: frame over budget", at: at() });
  await delay(1_500);
  bus.emit("shield.state", { status: "panic", reason: "Demo panic", at: at() });
  await delay(1_800);
  bus.emit("shield.command", { action: "unblur", by: "demo", at: at() });
  bus.emit("shield.state", { status: "off", at: at() });
  await delay(2_000);
}
void (async () => {
  console.log(`Demo events ready at http://127.0.0.1:${config.webPort}/overlay/`);
  do { await runCycle(); } while (!stopping);
})();
