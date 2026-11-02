import type { EventMap } from "../../shared/events.js";
import type { EventBus } from "../../shared/bus.js";
import { WatchlistStore, type WatchlistEntry } from "./store.js";

export interface WatchlistService {
  readonly entries: readonly WatchlistEntry[];
  readonly revision: number;
  flush(): Promise<void>;
  stop(): Promise<void>;
}

/** Loads local values, exposes labels only, and serializes dashboard writes from config.updated. */
export async function createWatchlistService(bus: EventBus, filePath = "twitchy.private.json"): Promise<WatchlistService> {
  const store = await WatchlistStore.open(filePath);
  let revision = 0;
  let entries = store.entries;
  let queue: Promise<void> = Promise.resolve();
  const publish = () => bus.emit("private.state", { watchlist: store.labels, rules: [], at: Date.now() });
  publish();
  // src/index.ts starts the web track after shield, so replay once after track startup for its initial snapshot.
  const startupReplay = setTimeout(publish, 1_000);
  startupReplay.unref();

  const listener = (update: EventMap["config.updated"]): Promise<void> => {
    if (!update.watchlist) return Promise.resolve();
    const next = queue.then(async () => {
      await store.apply(update.watchlist!);
      entries = store.entries;
      revision += 1;
      publish();
    });
    queue = next.catch(() => { console.error("Watchlist update rejected; private state was not changed."); });
    return queue;
  };
  bus.on("config.updated", listener);

  return {
    get entries() { return entries; },
    get revision() { return revision; },
    flush: async () => { await queue; await store.flush(); },
    stop: async () => { clearTimeout(startupReplay); bus.off("config.updated", listener); await queue; await store.flush(); },
  };
}
