import type { EventBus } from "../shared/bus.js";
import type { Config } from "../shared/config.js";
import type { EventMap } from "../shared/events.js";
import { setupObs } from "./obs-setup.js";

/** Lines that only confirm what was already there; the dashboard shows what changed. */
const UNCHANGED = /^(Found|Configured|Kept) /;

/** Answers the dashboard's "Set up OBS" button with the same idempotent setup as `npm run obs:setup`. */
export function listenForObsSetup(bus: EventBus, config: Config, setup: typeof setupObs = setupObs): () => void {
  let running = false;

  const listener = async ({ requestId, contentScene }: EventMap["obs.setup"]): Promise<void> => {
    if (running) {
      bus.emit("obs.setupResult", { requestId, ok: false, error: "OBS setup is already running." });
      return;
    }
    running = true;
    try {
      const { changes } = await setup(config, { contentScene });
      const changed = changes.filter((line) => !UNCHANGED.test(line));
      bus.emit("obs.setupResult", {
        requestId,
        ok: true,
        changes: [
          ...(changed.length ? changed : ["Everything was already set up."]),
          `Next: stream the Twitchy Broadcast scene and set audio Sync Offset to about ${config.delayMs} ms.`,
        ],
      });
    } catch (error) {
      bus.emit("obs.setupResult", { requestId, ok: false, error: withoutPassword(error, config.env.OBS_WS_PASSWORD) });
    } finally {
      running = false;
    }
  };

  bus.on("obs.setup", listener);
  return () => bus.off("obs.setup", listener);
}

function withoutPassword(error: unknown, password: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  return password ? message.split(password).join("•••") : message;
}
