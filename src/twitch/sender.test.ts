import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../shared/bus.js";
import { redacted } from "../shared/events.js";
import { createChatSender } from "./sender.js";
import { createTokenManager } from "./token.js";

test("batches leaks into one safe chat message and retries a 429 after Ratelimit-Reset", async () => {
  const calls: { url: string; init?: RequestInit; message?: string }[] = [];
  let count = 0;
  const token = createTokenManager({
    clientId: "client-id", accessToken: "private-access-token",
    fetch: async (input, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(input), init, message: body.message });
      count += 1;
      if (count === 1) return new Response(null, { status: 429, headers: { "Ratelimit-Reset": String((Date.now() + 100) / 1_000) } });
      return new Response(JSON.stringify({ data: [{ is_sent: true }] }), { status: 200 });
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  const bus = new EventBus();
  const sender = createChatSender({ bus, token, broadcasterId: "broadcaster", botId: "bot", batchMs: 10, messageGapMs: 1, logger: { log() {}, warn() {}, error() {} } });
  const leak = (id: string, kind: "api_key" | "email", preview: string) => bus.emit("leak.detected", {
    id, kind, box: { x: 1, y: 2, w: 3, h: 4 }, preview: redacted(preview), totalBlocked: 1, at: Date.now(),
  });
  leak("one", "api_key", "PRIVATE_KEY_FRAGMENT");
  leak("two", "email", "j…@gmail.com");

  await new Promise((resolve) => setTimeout(resolve, 2_500));
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.message, "🛡 Twitchy blocked 2 leaks: api key, email");
  assert.equal(calls[1]?.message, calls[0]?.message);
  assert.ok(calls.every(({ message }) => !message?.includes("PRIVATE_KEY_FRAGMENT") && !message?.includes("gmail.com") && !message?.includes("preview")));
  assert.deepEqual(sender.pendingCounts(), { replies: 0, leaks: 0 });
  sender.stop();
  token.stop();
});
