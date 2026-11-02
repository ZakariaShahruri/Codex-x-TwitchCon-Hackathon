// Narration with OpenAI TTS: one WAV per script line, so captions can follow each line exactly.
// Usage: tsx video/build/tts.mts <voice> [sceneId...]   → video/audio/<voice>/<scene>-<n>.wav
// Only the public script text is sent. The key is read from .env and never printed.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const env = await readFile(new URL(".env", root), "utf8");
const apiKey = env.match(/^OPENAI_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!apiKey) throw new Error("OPENAI_API_KEY missing from .env");

const script = JSON.parse(await readFile(new URL("video/script.json", root), "utf8")) as {
  voiceInstructions: string; scenes: Array<{ id: string; lines: string[] }>;
};
const [voice = "cedar", ...only] = process.argv.slice(2);
const folder = new URL(`video/audio/${voice}/`, root);
await mkdir(folder, { recursive: true });

for (const scene of script.scenes.filter((item) => !only.length || only.includes(item.id))) {
  await Promise.all(scene.lines.map(async (input, index) => {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice, input, instructions: script.voiceInstructions, response_format: "wav" }),
    });
    if (!response.ok) throw new Error(`TTS failed for ${scene.id}-${index} (HTTP ${response.status})`);
    await writeFile(new URL(`${scene.id}-${index}.wav`, folder), Buffer.from(await response.arrayBuffer()));
  }));
  console.log(`${voice}: ${scene.id} (${scene.lines.length} lines)`);
}
