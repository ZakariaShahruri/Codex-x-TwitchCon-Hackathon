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
async function connect(port: number, role: "overlay" | "dashboard"): Promise<{ socket: WebSocket; messages: { event: string; payload: any }[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/${role}`);
  const messages: { event: string; payload: any }[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return { socket, messages };
}
async function close(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  socket.close();
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}
const config = (webPort: number) => ({ webPort } as Config);

test("filters by role and replays state, leak count and private labels after reconnect", async () => {
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
    bus.emit("shield.state", { status: "armed", at: 10 });
    bus.emit("private.state", { watchlist: [{ id: "label-only", label: "home" }], rules: [], at: 11 });
    bus.emit("engine.metrics", { lastFrameMs: 3, p95FrameMs: 4, budgetMs: 50, framesPerSec: 30, at: 12 });
    bus.emit("rules.compile", { requestId: "private-request", text: "secret rule text" });
    bus.emit("leak.detected", { id: "leak-1", kind: "email", box: { x: 1, y: 2, w: 3, h: 4 }, preview: redacted("email"), totalBlocked: 7, at: 13 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(firstOverlay.messages.map((message) => message.event), ["shield.state", "leak.detected"]);
    assert.deepEqual(firstDashboard.messages.map((message) => message.event), ["shield.state", "private.state", "engine.metrics", "leak.detected"]);
    assert.equal(JSON.stringify(firstOverlay.messages).includes("secret rule text"), false);
    await close(overlay); overlay = undefined;
    await close(dashboard); dashboard = undefined;

    const reconnectOverlay = await connect(port, "overlay");
    overlay = reconnectOverlay.socket;
    const reconnectDashboard = await connect(port, "dashboard");
    dashboard = reconnectDashboard.socket;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(reconnectOverlay.messages.map((message) => message.event), ["shield.state", "leak.detected"]);
    assert.equal(reconnectOverlay.messages[1]?.payload.totalBlocked, 7);
    assert.deepEqual(reconnectDashboard.messages.map((message) => message.event), ["shield.state", "leak.detected", "private.state"]);
    assert.deepEqual(reconnectDashboard.messages[2]?.payload.watchlist, [{ id: "label-only", label: "home" }]);
  } finally {
    if (overlay) await close(overlay);
    if (dashboard) await close(dashboard);
    await stop();
  }
});
