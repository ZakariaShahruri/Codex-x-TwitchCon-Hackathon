import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "tools/ocr-vision/.build/twitchy-ocr");
const source = resolve(root, "tools/ocr-vision/main.swift");
const optional = process.argv.includes("--if-supported");

if (process.platform !== "darwin") {
  const message = "Apple Vision OCR helper requires macOS and the Vision framework.";
  if (optional) {
    console.log(`Skipping OCR helper build: ${message}`);
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
}

mkdirSync(dirname(output), { recursive: true });
const result = spawnSync("swiftc", ["-O", "-framework", "Vision", "-framework", "ImageIO", "-o", output, source], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
