import assert from "node:assert/strict";
import test from "node:test";
import { ShieldStateMachine, type ShieldStateSnapshot } from "./shield-state.js";

test("starts armed or off from armOnStart and publishes state transitions", () => {
  const states: ShieldStateSnapshot[] = [];
  const armed = new ShieldStateMachine(true, (state) => states.push(state), () => 10);
  armed.start();
  armed.command("off");
  armed.command("on");
  assert.deepEqual(states.map((state) => state.status), ["armed", "off", "armed"]);

  const offStates: ShieldStateSnapshot[] = [];
  const off = new ShieldStateMachine(false, (state) => offStates.push(state));
  off.start();
  assert.equal(offStates[0]!.status, "off");
});

test("panic remains available while degraded and unblur returns to the degraded state", () => {
  const states: ShieldStateSnapshot[] = [];
  const machine = new ShieldStateMachine(true, (state) => states.push(state));
  machine.start();
  machine.degrade("OBS disconnected; retrying in 500ms");
  machine.command("panic");
  assert.equal(machine.isPanicked, true);
  assert.equal(states.at(-1)!.status, "panic");
  assert.equal(states.at(-1)!.reason, "OBS disconnected; retrying in 500ms");
  machine.command("unblur");
  assert.equal(states.at(-1)!.status, "degraded");
  machine.recover();
  assert.equal(states.at(-1)!.status, "armed");
});

test("off and on change arming without clearing a panic or degradation", () => {
  const states: ShieldStateSnapshot[] = [];
  const machine = new ShieldStateMachine(true, (state) => states.push(state));
  machine.start();
  machine.degrade("OCR unavailable");
  machine.command("off");
  assert.equal(machine.isArmed, false);
  assert.equal(states.at(-1)!.status, "degraded");
  machine.command("panic");
  machine.command("on");
  assert.equal(machine.isArmed, true);
  assert.equal(states.at(-1)!.status, "panic");
  machine.command("unblur");
  assert.equal(states.at(-1)!.status, "degraded");
});
