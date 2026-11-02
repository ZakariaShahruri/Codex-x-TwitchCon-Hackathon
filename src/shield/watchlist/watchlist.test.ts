import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventBus } from "../../shared/bus.js";
import { createWatchlistService } from "./service.js";
import { WatchlistStore } from "./store.js";

test("private watchlist path is injectable, private state carries labels only, and config.updated persists additions/removals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "twitchy-watchlist-"));
  const privatePath = join(directory, "private", "custom.json");
  const bus = new EventBus();
  const states: Array<{ watchlist: Array<{ id: string; label: string }>; rules: unknown[] }> = [];
  bus.on("private.state", ({ watchlist, rules }) => { states.push({ watchlist, rules }); });
  const service = await createWatchlistService(bus, privatePath);
  try {
    assert.equal(states.length, 1, "publishes the initial value-free state");
    assert.deepEqual(states[0]?.watchlist, []);
    const privateValue = "742 Evergreen Terrace";
    bus.emit("config.updated", { watchlist: { add: [{ label: "home address", value: privateValue }] } });
    await service.flush();
    assert.equal(states.length, 2);
    assert.equal(states[1]?.watchlist[0]?.label, "home address");
    assert.ok(states[1]?.watchlist[0]?.id);
    assert.deepEqual(states[1]?.rules, []);
    assert.equal(JSON.stringify(states).includes(privateValue), false, "private values never enter private.state");

    const stored = await readFile(privatePath, "utf8");
    assert.ok(stored.includes(privateValue), "the value is persisted only in the private file");
    assert.equal((await stat(privatePath)).mode & 0o777, 0o600);
    const id = states[1]!.watchlist[0]!.id;
    bus.emit("config.updated", { watchlist: { removeIds: [id] } });
    await service.flush();
    assert.deepEqual(states[2]?.watchlist, []);
    assert.deepEqual(JSON.parse(await readFile(privatePath, "utf8")).watchlist, []);
  } finally {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("private store preserves other private document fields and rejects a label that exposes a value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "twitchy-watchlist-"));
  const privatePath = join(directory, "twitchy.private.json");
  const rules = [{ id: "r1", description: "family name", terms: ["private"], patterns: [] }];
  await writeFile(privatePath, JSON.stringify({ watchlist: [], rules, future: { kept: true } }));
  try {
    const store = await WatchlistStore.open(privatePath);
    await assert.rejects(store.add({ label: "Jane Doe", value: "Jane Doe" }), /label must not reveal/u);
    assert.deepEqual(store.entries, []);
    await store.add({ label: "family contact", value: "Jane Doe" });
    const saved = JSON.parse(await readFile(privatePath, "utf8"));
    assert.deepEqual(saved.rules, rules);
    assert.deepEqual(saved.future, { kept: true });
    assert.equal(saved.watchlist[0].label, "family contact");
    assert.equal(saved.watchlist[0].value, "Jane Doe");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
