// Steps the stage through scenes on a fixed clock and logs each switch to video/footage/sync.log, so the
// shield-off and shield-on passes line up in the edit. Usage: tsx video/build/run-stage.mts <label> [scene...]
import { appendFile, mkdir } from "node:fs/promises";

const SCENE_MS = 5000;
const GAP_MS = 1500;
const [label = "pass", ...requested] = process.argv.slice(2);
const scenes = requested.length ? requested : ["env", "address", "qr", "card", "seed", "ip"];
const footage = new URL("../footage/", import.meta.url);
await mkdir(footage, { recursive: true });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const go = async (scene: string) => {
  await fetch(`http://127.0.0.1:4199/scene/${scene}`, { method: "POST" });
  await appendFile(new URL("sync.log", footage), `${new Date().toISOString()} ${label} ${scene}\n`);
};

for (const scene of scenes) {
  await go(scene);
  await sleep(SCENE_MS);
  await go("idle");
  await sleep(GAP_MS);
}
console.log(`${label}: ${scenes.join(", ")}`);
