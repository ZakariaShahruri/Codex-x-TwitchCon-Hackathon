import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import OBSWebSocket from "obs-websocket-js";
import { EventBus } from "../src/shared/bus.js";
import { loadConfig } from "../src/shared/config.js";
import type { Box, LeakKind } from "../src/shared/events.js";
import type { StopTrack } from "../src/shared/track.js";
import { start as startShield } from "../src/shield/index.js";
import { start as startTwitch } from "../src/twitch/index.js";
import { start as startWeb } from "../src/web/index.js";
import { createGauntletPlan } from "../tools/gauntlet/plan.js";
import { scoreGauntlet, type GauntletClearEvent, type GauntletLeakEvent, type GauntletRunCase } from "../tools/gauntlet/scoring.js";
import { briefScenes, inspectScenes, restoreItemTransform } from "./obs-helpers.js";

const CONTENT = "Twitchy Content";
const BROADCAST = "Twitchy Broadcast";
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
interface PageEvent { type: "painted" | "hidden" | "complete"; id?: string; at?: number; region?: Box }
interface TimedCase { paintedAt?: number; hiddenAt?: number; region?: Box }

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(body);
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function covers(mask: Box, box: Box): boolean {
  return mask.x <= box.x && mask.y <= box.y && mask.x + mask.w >= box.x + box.w && mask.y + mask.h >= box.y + box.h;
}

function maskBox(transform: Record<string, number>): Box {
  return { x: transform.positionX, y: transform.positionY,
    w: transform.boundsWidth || transform.width, h: transform.boundsHeight || transform.height };
}

async function main(): Promise<void> {
  const config = await loadConfig();
  assert.ok(config.env.OBS_WS_URL, "OBS_WS_URL is missing from .env");
  const obsUrl = config.env.OBS_WS_URL;
  const withTwitch = process.argv.includes("--with-twitch");
  const seedArg = process.argv.find((arg) => arg.startsWith("--seed="))?.slice("--seed=".length);
  const seed = seedArg === undefined ? Math.floor(Math.random() * 0x7fffffff) : Number(seedArg);
  assert.ok(Number.isSafeInteger(seed) && seed >= 0, "--seed must be a non-negative safe integer");
  const plan = createGauntletPlan(seed, 0);
  const plannedById = new Map(plan.map((item) => [item.id, item]));
  const timed = new Map<string, TimedCase>();
  const leaks: GauntletLeakEvent[] = [];
  const cleared: GauntletClearEvent[] = [];
  const maskLiveAt = new Map<string, number>();
  const maskObservations: Promise<void>[] = [];
  const abort = new AbortController();
  let completedResolve!: () => void;
  let completedReject!: (error: Error) => void;
  const completed = new Promise<void>((resolveComplete, rejectComplete) => { completedResolve = resolveComplete; completedReject = rejectComplete; });
  const onSignal = () => abort.abort(new Error("Interrupted"));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let score: ReturnType<typeof scoreGauntlet> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let serverPort = 0;
  let obs: OBSWebSocket | undefined;
  let sourceName = `Twitchy Leak Gauntlet ${process.pid}`;
  let before: Awaited<ReturnType<typeof inspectScenes>> | undefined;
  let stops: StopTrack[] = [];
  let primaryError: unknown;
  const bus = new EventBus();

  const shutdownSignal = new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true }));
  void shutdownSignal.catch(() => undefined);
  const maskCovers = async (box: Box, timeoutMs = 500): Promise<number | undefined> => {
    const until = Date.now() + timeoutMs;
    while (Date.now() <= until && obs?.identified) {
      const { sceneItems } = await obs.call("GetSceneItemList", { sceneName: BROADCAST }) as unknown as { sceneItems: Array<{
        sourceName: string; sceneItemId: number; sceneItemEnabled: boolean;
      }> };
      for (const item of sceneItems) {
        if (!/^Twitchy Mask \d+$/.test(item.sourceName) || !item.sceneItemEnabled) continue;
        const { sceneItemTransform } = await obs.call("GetSceneItemTransform", { sceneName: BROADCAST, sceneItemId: item.sceneItemId });
        if (covers(maskBox(sceneItemTransform as unknown as Record<string, number>), box)) return Date.now();
      }
      await sleep(20);
    }
    return undefined;
  };
  bus.on("leak.detected", (event) => {
    leaks.push({ id: event.id, kind: event.kind, box: event.box, at: event.at });
    const observation = maskCovers(event.box).then((at) => { if (at !== undefined) maskLiveAt.set(event.id, at); })
      .catch((error: unknown) => console.error(`Mask observation failed for ${event.id}: ${String(error)}`));
    maskObservations.push(observation);
  });
  bus.on("leak.cleared", (event) => { cleared.push({ id: event.id, at: event.at }); });

  try {
    const html = await readFile(resolve("tools/gauntlet/page.html"), "utf8");
    server = createServer(async (req, res) => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" }).end(); return; }
      if (req.method === "GET" && pathname === "/") { send(res, 200, html, "text/html; charset=utf-8"); return; }
      if (req.method === "GET" && pathname === "/plan") {
        const video = await obs!.call("GetVideoSettings") as unknown as { baseWidth: number; baseHeight: number };
        send(res, 200, JSON.stringify({ cases: plan, width: video.baseWidth, height: video.baseHeight }), "application/json; charset=utf-8"); return;
      }
      if (req.method === "GET" && pathname === "/status") { send(res, 200, JSON.stringify({ score: score ?? null }), "application/json; charset=utf-8"); return; }
      if (req.method === "POST" && pathname === "/events") {
        const event = await body(req) as PageEvent;
        if (event.type === "painted" || event.type === "hidden") {
          if (!event.id || !plannedById.has(event.id) || !Number.isFinite(event.at)) { send(res, 400, "Invalid case event"); return; }
          const record = timed.get(event.id) ?? {};
          if (event.type === "painted") {
            if (!event.region || ![event.region.x, event.region.y, event.region.w, event.region.h].every(Number.isFinite) || event.region.w <= 0 || event.region.h <= 0) { send(res, 400, "Invalid painted region"); return; }
            record.paintedAt = event.at;
            record.region = event.region;
          } else record.hiddenAt = event.at;
          timed.set(event.id, record);
        } else if (event.type === "complete") completedResolve();
        else { send(res, 400, "Unknown event"); return; }
        send(res, 204, ""); return;
      }
      send(res, 404, "Not found");
    });
    await new Promise<void>((resolveListen, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => { server!.off("error", reject); resolveListen(); });
    });
    serverPort = (server.address() as { port: number }).port;

    obs = new OBSWebSocket();
    await obs.connect(obsUrl, config.env.OBS_WS_PASSWORD);
    before = await inspectScenes(obs, [CONTENT, BROADCAST]);
    const masks = before[BROADCAST]?.filter((item) => /^Twitchy Mask \d+$/.test(item.sourceName)) ?? [];
    assert.equal(masks.length, config.maskPoolSize, "configured Twitchy mask pool is missing");
    assert.ok(masks.every((item) => !item.sceneItemEnabled), "masks are already enabled; refusing to change OBS");
    assert.ok(!(before[CONTENT] ?? []).some((item) => item.sourceName === sourceName), "temporary browser source name already exists");
    console.log(`Leak Gauntlet seed: ${seed}`);
    console.log("OBS scene items before:", JSON.stringify(briefScenes(before), null, 2));

    const video = await obs.call("GetVideoSettings") as unknown as { baseWidth: number; baseHeight: number };
    const created = await obs.call("CreateInput", {
      sceneName: CONTENT, inputName: sourceName, inputKind: "browser_source",
      inputSettings: { url: `http://127.0.0.1:${serverPort}/`, width: video.baseWidth, height: video.baseHeight, shutdown: false, restart_when_active: false },
      sceneItemEnabled: true,
    });
    if (created.sceneItemId === null) throw new Error("OBS did not return the temporary browser source scene item ID");
    const sourceId = created.sceneItemId;
    await obs.call("SetSceneItemIndex", { sceneName: CONTENT, sceneItemId: sourceId, sceneItemIndex: before[CONTENT]!.length });

    stops.push(await startShield(bus, config));
    if (withTwitch) stops.push(await startTwitch(bus, config));
    stops.push(await startWeb(bus, config));
    console.log(`Leak Gauntlet page: http://127.0.0.1:${serverPort}/`);
    console.log(`Running ${plan.length} cases (${plan.filter((item) => item.kind !== null && !item.flash).length} leak rounds, decoys, and ${plan.filter((item) => item.flash).length} flashes).`);

    await Promise.race([
      completed,
      shutdownSignal,
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Leak Gauntlet exceeded the 90 second run limit")), 90_000); timer.unref(); }),
    ]);
    // Let the last secret's lifetime elapse; earlier cases have already had at least this much time.
    await sleep(config.delayMs + config.safetyMarginMs + 2 * config.captureIntervalMs + 300);
    await Promise.all(maskObservations);
    const runCases: GauntletRunCase[] = plan.flatMap((item) => {
      const observed = timed.get(item.id);
      if (observed?.paintedAt === undefined || observed.hiddenAt === undefined || !observed.region) return [];
      return [{ id: item.id, kind: item.kind, region: observed.region, paintedAt: observed.paintedAt, hiddenAt: observed.hiddenAt, flash: item.flash }];
    });
    assert.equal(runCases.length, plan.length, "page did not report paint and hide times for every planned case");
    score = scoreGauntlet({ cases: runCases, detected: leaks, cleared, maskLiveAt,
      enabledDetectors: config.enabledDetectors, delayMs: config.delayMs });
    const headline = score.headline;
    const pending = score.cases.filter((item) => item.status === "pending").map((item) => item.id);
    console.log(`LEAK GAUNTLET · ${headline.blocked}/${headline.eligible} blocked · ${headline.falseAlarms} false alarms · p50 ${Math.round(headline.p50Ms)} ms · p95 ${Math.round(headline.p95Ms)} ms · every mask up before air: ${headline.everyMaskUpBeforeAir ? "YES" : "NO"}`);
    console.log(`Flash results: ${score.flash.blocked}/${score.flash.eligible} blocked`);
    if (pending.length) console.log(`Pending (detector disabled): ${pending.join(", ")}`);
    if (score.falseAlarmLeakIds.length) console.log(`False alarm leak IDs: ${score.falseAlarmLeakIds.join(", ")}`);
    // Keep the final card on the browser source long enough to be visible in OBS.
    await sleep(2_500);
  } catch (error) {
    primaryError = error;
  } finally {
    abort.abort();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    for (const stop of stops.reverse()) {
      try { await stop(); } catch (error) { primaryError ??= error; }
    }
    if (obs?.identified) {
      try {
        const current = await obs.call("GetSceneItemList", { sceneName: CONTENT }) as unknown as { sceneItems: Array<{ sourceName: string; sceneItemId: number }> };
        const temporary = current.sceneItems.find((item) => item.sourceName === sourceName);
        if (temporary) await obs.call("RemoveSceneItem", { sceneName: CONTENT, sceneItemId: temporary.sceneItemId });
      } catch (error) { primaryError ??= error; }
      try { await obs.call("RemoveInput", { inputName: sourceName }); } catch { /* absent when source creation did not complete */ }
      for (const item of before?.[BROADCAST]?.filter((entry) => /^Twitchy Mask \d+$/.test(entry.sourceName)) ?? []) {
        try { await restoreItemTransform(obs, BROADCAST, item); } catch (error) { primaryError ??= error; }
      }
      await obs.disconnect();
    }
    if (server) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
  }

  if (obs && before) {
    const verify = new OBSWebSocket();
    await verify.connect(obsUrl, config.env.OBS_WS_PASSWORD);
    let after;
    try { after = await inspectScenes(verify, [CONTENT, BROADCAST]); } finally { if (verify.identified) await verify.disconnect(); }
    console.log("OBS scene items after:", JSON.stringify(briefScenes(after), null, 2));
    assert.deepEqual(after, before, "OBS scene lists, order, enabled states or transforms differ from baseline");
    console.log("OBS restored to baseline; temporary browser source removed and masks disabled.");
  }
  if (primaryError) throw primaryError;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = error instanceof Error && error.message === "Interrupted" ? 130 : 1;
});
