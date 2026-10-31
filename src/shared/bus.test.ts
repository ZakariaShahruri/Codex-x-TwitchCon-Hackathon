import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "./bus.js";

test("delivers typed payloads to listeners", () => {
  const bus = new EventBus();
  let seen = 0;
  bus.on("shield.state", (event) => { seen = event.at; });
  bus.emit("shield.state", { status: "armed", at: 42 });
  assert.equal(seen, 42);
});

test("isolates listener errors and continues emitting", () => {
  const bus = new EventBus();
  let called = false;
  const oldError = console.error;
  console.error = () => {};
  try {
    bus.on("leak.cleared", () => { throw new Error("listener failure"); });
    bus.on("leak.cleared", () => { called = true; });
    assert.doesNotThrow(() => bus.emit("leak.cleared", { id: "x", at: 1 }));
  } finally { console.error = oldError; }
  assert.equal(called, true);
});

test("isolates rejected async listeners", async () => {
  const bus = new EventBus();
  const errors: unknown[] = [];
  const oldError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args[1]); };
  try {
    bus.on("leak.cleared", async () => { throw new Error("twitch api down"); });
    bus.emit("leak.cleared", { id: "x", at: 1 });
    await new Promise((resolve) => setImmediate(resolve));
  } finally { console.error = oldError; }
  assert.equal((errors[0] as Error).message, "twitch api down");
});

test("off removes a listener", () => {
  const bus = new EventBus();
  let count = 0;
  const listener = () => { count += 1; };
  bus.on("leak.cleared", listener);
  bus.off("leak.cleared", listener);
  bus.emit("leak.cleared", { id: "x", at: 1 });
  assert.equal(count, 0);
});
