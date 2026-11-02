import { loadConfig } from "../src/shared/config.js";
import { setupObs } from "../src/shield/obs-setup.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let contentScene: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--content-scene" && args[index + 1]) {
      contentScene = args[++index];
    } else if (args[index] === "--help" || args[index] === "-h") {
      console.log("Usage: npm run obs:setup [-- --content-scene \"OBS scene name\"]");
      return;
    } else {
      throw new Error(`Unknown or incomplete argument: ${args[index]}. Use --help.`);
    }
  }
  const config = await loadConfig();
  const { changes, canvas } = await setupObs(config, { contentScene });
  for (const line of changes) console.log(`• ${line}`);
  console.log("\nManual OBS steps:");
  console.log("1. Set the scene sent to stream to Twitchy Broadcast when you are ready to broadcast through Twitchy.");
  console.log(`2. Set Sync Offset on each active audio source to about ${config.delayMs} ms (Render Delay is video only).`);
  console.log("3. Verify stacked delay with a stopwatch before streaming; see docs/architecture.md §9.");
  console.log(`Canvas: ${canvas.width}×${canvas.height}. Program scene was not changed.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
