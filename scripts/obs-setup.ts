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
  await setupObs(await loadConfig(), { contentScene });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
