import type { EventBus } from "./bus.js";
import type { Config } from "./config.js";

/** Closes everything a track opened (sockets, child processes, timers). */
export type StopTrack = () => Promise<void>;

/** Every track entry point: start, subscribe to the bus, and return how to stop. */
export type StartTrack = (bus: EventBus, config: Config) => Promise<StopTrack>;
