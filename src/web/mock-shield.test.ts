import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../shared/bus.js";
import { startMockShield } from "./mock-shield.js";

test("mock Track A is inert unless TWITCHY_MOCK_SHIELD=1", () => {
  const previous = process.env.TWITCHY_MOCK_SHIELD;
  const bus = new EventBus();
  const states: string[] = [];
  bus.on("shield.state", ({ status }) => { states.push(status); });

  delete process.env.TWITCHY_MOCK_SHIELD;
  const stopDisabled = startMockShield(bus);
  bus.emit("shield.command", { action: "panic", by: "viewer", at: 1 });
  assert.deepEqual(states, []);
  stopDisabled();

  process.env.TWITCHY_MOCK_SHIELD = "1";
  const stopEnabled = startMockShield(bus);
  bus.emit("shield.command", { action: "panic", by: "salina", at: 2 });
  bus.emit("shield.command", { action: "unblur", by: "salina", at: 3 });
  assert.deepEqual(states, ["armed", "panic", "armed"]);
  stopEnabled();
  bus.emit("shield.command", { action: "off", by: "salina", at: 4 });
  assert.deepEqual(states, ["armed", "panic", "armed"]);

  if (previous === undefined) delete process.env.TWITCHY_MOCK_SHIELD;
  else process.env.TWITCHY_MOCK_SHIELD = previous;
});
