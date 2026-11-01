import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { WebSocket } from "ws";
import { EventBus } from "../shared/bus.js";
import type { Config } from "../shared/config.js";
import { redacted } from "../shared/events.js";
import { start } from "./index.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
type Message = { event?: string; payload?: any; snapshot?: any };
async function connect(port: number, role: "overlay" | "dashboard"): Promise<{ socket: WebSocket; messages: Message[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/${role}`);
  const messages: Message[] = [];
  socket.on("message", (data: Buffer) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
  return { socket, messages };
}
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const events = (messages: Message[]) => messages.filter((message) => message.event).map((message) => message.event);
const snapshots = (messages: Message[]) => messages.filter((message) => message.snapshot).map((message) => message.snapshot);
async function close(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  socket.close();
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}
const config = (webPort: number) => ({ webPort } as Config);

test("serves the overlay page at /overlay/ and refuses paths outside it", async () => {
  const bus = new EventBus();
  const port = await freePort();
  const stop = await start(bus, config(port));
  try {
    const page = await fetch(`http://127.0.0.1:${port}/overlay/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Twitchy Overlay/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/overlay/overlay.js`)).status, 200);
    assert.notEqual((await fetch(`http://127.0.0.1:${port}/overlay/..%2F..%2Fpackage.json`)).status, 200);
  } finally { await stop(); }
});

test("sends an empty snapshot and no fake leak to the first page", async () => {
  const bus = new EventBus();
  const port = await freePort();
  const stop = await start(bus, config(port));
  const overlay = await connect(port, "overlay");
  try {
    await settle();
    assert.deepEqual(overlay.messages, [{ snapshot: { leakCount: 0 } }]);
  } finally {
    await close(overlay.socket);
    await stop();
  }
});

test("filters by role and snapshots state, leak count and private labels on reconnect", async () => {
  const bus = new EventBus();
  const port = await freePort();
  const stop = await start(bus, config(port));
  let overlay: WebSocket | undefined;
  let dashboard: WebSocket | undefined;
  try {
    const firstOverlay = await connect(port, "overlay");
    overlay = firstOverlay.socket;
    const firstDashboard = await connect(port, "dashboard");
    dashboard = firstDashboard.socket;
    await settle();
    bus.emit("shield.state", { status: "armed", at: 10 });
    bus.emit("private.state", { watchlist: [{ id: "label-only", label: "home" }], rules: [], at: 11 });
    bus.emit("engine.metrics", { lastFrameMs: 3, p95FrameMs: 4, budgetMs: 50, framesPerSec: 30, at: 12 });
    bus.emit("rules.compile", { requestId: "private-request", text: "secret rule text" });
    bus.emit("leak.detected", { id: "leak-1", kind: "email", box: { x: 1, y: 2, w: 3, h: 4 }, preview: redacted("email"), totalBlocked: 7, at: 13 });
    await settle();
    assert.deepEqual(events(firstOverlay.messages), ["shield.state", "leak.detected"]);
    assert.deepEqual(events(firstDashboard.messages), ["shield.state", "private.state", "engine.metrics", "leak.detected"]);
    assert.equal(JSON.stringify(firstOverlay.messages).includes("secret rule text"), false);
    assert.equal(JSON.stringify(firstDashboard.messages).includes("secret rule text"), false);
    await close(overlay); overlay = undefined;
    await close(dashboard); dashboard = undefined;

    const reconnectOverlay = await connect(port, "overlay");
    overlay = reconnectOverlay.socket;
    const reconnectDashboard = await connect(port, "dashboard");
    dashboard = reconnectDashboard.socket;
    await settle();
    assert.deepEqual(events(reconnectOverlay.messages), [], "a reconnect must not replay events as new leaks");
    assert.deepEqual(snapshots(reconnectOverlay.messages), [{ shieldState: { status: "armed", at: 10 }, leakCount: 7 }]);
    assert.deepEqual(events(reconnectDashboard.messages), []);
    assert.deepEqual(snapshots(reconnectDashboard.messages), [{
      shieldState: { status: "armed", at: 10 },
      leakCount: 7,
      privateState: { watchlist: [{ id: "label-only", label: "home" }], rules: [], at: 11 },
    }]);
  } finally {
    if (overlay) await close(overlay);
    if (dashboard) await close(dashboard);
    await stop();
  }
});
