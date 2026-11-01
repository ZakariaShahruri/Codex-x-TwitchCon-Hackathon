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
const burstScenarios = [
  { id: "burst-email", kind: "email" as const, preview: "a…@example.com", box: { x: 120, y: 180, w: 330, h: 52 } },
  { id: "burst-key", kind: "api_key" as const, preview: "ghp_…2Kd", box: { x: 1510, y: 110, w: 350, h: 54 } },
  { id: "burst-card", kind: "card" as const, preview: "card number", box: { x: 750, y: 300, w: 390, h: 56 } },
  { id: "burst-phone", kind: "phone" as const, preview: "phone number", box: { x: 1550, y: 890, w: 300, h: 58 } },
  { id: "burst-password", kind: "password" as const, preview: "password field", box: { x: 250, y: 760, w: 330, h: 52 } },
  { id: "burst-address", kind: "watchlist" as const, preview: "watchlist: home address", box: { x: 1110, y: 550, w: 400, h: 62 } },
  { id: "burst-qr", kind: "qr_code" as const, preview: "QR code", box: { x: 820, y: 80, w: 170, h: 170 } },
  { id: "burst-ip", kind: "ip" as const, preview: "IP address", box: { x: 70, y: 510, w: 310, h: 54 } },
];
const panicScenarios = burstScenarios.slice(0, 3);
let cycle = 0;
async function runCycle() {
  const base = cycle++ * (scenarios.length + burstScenarios.length + panicScenarios.length);
  let totalBlocked = base;
  bus.emit("shield.state", { status: "armed", at: at() });
  bus.emit("private.state", { watchlist: [{ id: "home", label: "home address" }], rules: [], at: at() });
  await delay(900);
  for (let index = 0; index < scenarios.length; index += 1) {
    const leak = scenarios[index]!;
    bus.emit("leak.detected", { ...leak, id: `${leak.id}-${base}`, preview: redacted(leak.preview), totalBlocked: ++totalBlocked, at: at() });
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

  bus.emit("shield.state", { status: "armed", at: at() });
  for (let index = 0; index < burstScenarios.length; index += 1) {
    const leak = burstScenarios[index]!;
    bus.emit("leak.detected", { ...leak, id: `${leak.id}-${base}`, preview: redacted(leak.preview), totalBlocked: ++totalBlocked, at: at() });
    await delay(220);
  }

  // Let Twitchy finish the capped queue, land on the newest leaks, and return home.
  await delay(2_000);
  for (let index = 0; index < panicScenarios.length; index += 1) {
    const leak = panicScenarios[index]!;
    bus.emit("leak.detected", { ...leak, id: `panic-${leak.id}-${base}`, preview: redacted(leak.preview), totalBlocked: ++totalBlocked, at: at() });
    if (index === 1) {
      await delay(160);
      bus.emit("shield.state", { status: "panic", reason: "Demo panic during burst", at: at() });
      await delay(60);
    } else {
      await delay(220);
    }
  }
  await delay(1_000);
  bus.emit("shield.command", { action: "unblur", by: "demo", at: at() });
  bus.emit("shield.state", { status: "armed", at: at() });
  await delay(900);
}
void (async () => {
  console.log(`Demo events ready at http://127.0.0.1:${config.webPort}/overlay/`);
  do { await runCycle(); } while (!stopping);
})();
