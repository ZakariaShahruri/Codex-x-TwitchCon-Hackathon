import assert from "node:assert/strict";
import test from "node:test";
import { EventBus } from "../shared/bus.js";
import { loadConfig } from "../shared/config.js";
import type { EventMap } from "../shared/events.js";
import { listenForObsSetup } from "./obs-setup-handler.js";
import type { setupObs } from "./obs-setup.js";

async function harness(setup: typeof setupObs) {
  const config = await loadConfig({ envPath: "/missing/twitchy-test.env" });
  config.env.OBS_WS_PASSWORD = "hunter2-obs";
  const bus = new EventBus();
  const results: Array<EventMap["obs.setupResult"]> = [];
  bus.on("obs.setupResult", (result) => { results.push(result); });
  const stop = listenForObsSetup(bus, config, setup);
  return { bus, results, stop, config };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("answers obs.setup with only the lines that changed something", async () => {
  let received: { contentScene?: string } | undefined;
  const { bus, results, config } = await harness(async (_config, options) => {
    received = options;
    return {
      changes: ["Found scene: Twitchy Content", "Created scene: Twitchy Raw", "Configured delay filter Twitchy Render Delay 1 on Twitchy Raw: 500 ms", "Created hidden mask: Twitchy Mask 01"],
      canvas: { width: 1920, height: 1080 },
    };
  });
  bus.emit("obs.setup", { requestId: "req-1", contentScene: "Coding" });
  await settle();
  assert.deepEqual(received, { contentScene: "Coding" });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.requestId, "req-1");
  assert.equal(results[0]!.ok, true);
  assert.deepEqual(results[0]!.changes?.slice(0, 2), ["Created scene: Twitchy Raw", "Created hidden mask: Twitchy Mask 01"]);
  assert.match(results[0]!.changes?.at(-1) ?? "", new RegExp(`Twitchy Broadcast.*${config.delayMs} ms`));
});

test("says so when everything was already set up", async () => {
  const { bus, results } = await harness(async () => ({ changes: ["Found scene: Twitchy Content"], canvas: { width: 1920, height: 1080 } }));
  bus.emit("obs.setup", { requestId: "req-2" });
  await settle();
  assert.equal(results[0]!.changes?.[0], "Everything was already set up.");
});

test("reports failures without the OBS password", async () => {
  const { bus, results } = await harness(async () => { throw new Error("OBS setup failed: auth hunter2-obs rejected"); });
  bus.emit("obs.setup", { requestId: "req-3" });
  await settle();
  assert.equal(results[0]!.ok, false);
  assert.ok(results[0]!.error);
  assert.doesNotMatch(results[0]!.error!, /hunter2/);
});

test("refuses a second setup while one is running, then accepts again", async () => {
  let finish!: () => void;
  const { bus, results } = await harness(() => new Promise((resolve) => {
    finish = () => resolve({ changes: [], canvas: { width: 1920, height: 1080 } });
  }));
  bus.emit("obs.setup", { requestId: "first" });
  bus.emit("obs.setup", { requestId: "second" });
  await settle();
  assert.deepEqual(results.map((result) => [result.requestId, result.ok]), [["second", false]]);
  finish();
  await settle();
  assert.deepEqual(results.map((result) => [result.requestId, result.ok]), [["second", false], ["first", true]]);
  bus.emit("obs.setup", { requestId: "third" });
  await settle();
  finish();
  await settle();
  assert.equal(results.at(-1)!.requestId, "third");
});

test("stops listening when stopped", async () => {
  let calls = 0;
  const { bus, results, stop } = await harness(async () => { calls += 1; return { changes: [], canvas: { width: 1920, height: 1080 } }; });
  stop();
  bus.emit("obs.setup", { requestId: "req-4" });
  await settle();
  assert.equal(calls, 0);
  assert.equal(results.length, 0);
});
