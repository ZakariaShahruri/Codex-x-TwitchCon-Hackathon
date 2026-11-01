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
      const request = { url: String(input), init, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      requests.push(request);
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

  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.requests.map((request) => request.body.type).sort(), ["channel.chat.message", "stream.offline", "stream.online"]);
  assert.deepEqual(h.requests.find((request) => request.body.type === "channel.chat.message")?.body.condition, { broadcaster_user_id: "1337", user_id: "9001" });
  assert.deepEqual(h.requests.find((request) => request.body.type === "stream.online")?.body.condition, { broadcaster_user_id: "1337" });
  assert.ok(h.requests.every((request) => request.body.transport.session_id === "session-main"));
  assert.ok(h.requests.every((request) => (request.init?.headers as Record<string, string>).Authorization === "Bearer user-token"));
  await stop();
});

test("parses chat user, badges and text from a recorded notification", async () => {
  const message = await fixture("chat-notification");
  assert.deepEqual(parseChatNotification(message), {
    user: "Salina", badges: ["broadcaster", "moderator", "subscriber"], text: "!panic test message",
  });
  assert.equal(parseChatNotification(await fixture("session-welcome")), undefined);

  const h = harness();
  const stop = await h.start(new EventBus(), config());
  h.sockets[0]!.message(message);
  assert.ok(h.logs.some((line) => line === "chat Salina [broadcaster, moderator, subscriber]: !panic test message"));
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
  assert.equal(h.requests.length, 3);

  oldSocket.message(await fixture("session-reconnect"));
  const replacement = h.sockets[1]!;
  assert.equal(replacement.url, "wss://eventsub.wss.twitch.tv/ws?reconnect=fixture");
  assert.equal(oldSocket.closed, false);
  replacement.message(await fixture("session-welcome"));
  await flush();

  assert.equal(oldSocket.closed, true);
  assert.equal(h.requests.length, 3, "subscriptions are inherited during EventSub handover");
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
  assert.equal(h.requests.length, 4);
  assert.equal(h.requests[3]?.body.type, "channel.chat.message");
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
    fetch: async () => new Response(null, { status: 401 }),
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
