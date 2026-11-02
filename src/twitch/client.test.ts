import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventBus } from "../shared/bus.js";
import type { Config } from "../shared/config.js";
import { createEventSubTrack, type EventSubDependencies, type EventSubSocket } from "./client.js";
import { parseChatNotification } from "./chat.js";

const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as unknown;
const env = {
  TWITCH_CLIENT_ID: "client-id", TWITCH_BOT_TOKEN: "user-token", TWITCH_BOT_USER_ID: "9001", TWITCH_BROADCASTER_ID: "1337",
};
const config = (values: Record<string, string | undefined> = env) => ({ env: values } as Config);
const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); await new Promise<void>((resolve) => setImmediate(resolve)); };

class MockSocket implements EventSubSocket {
  readyState = 1;
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  closed = false;
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: any) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  emit(type: string, event: any): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  message(message: unknown): void { this.emit("message", { data: JSON.stringify(message) }); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", { code: 1000, reason: "closed by test" });
  }
}

function harness(overrides: EventSubDependencies = {}) {
  const sockets: MockSocket[] = [];
  const requests: { url: string; init?: RequestInit; body?: any }[] = [];
  const logs: string[] = [];
  const logger = {
    log: (...parts: unknown[]) => logs.push(parts.map(String).join(" ")),
    warn: (...parts: unknown[]) => logs.push(parts.map(String).join(" ")),
    error: (...parts: unknown[]) => logs.push(parts.map(String).join(" ")),
  };
  const dependencies: EventSubDependencies = {
    createSocket: (url) => { const socket = new MockSocket(url); sockets.push(socket); return socket; },
    fetch: async (input, init) => {
      const url = String(input);
      let body: any;
      if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
      const request = { url, init, body };
      requests.push(request);
      if (url.includes("/oauth2/validate")) return new Response(JSON.stringify({ login: "twitchybot", expires_in: 14_400 }), { status: 200 });
      return new Response(null, { status: 202 });
    },
    logger,
    retryBaseMs: 10,
    retryMaxMs: 30,
    authRetryMs: 5_000,
    ...overrides,
  };
  return { sockets, requests, logs, start: createEventSubTrack(dependencies) };
}

test("welcome creates the three Helix subscriptions for its websocket session", async () => {
  const h = harness();
  const stop = await h.start(new EventBus(), config());
  h.sockets[0]!.message(await fixture("session-welcome"));
  await flush();

  const subscriptions = h.requests.filter((request) => request.body?.type);
  assert.equal(subscriptions.length, 3);
  assert.deepEqual(subscriptions.map((request) => request.body.type).sort(), ["channel.chat.message", "stream.offline", "stream.online"]);
  assert.deepEqual(subscriptions.find((request) => request.body.type === "channel.chat.message")?.body.condition, { broadcaster_user_id: "1337", user_id: "9001" });
  assert.deepEqual(subscriptions.find((request) => request.body.type === "stream.online")?.body.condition, { broadcaster_user_id: "1337" });
  assert.ok(subscriptions.every((request) => request.body.transport.session_id === "session-main"));
  assert.ok(subscriptions.every((request) => (request.init?.headers as Record<string, string>).Authorization === "Bearer user-token"));
  await stop();
});

test("parses chat identity, badges and text from a recorded notification", async () => {
  const message = await fixture("chat-notification");
  assert.deepEqual(parseChatNotification(message), {
    user: "Salina", userId: "9001", login: "salina", messageId: "chat-1",
    badges: ["broadcaster", "moderator", "subscriber"], text: "!panic test message",
  });
  assert.equal(parseChatNotification(await fixture("session-welcome")), undefined);

  const h = harness();
  const stop = await h.start(new EventBus(), config());
  h.sockets[0]!.message(message);
  assert.ok(!h.logs.some((line) => line.includes("!panic test message")), "chat text is not written to logs");
  await stop();
});

test("keepalive timeout reconnects with a fresh session", async () => {
  const h = harness({ keepaliveGraceMs: 2 });
  const stop = await h.start(new EventBus(), config());
  const original = h.sockets[0]!;
  const welcome = await fixture("session-welcome") as any;
  welcome.payload.session.keepalive_timeout_seconds = 0.02;
  original.message(welcome);
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await flush();

  assert.equal(original.closed, true);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[1]?.url, "wss://eventsub.wss.twitch.tv/ws");
  assert.ok(h.logs.some((line) => line.includes("missed keepalive")));
  await stop();
});

test("session_reconnect keeps the old socket until the replacement welcomes and carries subscriptions over", async () => {
  const h = harness();
  const stop = await h.start(new EventBus(), config());
  const oldSocket = h.sockets[0]!;
  oldSocket.message(await fixture("session-welcome"));
  await flush();
  assert.equal(h.requests.filter((request) => request.body?.type).length, 3);

  oldSocket.message(await fixture("session-reconnect"));
  const replacement = h.sockets[1]!;
  assert.equal(replacement.url, "wss://eventsub.wss.twitch.tv/ws?reconnect=fixture");
  assert.equal(oldSocket.closed, false);
  replacement.message(await fixture("session-welcome"));
  await flush();

  assert.equal(oldSocket.closed, true);
  assert.equal(h.requests.filter((request) => request.body?.type).length, 3, "subscriptions are inherited during EventSub handover");
  assert.ok(h.logs.includes("[twitch] EventSub reconnect handover complete."));
  await stop();
});

test("logs revocation reason and resubscribes recoverable subscription types", async () => {
  const h = harness();
  const stop = await h.start(new EventBus(), config());
  const socket = h.sockets[0]!;
  socket.message(await fixture("session-welcome"));
  await flush();
  socket.message(await fixture("revocation"));
  await flush();

  assert.ok(h.logs.some((line) => line.includes("revoked channel.chat.message: version_removed")));
  assert.equal(h.requests.filter((request) => request.body?.type).length, 4);
  assert.ok(h.requests.some((request) => request.body?.type === "channel.chat.message" && request.body.transport.session_id === "session-main"));
  await stop();
});

test("missing Twitch credentials warn once and start without throwing or opening a socket", async () => {
  const h = harness();
  const stop = await h.start(new EventBus(), config({ TWITCH_CLIENT_ID: "", TWITCH_BOT_TOKEN: undefined }));
  assert.equal(h.sockets.length, 0);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0]!, /TWITCH_CLIENT_ID, TWITCH_BOT_TOKEN, TWITCH_BOT_USER_ID, TWITCH_BROADCASTER_ID/);
  await stop();
});

test("a Helix 401 reports token recovery and retries slowly", async () => {
  const h = harness({
    fetch: async (input) => String(input).includes("/oauth2/validate")
      ? new Response(JSON.stringify({ login: "bot", expires_in: 100 }), { status: 200 })
      : new Response(null, { status: 401 }),
    authRetryMs: 100,
  });
  const stop = await h.start(new EventBus(), config());
  h.sockets[0]!.message(await fixture("session-welcome"));
  await flush();

  assert.equal(h.sockets[0]!.closed, true);
  assert.equal(h.sockets.length, 1, "401 does not cause a tight reconnect loop");
  assert.ok(h.logs.some((line) => line.includes("invalid or expired") && line.includes("twitch token --user-token")));
  await stop();
});

async function chatFrame(text: string, id: string, badge: string, login = "viewer") {
  const frame = await fixture("chat-notification") as any;
  frame.metadata.message_id = id;
  frame.payload.event.chatter_user_id = login === "salina" ? "9001" : `id-${login}`;
  frame.payload.event.chatter_user_login = login;
  frame.payload.event.chatter_user_name = login;
  frame.payload.event.badges = badge ? [{ set_id: badge, id: "1", info: "" }] : [];
  frame.payload.event.message.text = text;
  frame.payload.event.message.fragments = [{ type: "text", text }];
  return frame;
}

test("commands allow broadcaster and moderators, ignore viewers, and ignore duplicate message IDs", async () => {
  const bus = new EventBus();
  const commands: any[] = [];
  bus.on("shield.command", (command) => { commands.push(command); });
  const h = harness({ chatMessageGapMs: 1 });
  const stop = await h.start(bus, config());
  const socket = h.sockets[0]!;
  socket.message(await fixture("session-welcome"));
  await flush();

  const panic = await chatFrame("!panic", "panic-once", "broadcaster", "salina");
  socket.message(await chatFrame("!panic", "viewer-panic", "", "viewer"));
  socket.message(panic);
  socket.message(panic);
  bus.emit("shield.state", { status: "panic", at: 3 });
  socket.message(await chatFrame("!unblur", "panic-unblur", "broadcaster", "salina"));
  socket.message(await chatFrame("!shield on", "mod-on", "moderator", "modlogin"));
  socket.message(await chatFrame("!shield off", "mod-off", "moderator", "modlogin"));
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(commands.map(({ action, by }) => ({ action, by })), [
    { action: "panic", by: "salina" }, { action: "unblur", by: "salina" },
    { action: "on", by: "modlogin" }, { action: "off", by: "modlogin" },
  ]);
  const replies = h.requests.filter((request) => request.url.includes("/chat/messages")).map((request) => request.body.message);
  assert.deepEqual(replies, ["🚨 Panic mask on.", "Panic lifted.", "🛡 Shield armed.", "Shield disarmed."]);
  await stop();
});

test("!twitchy replies once per user cooldown", async () => {
  const h = harness({ twitchyCooldownMs: 60_000, chatMessageGapMs: 1 });
  const bus = new EventBus();
  const stop = await h.start(bus, config());
  const socket = h.sockets[0]!;
  socket.message(await fixture("session-welcome"));
  await flush();
  bus.emit("leak.detected", { id: "leak1", kind: "email", box: { x: 1, y: 1, w: 2, h: 2 }, preview: "j…@gmail.com" as any, totalBlocked: 4, at: 1 });
  bus.emit("shield.state", { status: "degraded", at: 2 });
  socket.message(await chatFrame("!twitchy", "stats-1", "", "viewer-7"));
  socket.message(await chatFrame("!twitchy", "stats-2", "", "viewer-7"));
  await new Promise((resolve) => setTimeout(resolve, 30));

  const sent = h.requests.filter((request) => request.url.includes("/chat/messages"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.body.message, "🛡 4 leaks blocked this stream · shield degraded");
  await stop();
});

test("a refreshed token is used for subscription retries after Helix 401", async () => {
  const requests: { url: string; init?: RequestInit; body?: any }[] = [];
  const h = harness({
    fetch: async (input, init) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({ url, init, body: init?.body });
      if (url.endsWith("/oauth2/validate")) return new Response(JSON.stringify({ login: "botlogin", expires_in: 14_400 }), { status: 200 });
      if (url.endsWith("/oauth2/token")) return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 14_400 }), { status: 200 });
      if (url.includes("/eventsub/subscriptions") && headers?.Authorization === "Bearer old-access") return new Response(null, { status: 401 });
      return new Response(null, { status: 202 });
    },
  });
  const stop = await h.start(new EventBus(), config({ ...env, TWITCH_BOT_TOKEN: "old-access", TWITCH_CLIENT_SECRET: "secret-value", TWITCH_BOT_REFRESH_TOKEN: "old-refresh" }));
  h.sockets[0]!.message(await fixture("session-welcome"));
  await flush();
  await flush();

  assert.equal(requests.filter((request) => request.url.endsWith("/oauth2/token")).length, 1);
  assert.ok(requests.filter((request) => request.url.includes("/eventsub/subscriptions") && (request.init?.headers as Record<string, string>).Authorization === "Bearer new-access").length >= 3);
  assert.ok(!h.logs.join("\n").includes("secret-value"));
  await stop();
});

test("stream.online auto-arms and stream.offline sends the leak count", async () => {
  const bus = new EventBus();
  const commands: any[] = [];
  bus.on("shield.command", (command) => { commands.push(command); });
  const h = harness({ chatMessageGapMs: 1 });
  const stop = await h.start(bus, config());
  const socket = h.sockets[0]!;
  socket.message(await fixture("session-welcome"));
  await flush();
  const online = await fixture("chat-notification") as any;
  online.metadata.message_id = "online-1";
  online.payload.subscription.type = "stream.online";
  online.payload.event = { broadcaster_user_name: "Salina" };
  const offline = structuredClone(online);
  offline.metadata.message_id = "offline-1";
  offline.payload.subscription.type = "stream.offline";
  bus.emit("leak.detected", { id: "prior", kind: "api_key", box: { x: 1, y: 1, w: 2, h: 2 }, preview: "redacted" as any, totalBlocked: 2, at: 1 });
  socket.message(online);
  bus.emit("leak.detected", { id: "l1", kind: "api_key", box: { x: 1, y: 1, w: 2, h: 2 }, preview: "redacted" as any, totalBlocked: 3, at: 2 });
  socket.message(offline);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(commands.map(({ action, by }) => ({ action, by })), [{ action: "on", by: "stream.online" }]);
  assert.ok(h.requests.some((request) => request.url.includes("/chat/messages") && request.body.message === "🛡 Twitchy blocked 1 leaks this stream"));
  await stop();
});
