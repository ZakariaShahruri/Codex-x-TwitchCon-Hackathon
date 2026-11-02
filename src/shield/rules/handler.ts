import type { EventBus } from "../../shared/bus.js";
import type { Config } from "../../shared/config.js";
import type { EventMap } from "../../shared/events.js";
import { ruleSummary } from "../watchlist/store.js";
import type { WatchlistService } from "../watchlist/service.js";
import { compileRule } from "./compiler.js";

/** Answers the dashboard's "Make a rule": compile once, save, then reply with the summary only. One compile at a time. */
export function listenForRuleCompiles(
  bus: EventBus,
  config: Config,
  privateState: Pick<WatchlistService, "addRule">,
  compile: typeof compileRule = compileRule,
): () => void {
  let running = false;

  const listener = async ({ requestId, text }: EventMap["rules.compile"]): Promise<void> => {
    if (running) {
      bus.emit("rules.compiled", { requestId, ok: false, error: "Twitchy is still learning the previous rule." });
      return;
    }
    running = true;
    try {
      const result = await compile(text, { apiKey: config.env.OPENAI_API_KEY, model: config.rulesModel });
      if ("error" in result) {
        bus.emit("rules.compiled", { requestId, ok: false, error: result.error });
        return;
      }
      const saved = await privateState.addRule(result.rule);
      bus.emit("rules.compiled", { requestId, ok: true, rules: [ruleSummary(saved)] });
      console.log(`Rule saved: ${saved.description} (${ruleSummary(saved).detector}).`);
    } catch {
      bus.emit("rules.compiled", { requestId, ok: false, error: "The rule could not be saved." });
    } finally {
      running = false;
    }
  };

  bus.on("rules.compile", listener);
  return () => bus.off("rules.compile", listener);
}
