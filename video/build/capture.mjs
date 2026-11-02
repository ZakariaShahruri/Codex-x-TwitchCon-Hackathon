// Renders an animation page frame by frame in headless Chrome and encodes it, so animations are smooth and
// deterministic no matter how slow a frame is to draw. The page sets window.DURATION (s) and window.render(t),
// which may return a promise. Usage: node video/build/capture.mjs <page.html> <out.mp4> [fps]
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const [pagePath, outPath, fpsArg] = process.argv.slice(2);
// "--at=1,6.5,10" instead of an fps renders just those moments as a contact sheet at outPath (a .png), for checking.
const AT = fpsArg?.startsWith("--at=") ? fpsArg.slice(5).split(",").map(Number) : undefined;
const FPS = AT ? 30 : Number(fpsArg ?? 30);
const PORT = 9333 + Math.floor(Math.random() * 500);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = mkdtempSync(join(tmpdir(), "twitchy-capture-"));
const frames = mkdtempSync(join(tmpdir(), "twitchy-frames-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1920,1080",
  "--hide-scrollbars", "--force-device-scale-factor=1", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required",
  "--allow-file-access-from-files", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json(), () => undefined);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  await new Promise((r) => ws.once("open", r));
  let id = 0;
  const pending = new Map();
  ws.on("message", (raw) => { const msg = JSON.parse(raw); pending.get(msg.id)?.(msg); pending.delete(msg.id); });
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 600));
    return res.result?.result?.value;
  };
  await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send("Page.enable");
  await send("Page.navigate", { url: `file://${resolve(pagePath)}` });
  for (let i = 0; i < 100 && !(await evaluate("window.READY === true").catch(() => false)); i++) await sleep(200);
  const duration = await evaluate("window.DURATION");
  const times = AT ?? Array.from({ length: Math.round(duration * FPS) }, (_, f) => f / FPS);
  const total = times.length;
  const started = Date.now();
  for (let f = 0; f < total; f++) {
    await evaluate(`Promise.resolve(window.render(${times[f].toFixed(5)})).then(() => new Promise(r => requestAnimationFrame(() => r(1))))`);
    const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
    writeFileSync(join(frames, `${String(f).padStart(5, "0")}.jpg`), Buffer.from(shot.result.data, "base64"));
    if (f % 60 === 0) process.stdout.write(`\r${f}/${total} frames (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }
  ws.close();
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  if (AT) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(frames, "%05d.jpg"), "-vf", `scale=640:-1,tile=${Math.min(4, total)}x${Math.ceil(total / 4)}`, "-frames:v", "1", outPath]);
  else execFileSync("ffmpeg", ["-v", "error", "-y", "-framerate", String(FPS), "-i", join(frames, "%05d.jpg"), "-c:v", "libx264", "-preset", "veryfast",
    "-crf", "16", "-pix_fmt", "yuv420p", outPath]);
  console.log(`\n${outPath}: ${total} frames`);
} finally {
  chrome.kill();
  await new Promise((r) => chrome.once("exit", r));
  rmSync(frames, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
