import test from "node:test";
import assert from "node:assert/strict";
import { browserCommands, browserEvents } from "./events.js";

test("watchlist values never reach a browser", () => {
  assert.equal((browserEvents as readonly string[]).includes("config.updated"), false);
});

test("browser pages may send only the dashboard commands", () => {
  assert.deepEqual([...browserCommands].sort(), ["config.updated", "obs.setup", "rules.compile", "shield.command"]);
});

test("nothing a browser sends is echoed back to browsers", () => {
  for (const command of browserCommands) assert.equal((browserEvents as readonly string[]).includes(command), false, command);
});

test("the lists have no duplicates", () => {
  assert.equal(new Set(browserEvents).size, browserEvents.length);
  assert.equal(new Set(browserCommands).size, browserCommands.length);
});
