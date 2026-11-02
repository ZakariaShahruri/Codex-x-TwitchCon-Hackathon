import type { EventBus } from "../shared/bus.js";
import type { EventMap } from "../shared/events.js";

/** Development-only stand-in for Track A, explicitly gated by TWITCHY_MOCK_SHIELD=1. */
export function startMockShield(bus: EventBus, armOnStart = true): () => void {
  if (process.env.TWITCHY_MOCK_SHIELD !== "1") return () => {};
  let armed = armOnStart;
  let panicked = false;
  const currentStatus = (): EventMap["shield.state"]["status"] => panicked ? "panic" : armed ? "armed" : "off";
  bus.emit("shield.state", { status: currentStatus(), at: Date.now() });
  const listener = (command: EventMap["shield.command"]) => {
    if (command.action === "on") armed = true;
    else if (command.action === "off") armed = false;
    else if (command.action === "panic") panicked = true;
    else if (command.action === "unblur") panicked = false;
    bus.emit("shield.state", { status: currentStatus(), at: Date.now() });
  };
  bus.on("shield.command", listener);
  console.warn("[dev] TWITCHY_MOCK_SHIELD=1: Track A shield commands are mocked; do not use for a live stream.");
  return () => bus.off("shield.command", listener);
}
