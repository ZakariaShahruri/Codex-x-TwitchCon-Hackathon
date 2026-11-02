import test from "node:test";
import assert from "node:assert/strict";
import { createTokenManager } from "./token.js";

test("validates the bot login, renews before expiry, and uses rotated credentials", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const logs: string[] = [];
  let renewals = 0;
  const manager = createTokenManager({
    clientId: "client-id", accessToken: "old-access-secret", clientSecret: "client-secret-value", refreshToken: "old-refresh-secret",
    renewalBufferMs: 10,
    logger: { log: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)), error: (line) => logs.push(String(line)) },
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/oauth2/validate")) return new Response(JSON.stringify({ login: "twitchybot", expires_in: 0.04 }), { status: 200 });
      if (url.endsWith("/oauth2/token")) {
        renewals += 1;
        return new Response(JSON.stringify({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 14_400 }), { status: 200 });
      }
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer rotated-access");
      return new Response(null, { status: 204 });
    },
  });

  await manager.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const response = await manager.request("https://api.twitch.tv/helix/test");
  assert.equal(response.status, 204);
  assert.equal(renewals, 1);
  assert.ok(logs.some((line) => line.includes("token validated for twitchybot") && line.includes("hours")));
  assert.ok(logs.some((line) => line.includes("bot token renewed")));
  assert.ok(!logs.join("\n").includes("old-access-secret"));
  assert.ok(!logs.join("\n").includes("old-refresh-secret"));
  assert.ok(!logs.join("\n").includes("client-secret-value"));
  manager.stop();
});

test("retries a Helix 401 after refreshing and never prints token values", async () => {
  const authHeaders: string[] = [];
  const logs: string[] = [];
  const manager = createTokenManager({
    clientId: "client-id", accessToken: "old-access-secret", clientSecret: "client-secret-value", refreshToken: "old-refresh-secret",
    logger: { log: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)), error: (line) => logs.push(String(line)) },
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/oauth2/validate")) return new Response(JSON.stringify({ login: "bot", expires_in: 14_400 }), { status: 200 });
      if (url.endsWith("/oauth2/token")) return new Response(JSON.stringify({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 14_400 }), { status: 200 });
      const authorization = (init?.headers as Record<string, string>).Authorization;
      authHeaders.push(authorization);
      return authHeaders.length === 1 ? new Response(null, { status: 401 }) : new Response(null, { status: 200 });
    },
  });
  await manager.start();
  const response = await manager.request("https://api.twitch.tv/helix/test");
  assert.equal(response.status, 200);
  assert.deepEqual(authHeaders, ["Bearer old-access-secret", "Bearer rotated-access"]);
  assert.ok(!logs.join("\n").includes("secret"));
  manager.stop();
});
