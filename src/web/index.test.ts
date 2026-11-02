import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { WebSocket, type ClientOptions } from "ws";
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
async function connect(port: number, role: "overlay" | "dashboard", options: { origin?: string | null; host?: string } = {}): Promise<{ socket: WebSocket; messages: Message[] }> {
  const headers: Record<string, string> = {};
  if (options.origin !== null) headers.Origin = options.origin ?? `http://127.0.0.1:${port}`;
  if (options.host) headers.Host = options.host;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/${role}`, { headers } as ClientOptions);
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
function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}
const config = (webPort: number) => ({ webPort } as Config);

test("fails fast with an actionable message when the port is taken", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const address = blocker.address();
  assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(start(new EventBus(), config(address.port)), new RegExp(`Port ${address.port} .*already in use.*lsof -iTCP:${address.port} -sTCP:LISTEN`));
  } finally { await new Promise<void>((resolve) => blocker.close(() => resolve())); }
});

test("keeps the app alive when the configured web port is invalid", async () => {
  const stop = await start(new EventBus(), config(70_000));
  await stop();
});

test("serves the overlay page at /overlay/ and refuses paths outside it", async () => {
  const bus = new EventBus();
  const port = await freePort();
  const stop = await start(bus, config(port));
  try {
    const page = await fetch(`http://127.0.0.1:${port}/overlay/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Twitchy Overlay/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/overlay/overlay.js`)).status, 200);
    const dashboard = await fetch(`http://127.0.0.1:${port}/dashboard/`);
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /Streamer dashboard|Stream console/i);
    assert.equal((await fetch(`http://127.0.0.1:${port}/dashboard/dashboard.js`)).status, 200);
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

test("dashboard snapshot reports missing Twitch configuration without exposing credentials", async () => {
  const bus = new EventBus();
  const port = await freePort();
  const stop = await start(bus, { webPort: port, env: { TWITCH_BOT_TOKEN: "test-token-secret" } } as Config);
  const dashboard = await connect(port, "dashboard");
  try {
    await settle();
    const [snapshot] = snapshots(dashboard.messages);
    assert.equal(snapshot.leakCount, 0);
    assert.equal(snapshot.twitchStatus.connected, false);
    assert.equal(snapshot.twitchStatus.error, "Missing TWITCH_CLIENT_ID, TWITCH_BOT_USER_ID, TWITCH_BROADCASTER_ID");
    assert.ok(!JSON.stringify(dashboard.messages).includes("test-token-secret"));
  } finally {
    await close(dashboard.socket);
    await stop();
  }
});

test("stop terminates browser sockets and closes the server promptly", async () => {
  const bus = new EventBus();
  const port = await freePort();
  const stop = await start(bus, config(port));
  const overlay = await connect(port, "overlay");
  await settle();
  const startedAt = Date.now();
  await stop();
  assert.ok(Date.now() - startedAt < 1_000, "stop should not wait for a browser close handshake");
  await close(overlay.socket);
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
    bus.emit("twitch.status", { connected: true, live: true, login: "bot", expiresInHours: 3.5, at: 12 });
    bus.emit("rules.compile", { requestId: "private-request", text: "secret rule text" });
    bus.emit("leak.detected", { id: "leak-1", kind: "email", box: { x: 1, y: 2, w: 3, h: 4 }, preview: redacted("email"), totalBlocked: 7, at: 13 });
    bus.emit("chat.cheer", { by: "salina", at: 14 });
    await settle();
    assert.deepEqual(events(firstOverlay.messages), ["shield.state", "leak.detected", "chat.cheer"]);
    assert.deepEqual(events(firstDashboard.messages), ["shield.state", "private.state", "engine.metrics", "twitch.status", "leak.detected", "chat.cheer"]);
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
      twitchStatus: { connected: true, live: true, login: "bot", expiresInHours: 3.5, at: 12 },
    }]);
  } finally {
    if (overlay) await close(overlay);
    if (dashboard) await close(dashboard);
    await stop();
  }
});

test("resets the browser counter on stream.online and rewrites leak totals per stream", async () => {
  const bus = new EventBus();
  const port = await freePort();
  const stop = await start(bus, config(port));
  const overlay = await connect(port, "overlay");
  try {
    await settle();
    bus.emit("leak.detected", { id: "before", kind: "email", box: { x: 1, y: 2, w: 3, h: 4 }, preview: redacted("email"), totalBlocked: 8, at: 1 });
    bus.emit("shield.state", { status: "armed", at: 2 });
    bus.emit("shield.command", { action: "on", by: "stream.online", at: 3 });
    bus.emit("leak.detected", { id: "after", kind: "api_key", box: { x: 5, y: 6, w: 7, h: 8 }, preview: redacted("api key"), totalBlocked: 1, at: 4 });
    await settle();

    const leakEvents = overlay.messages.filter((message) => message.event === "leak.detected");
    assert.deepEqual(leakEvents.map((message) => message.payload.totalBlocked), [8, 1]);
    assert.deepEqual(snapshots(overlay.messages), [
      { leakCount: 0 },
      { shieldState: { status: "armed", at: 2 }, leakCount: 0 },
    ]);
  } finally {
    await close(overlay.socket);
    await stop();
  }
});

test("accepts dashboard commands only on a same-origin localhost dashboard socket", async () => {
  const bus = new EventBus();
  const port = await freePort();
  const stop = await start(bus, config(port));
  const received: unknown[] = [];
  bus.on("shield.command", (command) => { received.push(command); });
  try {
    const { socket: dashboard } = await connect(port, "dashboard");
    dashboard.send(JSON.stringify({ event: "shield.command", payload: { action: "panic", by: "dashboard", at: 1 } }));
    await settle();
    assert.deepEqual(received, [{ action: "panic", by: "dashboard", at: 1 }]);
    await close(dashboard);

    const { socket: overlay } = await connect(port, "overlay");
    const overlayClosed = waitForClose(overlay);
    overlay.send(JSON.stringify({ event: "shield.command", payload: { action: "panic", by: "dashboard", at: 2 } }));
    await overlayClosed;
    assert.equal(received.length, 1, "overlay sockets are receive-only");
    await close(overlay);
  } finally { await stop(); }
});

test("rejects missing or foreign Origin and Host headers", async () => {
  const port = await freePort();
  const stop = await start(new EventBus(), config(port));
  try {
    const localhost = await connect(port, "dashboard", { origin: `http://localhost:${port}`, host: `localhost:${port}` });
    await close(localhost.socket);
    for (const options of [
      { origin: null },
      { origin: "https://evil.example" },
      { origin: `http://evil.example:${port}` },
      { host: `evil.example:${port}` },
      { host: `localhost:${port}` },
    ]) {
      await assert.rejects(connect(port, "dashboard", options));
    }
  } finally { await stop(); }
});

test("rejects malformed, oversized and non-allowlisted browser commands", async () => {
  const port = await freePort();
  const stop = await start(new EventBus(), config(port));
  try {
    for (const data of [
      "not json",
      JSON.stringify({ event: "private.state", payload: { watchlist: [], rules: [], at: 1 } }),
      JSON.stringify({ event: "shield.command", payload: { action: "panic", by: "dashboard" } }),
      JSON.stringify({ event: "rules.compile", payload: { requestId: "id", text: "x".repeat(20_000) } }),
      "x".repeat(17 * 1024),
    ]) {
      const { socket } = await connect(port, "dashboard");
      const closed = waitForClose(socket);
      socket.send(data);
      const code = await closed;
      assert.ok(code === 1008 || code === 1009, `unexpected close code ${code}`);
    }
  } finally { await stop(); }
});

test("forwards valid browserCommands in-process but never logs or echoes config.updated", async () => {
  const bus = new EventBus();
  const port = await freePort();
  const stop = await start(bus, config(port));
  const delivered: unknown[] = [];
  bus.on("config.updated", (payload) => { delivered.push(payload); });
  const otherCommands: unknown[] = [];
  bus.on("rules.compile", (payload) => { otherCommands.push(["rules.compile", payload]); });
  bus.on("obs.setup", (payload) => { otherCommands.push(["obs.setup", payload]); });
  const originalLog = console.log;
  const capturedLogs: unknown[][] = [];
  console.log = (...parts: unknown[]) => { capturedLogs.push(parts); };
  let browser: WebSocket | undefined;
  try {
    const connected = await connect(port, "dashboard");
    browser = connected.socket;
    browser.send(JSON.stringify({ event: "config.updated", payload: { watchlist: { add: [{ label: "home", value: "private-secret-value" }] } } }));
    browser.send(JSON.stringify({ event: "rules.compile", payload: { requestId: "rule-1", text: "hide my mother's name" } }));
    browser.send(JSON.stringify({ event: "obs.setup", payload: { requestId: "obs-1", contentScene: "Just Chatting" } }));
    await settle();
    assert.deepEqual(delivered, [{ watchlist: { add: [{ label: "home", value: "private-secret-value" }] } }]);
    assert.equal(JSON.stringify(connected.messages).includes("private-secret-value"), false);
    assert.equal(JSON.stringify(capturedLogs).includes("private-secret-value"), false);
    assert.deepEqual(otherCommands, [
      ["rules.compile", { requestId: "rule-1", text: "hide my mother's name" }],
      ["obs.setup", { requestId: "obs-1", contentScene: "Just Chatting" }],
    ]);
  } finally {
    if (browser) await close(browser);
    await stop();
    console.log = originalLog;
  }
});
