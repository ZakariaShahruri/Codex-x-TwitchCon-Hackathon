import { EventBus } from "./shared/bus.js";
import { loadConfig } from "./shared/config.js";
import { start as startShield } from "./shield/index.js";
import { start as startTwitch } from "./twitch/index.js";
import { start as startWeb } from "./web/index.js";

const config = await loadConfig();
const bus = new EventBus();
startShield(bus, config);
startTwitch(bus, config);
startWeb(bus, config);
console.log("Twitchy ready.");
await new Promise<void>((resolve) => {
  const keepAlive = setInterval(() => {}, 60_000);
  process.once("SIGINT", () => {
    clearInterval(keepAlive);
    console.log("Shutting down Twitchy.");
    resolve();
  });
});
