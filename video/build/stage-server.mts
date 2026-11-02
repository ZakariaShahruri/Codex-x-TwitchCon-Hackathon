// Serves the stage page to an OBS browser source and lets the shoot switch scenes remotely:
//   tsx video/build/stage-server.mts            (port 4199)
//   curl -X POST localhost:4199/scene/env        → the page shows that scene within ~100 ms
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname } from "node:path";

const PORT = 4199;
const root = new URL("../../", import.meta.url);
const files: Record<string, URL> = {
  "/": new URL("video/stage/index.html", root),
  "/stage-data.js": new URL("video/renders/stage-data.js", root),
  "/qr-login.png": new URL("tools/gauntlet/qr-login.png", root),
};
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png" };
let scene = { name: "idle", at: Date.now() };

createServer(async (req, res) => {
  const path = req.url?.split("?")[0] ?? "/";
  if (req.method === "POST" && path.startsWith("/scene/")) {
    scene = { name: path.slice("/scene/".length), at: Date.now() };
    res.end(JSON.stringify(scene));
    return;
  }
  if (path === "/scene") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(scene));
    return;
  }
  const file = files[path];
  if (!file) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[extname(file.pathname)] ?? "text/plain", "cache-control": "no-store" });
  res.end(await readFile(file));
}).listen(PORT, "127.0.0.1", () => console.log(`stage on http://127.0.0.1:${PORT}/`));
