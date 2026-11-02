import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../shared/bus.js";
import { redacted, type LeakKind } from "../shared/events.js";
import { createChatSender, leakSummary, MAX_CHAT_LENGTH } from "./sender.js";
import { createTokenManager } from "./token.js";

const quiet = { log() {}, warn() {}, error() {} };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A sender whose Helix responses come from `respond`, in call order. */
function harness(respond: (call: number, message: string) => Response, options: { batchMs?: number } = {}) {
  const messages: string[] = [];
  const token = createTokenManager({
    clientId: "client-id", accessToken: "private-access-token", logger: quiet,
    fetch: async (_input, init) => {
      const message = JSON.parse(String(init?.body)).message as string;
      messages.push(message);
      return respond(messages.length, message);
    },
  });
  const bus = new EventBus();
  const sender = createChatSender({ bus, token, broadcasterId: "broadcaster", botId: "bot", batchMs: options.batchMs ?? 10, messageGapMs: 1, logger: quiet });
  const leak = (kind: LeakKind, preview = "preview-text") => bus.emit("leak.detected", {
    id: `${kind}-${Math.random()}`, kind, box: { x: 1, y: 2, w: 3, h: 4 }, preview: redacted(preview), totalBlocked: 1, at: Date.now(),
  });
  const stop = () => { sender.stop(); token.stop(); };
  return { messages, sender, leak, stop };
}
const ok = () => new Response(JSON.stringify({ data: [{ is_sent: true }] }), { status: 200 });

test("batches leaks into one safe chat message and retries a 429 after Ratelimit-Reset", async () => {
  const h = harness((call) => call === 1
    ? new Response(null, { status: 429, headers: { "Ratelimit-Reset": String((Date.now() + 100) / 1_000) } })
    : ok());
  h.leak("api_key", "PRIVATE_KEY_FRAGMENT");
  h.leak("email", "j…@gmail.com");

  await wait(1_500);
  assert.equal(h.messages.length, 2);
  assert.equal(h.messages[0], "🛡 Twitchy blocked 2 leaks: 1 api key, 1 email");
  assert.equal(h.messages[1], h.messages[0]);
  assert.ok(h.messages.every((message) => !message.includes("PRIVATE_KEY_FRAGMENT") && !message.includes("gmail.com")));
  assert.deepEqual(h.sender.pendingCounts(), { replies: 0, leaks: 0 });
  h.stop();
});

test("a burst of 60 leaks becomes one message under the chat limit, counted by kind", () => {
  const kinds: LeakKind[] = ["api_key", "email", "password", "phone", "card", "ip", "seed_phrase", "qr_code", "watchlist", "custom_rule", "sensitive_region"];
  const counts = new Map<LeakKind, number>();
  for (let i = 0; i < 60; i += 1) counts.set(kinds[i % kinds.length]!, (counts.get(kinds[i % kinds.length]!) ?? 0) + 1);
  const message = leakSummary(counts);
  assert.ok(message.length <= MAX_CHAT_LENGTH);
  assert.match(message, /^🛡 Twitchy blocked 60 leaks: 6 api keys, 6 emails, 6 passwords/);
  assert.match(message, /5 sensitive regions$/);
});

test("a minute-scale 28-leak burst becomes a small number of complete chat summaries", async () => {
  const h = harness(() => ok(), { batchMs: 60 });
  const kinds: LeakKind[] = ["api_key", "email", "password", "phone", "card", "ip", "watchlist"];
  for (let index = 0; index < 28; index += 1) {
    h.leak(kinds[index % kinds.length]!);
    await wait(20); // Scaled from roughly one leak every 2.1 seconds over a minute.
  }
  await wait(250);

  const announced = h.messages.reduce((sum, message) => sum + Number(message.match(/blocked (\d+) leaks?:/)?.[1] ?? 0), 0);
  assert.ok(h.messages.length <= 12, `expected a handful of summaries, got ${h.messages.length}`);
  assert.equal(announced, 28);
  assert.ok(h.messages.every((message) => message.length <= MAX_CHAT_LENGTH));
  h.stop();
});

test("a rejected announcement is dropped and the next reply still goes out", async () => {
  const h = harness((call) => call === 1 ? new Response(null, { status: 400 }) : ok());
  h.leak("api_key");
  await wait(100);
  h.sender.sendReply("🛡 0 leaks blocked this stream · shield armed");
  await wait(200);
  assert.equal(h.messages.length, 2);
  assert.equal(h.messages[1], "🛡 0 leaks blocked this stream · shield armed");
  assert.deepEqual(h.sender.pendingCounts(), { replies: 0, leaks: 0 });
  h.stop();
});

test("replies never wait behind an announcement that keeps failing", async () => {
  const h = harness((_call, message) => message.startsWith("🛡 Twitchy blocked") ? new Response(null, { status: 503 }) : ok());
  h.leak("email");
  await wait(100);
  h.sender.sendReply("Panic lifted.");
  await wait(200);
  assert.ok(h.messages.includes("Panic lifted."), "the reply is sent while the announcement is backing off");
  assert.deepEqual(h.sender.pendingCounts(), { replies: 0, leaks: 1 }, "the 503 announcement is kept for a retry");
  h.stop();
});

test("5xx and network errors are retried, not dropped", async () => {
  const h = harness((call) => call === 1 ? new Response(null, { status: 502 }) : ok());
  h.sender.sendReply("🛡 Shield armed.");
  await wait(100);
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.sender.pendingCounts(), { replies: 1, leaks: 0 }, "the reply waits for its backoff instead of being dropped");
  h.stop();

  const offline = createTokenManager({ clientId: "client-id", accessToken: "token", logger: quiet, fetch: async () => { throw new TypeError("fetch failed"); } });
  const sender = createChatSender({ bus: new EventBus(), token: offline, broadcasterId: "b", botId: "bot", messageGapMs: 1, logger: quiet });
  sender.sendReply("🛡 Shield armed.");
  await wait(100);
  assert.deepEqual(sender.pendingCounts(), { replies: 1, leaks: 0 });
  sender.stop();
  offline.stop();
});

test("long replies are cut to the chat limit", async () => {
  const h = harness(() => ok());
  h.sender.sendReply("x".repeat(800));
  await wait(100);
  assert.equal(h.messages[0]?.length, MAX_CHAT_LENGTH);
  h.stop();
});
