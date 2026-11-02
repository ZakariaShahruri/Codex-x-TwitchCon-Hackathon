import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { browserEvents, type EventMap } from "../shared/events.js";
import type { EventBus } from "../shared/bus.js";
import type { Config } from "../shared/config.js";
import type { StartTrack } from "../shared/track.js";
import { startMockShield } from "./mock-shield.js";

type Role = "overlay" | "dashboard";
type BrowserEvent = typeof browserEvents[number];
type WireEvent = { event: BrowserEvent; payload: EventMap[BrowserEvent] };
/** Sent once when a page connects, so a reloaded page shows the current state without replaying (and re-animating) old events. */
export type WireSnapshot = {
  snapshot: { shieldState?: EventMap["shield.state"]; leakCount: number; privateState?: EventMap["private.state"] };
};
const root = fileURLToPath(new URL("../../", import.meta.url));
const roleEvents: Record<Role, ReadonlySet<BrowserEvent>> = {
  overlay: new Set(["leak.detected", "leak.cleared", "shield.state"]),
  dashboard: new Set(browserEvents),
};

function sendJson(socket: WebSocket, message: WireEvent | WireSnapshot): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/** Turns a failed listen into one actionable message; the caller exits instead of serving stale pages. */
function bindError(port: number, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") {
    return new Error(`Port ${port} on 127.0.0.1 is already in use, probably by another npm run dev or npm run demo:events that is still running. Find it with: lsof -iTCP:${port} -sTCP:LISTEN`);
  }
  return new Error(`Web server could not listen on 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`);
}

export const start: StartTrack = async (bus, config) => {
  const sockets = new Set<WebSocket>();
  const removers: (() => void)[] = [];
  let server: Server | undefined;
  let wsServer: WebSocketServer | undefined;
  let stopped = false;
  let latestState: EventMap["shield.state"] | undefined;
  let latestPrivate: EventMap["private.state"] | undefined;
  let latestLeakCount = 0;

  const subscribe = <K extends BrowserEvent>(event: K, listener: (payload: EventMap[K]) => void) => {
    bus.on(event, listener);
    removers.push(() => bus.off(event, listener));
  };
  for (const event of browserEvents) {
    subscribe(event, (payload) => {
      if (event === "shield.state") latestState = payload as EventMap["shield.state"];
      if (event === "private.state") latestPrivate = payload as EventMap["private.state"];
      if (event === "leak.detected") latestLeakCount = (payload as EventMap["leak.detected"]).totalBlocked;
      for (const socket of sockets) {
        const role = (socket as WebSocket & { twitchyRole?: Role }).twitchyRole;
        if (role && roleEvents[role].has(event)) sendJson(socket, { event, payload });
      }
    });
  }
  const stopMockShield = startMockShield(bus, config.armOnStart);

  const mimeTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };
  server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
      const role: Role | undefined = urlPath.startsWith("/overlay/") ? "overlay" : urlPath.startsWith("/dashboard/") ? "dashboard" : undefined;
      if (!role) { res.writeHead(404).end("Not found"); return; }
      const base = join(root, "web", role);
      const requested = urlPath.slice(role.length + 2);
      const relative = normalize(requested === "" || requested.endsWith("/") ? `${requested}index.html` : requested).replace(/^[/\\]+/, "");
      const path = join(base, relative);
      if (!path.startsWith(`${base}/`) && path !== base) { res.writeHead(403).end("Forbidden"); return; }
      if (!(await stat(path)).isFile()) { res.writeHead(404).end("Not found"); return; }
      res.writeHead(200, { "content-type": mimeTypes[extname(path)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(await readFile(path));
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end("Not found");
    }
  });
  wsServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const role: Role | undefined = path === "/ws/overlay" ? "overlay" : path === "/ws/dashboard" ? "dashboard" : undefined;
    if (!role) { socket.destroy(); return; }
    wsServer?.handleUpgrade(req, socket, head, (client) => {
      (client as WebSocket & { twitchyRole?: Role }).twitchyRole = role;
      sockets.add(client);
      client.on("close", () => sockets.delete(client));
      sendJson(client, { snapshot: {
        shieldState: latestState,
        leakCount: latestLeakCount,
        privateState: role === "dashboard" ? latestPrivate : undefined,
      } });
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server?.off("listening", onListen); reject(error); };
      const onListen = () => { server?.off("error", onError); resolve(); };
      server?.once("error", onError);
      server?.once("listening", onListen);
      server?.listen(config.webPort, "127.0.0.1");
    });
    console.log(`web server listening at http://127.0.0.1:${config.webPort}/overlay/`);
  } catch (error) {
    for (const remove of removers) remove();
    stopMockShield();
    wsServer.close();
    throw bindError(config.webPort, error);
  }

  return async () => {
    if (stopped) return;
    stopped = true;
    for (const remove of removers) remove();
    for (const socket of sockets) socket.close();
    sockets.clear();
    await new Promise<void>((resolve) => wsServer?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  };
};
