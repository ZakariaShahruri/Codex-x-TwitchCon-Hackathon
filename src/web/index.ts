import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { browserCommands, browserEvents, type EventMap, type LeakKind } from "../shared/events.js";
import type { EventBus } from "../shared/bus.js";
import type { Config } from "../shared/config.js";
import type { StartTrack } from "../shared/track.js";

type Role = "overlay" | "dashboard";
type BrowserEvent = typeof browserEvents[number];
type WireEvent = { event: BrowserEvent; payload: EventMap[BrowserEvent] };
type BrowserCommand = typeof browserCommands[number];
/** Sent once when a page connects, so a reloaded page shows the current state without replaying (and re-animating) old events. */
export type WireSnapshot = {
  snapshot: { shieldState?: EventMap["shield.state"]; leakCount: number; privateState?: EventMap["private.state"] };
};
const root = fileURLToPath(new URL("../../", import.meta.url));
const roleEvents: Record<Role, ReadonlySet<BrowserEvent>> = {
  overlay: new Set(["leak.detected", "leak.cleared", "shield.state", "chat.cheer"]),
  dashboard: new Set(browserEvents),
};
const MAX_BROWSER_MESSAGE_BYTES = 16 * 1024;
const leakKinds = new Set<LeakKind>(["api_key", "email", "password", "phone", "card", "ip", "seed_phrase", "qr_code", "watchlist", "custom_rule", "sensitive_region"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isText(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maxLength && (allowEmpty || value.trim().length > 0);
}
function isRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,80}$/.test(value);
}
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function validBrowserCommand(event: unknown, payload: unknown): event is BrowserCommand {
  if (!browserCommands.includes(event as BrowserCommand) || !isRecord(payload)) return false;
  switch (event) {
    case "shield.command":
      return hasOnlyKeys(payload, ["action", "by", "at"]) && ["on", "off", "panic", "unblur"].includes(payload.action as string) && isText(payload.by, 60) && Number.isFinite(payload.at);
    case "config.updated": {
      const allowed = new Set(["watchlist", "enabledDetectors", "sensitiveRegions", "removedRuleIds"]);
      if (Object.keys(payload).some((key) => !allowed.has(key))) return false;
      if (payload.watchlist !== undefined) {
        if (!isRecord(payload.watchlist) || Object.keys(payload.watchlist).some((key) => key !== "add" && key !== "removeIds")) return false;
        const watchlist = payload.watchlist;
        if (watchlist.add !== undefined && (!Array.isArray(watchlist.add) || watchlist.add.length > 32 || watchlist.add.some((item) => !isRecord(item) || Object.keys(item).some((key) => key !== "label" && key !== "value") || !isText(item.label, 80) || !isText(item.value, 512)))) return false;
        if (watchlist.removeIds !== undefined && (!Array.isArray(watchlist.removeIds) || watchlist.removeIds.length > 64 || watchlist.removeIds.some((id) => !isText(id, 100)))) return false;
      }
      if (payload.enabledDetectors !== undefined && (!Array.isArray(payload.enabledDetectors) || payload.enabledDetectors.length > leakKinds.size || payload.enabledDetectors.some((kind) => typeof kind !== "string" || !leakKinds.has(kind as LeakKind)))) return false;
      if (payload.sensitiveRegions !== undefined && (!Array.isArray(payload.sensitiveRegions) || payload.sensitiveRegions.length > 64 || payload.sensitiveRegions.some((box) => !isRecord(box) || Object.keys(box).some((key) => !["x", "y", "w", "h"].includes(key)) || ["x", "y", "w", "h"].some((key) => !Number.isFinite(box[key])) || Number(box.w) <= 0 || Number(box.h) <= 0))) return false;
      if (payload.removedRuleIds !== undefined && (!Array.isArray(payload.removedRuleIds) || payload.removedRuleIds.length > 64 || payload.removedRuleIds.some((id) => !isText(id, 100)))) return false;
      return Object.keys(payload).length > 0;
    }
    case "rules.compile":
      return hasOnlyKeys(payload, ["requestId", "text"]) && isRequestId(payload.requestId) && isText(payload.text, 2_000);
    case "obs.setup":
      return hasOnlyKeys(payload, ["requestId", "contentScene"]) && isRequestId(payload.requestId) && (payload.contentScene === undefined || isText(payload.contentScene, 128));
    default:
      return false;
  }
}

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
  let streamStarted = false;
  let streamLeakCount = 0;

  const subscribe = <K extends BrowserEvent>(event: K, listener: (payload: EventMap[K]) => void) => {
    bus.on(event, listener);
    removers.push(() => bus.off(event, listener));
  };
  for (const event of browserEvents) {
    subscribe(event, (payload) => {
      if (event === "shield.state") latestState = payload as EventMap["shield.state"];
      if (event === "private.state") latestPrivate = payload as EventMap["private.state"];
      let wirePayload = payload;
      if (event === "leak.detected") {
        const leak = payload as EventMap["leak.detected"];
        if (streamStarted) latestLeakCount = ++streamLeakCount;
        else latestLeakCount = leak.totalBlocked;
        wirePayload = { ...leak, totalBlocked: latestLeakCount } as EventMap[typeof event];
      }
      for (const socket of sockets) {
        const role = (socket as WebSocket & { twitchyRole?: Role }).twitchyRole;
        if (role && roleEvents[role].has(event)) sendJson(socket, { event, payload: wirePayload } as WireEvent);
      }
    });
  }

  const snapshotFor = (role: Role): WireSnapshot => ({ snapshot: {
    shieldState: latestState,
    leakCount: latestLeakCount,
    privateState: role === "dashboard" ? latestPrivate : undefined,
  } });
  const onShieldCommand = (command: EventMap["shield.command"]) => {
    if (command.action !== "on" || command.by !== "stream.online") return;
    streamStarted = true;
    streamLeakCount = 0;
    latestLeakCount = 0;
    for (const socket of sockets) {
      const role = (socket as WebSocket & { twitchyRole?: Role }).twitchyRole;
      if (role) sendJson(socket, snapshotFor(role));
    }
  };
  bus.on("shield.command", onShieldCommand);
  removers.push(() => bus.off("shield.command", onShieldCommand));

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
  wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_BROWSER_MESSAGE_BYTES });
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const role: Role | undefined = path === "/ws/overlay" ? "overlay" : path === "/ws/dashboard" ? "dashboard" : undefined;
    const allowedHosts = new Set([`127.0.0.1:${config.webPort}`, `localhost:${config.webPort}`]);
    const origin = req.headers.origin;
    const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));
    if (!role || !allowedHosts.has(req.headers.host ?? "") || !origin || !allowedOrigins.has(origin)) { socket.destroy(); return; }
    wsServer?.handleUpgrade(req, socket, head, (client) => {
      (client as WebSocket & { twitchyRole?: Role }).twitchyRole = role;
      sockets.add(client);
      client.on("close", () => sockets.delete(client));
      client.on("error", () => {});
      client.on("message", (data, isBinary) => {
        if (role !== "dashboard" || isBinary) { client.close(1008, "Invalid browser command"); return; }
        let message: unknown;
        try {
          const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          if (bytes.byteLength > MAX_BROWSER_MESSAGE_BYTES) throw new Error("oversized");
          message = JSON.parse(bytes.toString("utf8"));
        } catch {
          client.close(1008, "Invalid browser command");
          return;
        }
        if (!isRecord(message) || !hasOnlyKeys(message, ["event", "payload"]) || !validBrowserCommand(message.event, message.payload)) {
          client.close(1008, "Invalid browser command");
          return;
        }
        bus.emit(message.event, message.payload as never);
      });
      sendJson(client, snapshotFor(role));
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
    await Promise.all([
      new Promise<void>((resolve) => {
        try { wsServer?.close(() => resolve()); } catch { resolve(); }
      }),
      new Promise<void>((resolve) => {
        if (!server?.listening) { resolve(); return; }
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    ]);
    const message = bindError(config.webPort, error).message;
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new Error(message);
    console.error(`[web] ${message}; web track will stay disabled.`);
    return async () => {};
  }

  return async () => {
    if (stopped) return;
    stopped = true;
    for (const remove of removers) remove();
    for (const socket of sockets) socket.terminate();
    sockets.clear();
    const closeWebSockets = new Promise<void>((resolve) => {
      if (!wsServer) { resolve(); return; }
      try { wsServer.close(() => resolve()); } catch { resolve(); }
    });
    const closeHttp = new Promise<void>((resolve) => {
      if (!server?.listening) { resolve(); return; }
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await Promise.all([closeWebSockets, closeHttp]);
  };
};
