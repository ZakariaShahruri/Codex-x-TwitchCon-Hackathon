import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { WatchlistStore } from "../src/shield/watchlist/store.js";

async function promptLabel(): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try { return await readline.question("Safe label (for example, home address): "); }
  finally { readline.close(); }
}

async function promptHiddenValue(): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") throw new Error("Adding an entry requires an interactive terminal.");
  stdout.write("Private value (input hidden): ");
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") { finish(new Error("Input cancelled.")); return; }
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\u007f" || character === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (character >= " ") value += character;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const [command, id, ...extra] = process.argv.slice(2);
  if (command === "list" && id === undefined && extra.length === 0) {
    const store = await WatchlistStore.open();
    if (!store.labels.length) { console.log("Watchlist is empty."); return; }
    for (const entry of store.labels) console.log(`${entry.id}  ${entry.label}`);
    return;
  }
  if (command === "remove" && id && extra.length === 0) {
    const store = await WatchlistStore.open();
    if (!store.labels.some((entry) => entry.id === id)) throw new Error("No watchlist entry has that ID.");
    await store.remove(id);
    console.log("Watchlist entry removed.");
    return;
  }
  if (command === "add" && id === undefined && extra.length === 0) {
    const label = await promptLabel();
    const value = await promptHiddenValue();
    const store = await WatchlistStore.open();
    await store.add({ label, value });
    console.log("Watchlist entry added.");
    return;
  }
  throw new Error("Usage: npm run watchlist -- add | list | remove <id>. Add always prompts for its value with hidden input.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(message === "Input cancelled." ? "Watchlist entry cancelled." : `Watchlist command failed: ${message}`);
  process.exitCode = 1;
});
