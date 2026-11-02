import type { EventMap } from "../../shared/events.js";
import type { EventBus } from "../../shared/bus.js";
import { ruleSummary, WatchlistStore, type StoredRule, type WatchlistEntry } from "./store.js";

export interface WatchlistService {
  readonly entries: readonly WatchlistEntry[];
  readonly rules: readonly StoredRule[];
  /** Bumps on every watchlist or rule change, so the capture loop re-runs OCR on an unchanged frame. */
  readonly revision: number;
  addRule(rule: Omit<StoredRule, "id">): Promise<StoredRule>;
  flush(): Promise<void>;
  stop(): Promise<void>;
}

/** Loads local values and compiled rules, exposes labels and rule summaries only, and serializes dashboard writes. */
export async function createWatchlistService(bus: EventBus, filePath = "twitchy.private.json"): Promise<WatchlistService> {
  const store = await WatchlistStore.open(filePath);
  let revision = 0;
  let entries = store.entries;
  let rules = store.rules;
  let queue: Promise<void> = Promise.resolve();
  const publish = () => bus.emit("private.state", { watchlist: store.labels, rules: rules.map(ruleSummary), at: Date.now() });
  publish();
  // src/index.ts starts the web track after shield, so replay once after track startup for its initial snapshot.
  const startupReplay = setTimeout(publish, 1_000);
  startupReplay.unref();

  const listener = (update: EventMap["config.updated"]): Promise<void> => {
    if (update.watchlist) {
      const next = queue.then(async () => {
        await store.apply(update.watchlist!);
        entries = store.entries;
        revision += 1;
        publish();
      });
      queue = next.catch(() => { console.error("Watchlist update rejected; private state was not changed."); });
    }
    if (update.removedRuleIds?.length) {
      const next = queue.then(async () => {
        await store.applyRules({ removeIds: update.removedRuleIds });
        rules = store.rules;
        revision += 1;
        publish();
      });
      queue = next.catch(() => { console.error("Rule removal rejected; private state was not changed."); });
    }
    return queue;
  };
  bus.on("config.updated", listener);

  return {
    get entries() { return entries; },
    get rules() { return rules; },
    get revision() { return revision; },
    addRule: (rule) => {
      const next = queue.then(async () => {
        const [added] = await store.applyRules({ add: [rule] });
        rules = store.rules;
        revision += 1;
        publish();
        return added!;
      });
      queue = next.then(() => undefined, () => undefined);
      return next;
    },
    flush: async () => { await queue; await store.flush(); },
    stop: async () => { clearTimeout(startupReplay); bus.off("config.updated", listener); await queue; await store.flush(); },
  };
}
