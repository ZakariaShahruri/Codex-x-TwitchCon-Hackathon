import type { EventBus } from "../shared/bus.js";
import type { Config } from "../shared/config.js";

export function start(_bus: EventBus, _config: Config): void { console.log("track B ready"); }
