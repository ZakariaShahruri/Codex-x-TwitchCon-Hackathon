import assert from "node:assert/strict";
import { resolve } from "node:path";
import OBSWebSocket from "obs-websocket-js";
import { EventBus } from "../src/shared/bus.js";
import { loadConfig } from "../src/shared/config.js";
import { connectContentCapture, type CaptureFrame } from "../src/shield/capture-loop.js";
import { startShield } from "../src/shield/index.js";

const CONTENT = "Twitchy Content";
const BROADCAST = "Twitchy Broadcast";
const tempName = `Twitchy Live E2E ${process.pid}`;
const fixture = resolve("tools/ocr-vision/fixtures/fake-env-1080p-12px.png");
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function inspect(obs: OBSWebSocket): Promise<Record<string, any[]>> {
  const result: Record<string, any[]> = {};
  for (const sceneName of [CONTENT, BROADCAST]) {
    const { sceneItems } = await obs.call("GetSceneItemList", { sceneName });
    result[sceneName] = await Promise.all(sceneItems.map(async (item) => ({
      sourceName: item.sourceName, sceneItemId: item.sceneItemId, sceneItemIndex: item.sceneItemIndex,
      sceneItemEnabled: item.sceneItemEnabled,
      transform: (await obs.call("GetSceneItemTransform", { sceneName, sceneItemId: item.sceneItemId })).sceneItemTransform,
    })));
  }
  return result;
}

const brief = (items: Record<string, any[]>) => Object.fromEntries(Object.entries(items).map(([scene, entries]) => [
  scene, entries.map(({ sourceName, sceneItemId, sceneItemIndex, sceneItemEnabled }) => ({ name: sourceName, id: sceneItemId, index: sceneItemIndex, enabled: sceneItemEnabled })),
]));

async function main(): Promise<void> {
  const config = await loadConfig();
  assert.ok(config.env.OBS_WS_URL, "OBS_WS_URL is missing from .env");
  process.env.DEBUG = "1";
  const obs = new OBSWebSocket();
  await obs.connect(config.env.OBS_WS_URL, config.env.OBS_WS_PASSWORD);
  const origLog = console.log;
  const logs: string[] = [];
  const frames: CaptureFrame[] = [];
  const clearedAt: number[] = [];
  const bus = new EventBus();
  bus.on("leak.cleared", ({ at }) => { clearedAt.push(at); });
  const before = await inspect(obs);
  const broadcast = before[BROADCAST]!;
  const masksBefore = broadcast.filter((item) => /^Twitchy Mask \d+$/.test(item.sourceName));
  assert.equal(masksBefore.length, config.maskPoolSize, "configured mask pool not found in Twitchy Broadcast");
  assert.ok(masksBefore.every((item) => !item.sceneItemEnabled), "mask already enabled before test; refusing to change OBS");
  assert.ok(!(before[CONTENT] ?? []).some((item) => item.sourceName === tempName));
  origLog("OBS scene items before:", JSON.stringify(brief(before), null, 2));

  let tempId: number | undefined;
  let stopEngine: (() => Promise<void>) | undefined;
  let engineStarted = false;
  let error: unknown;
  try {
    const created = await obs.call("CreateInput", {
      sceneName: CONTENT, inputName: tempName, inputKind: "image_source",
      inputSettings: { file: fixture, unload: false }, sceneItemEnabled: true,
    });
    tempId = created.sceneItemId;
    // OBS scene item index increases toward the top of the rendered stack.
    await obs.call("SetSceneItemIndex", { sceneName: CONTENT, sceneItemId: tempId, sceneItemIndex: before[CONTENT]!.length });
    const initialSourceTransform = (await obs.call("GetSceneItemTransform", { sceneName: CONTENT, sceneItemId: tempId })).sceneItemTransform;
    origLog("Fixture source added:", tempName, `id=${tempId}`);

    const connector: Parameters<typeof startShield>[2] = async (cfg, options) => connectContentCapture(cfg, {
      ...options,
      onFrame: async (frame) => { frames.push(frame); await options.onFrame(frame); },
    });
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); origLog(...args); };
    stopEngine = await startShield(bus, config, connector);
    engineStarted = true;

    const waitForLeaks = async (frameAfter: number, count: number, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (logs.filter((line) => /^Leak #\d+ /.test(line)).length >= count && frames.length >= frameAfter + 2) return;
        await sleep(100);
      }
      throw new Error(`Timed out: ${logs.filter((line) => /^Leak #\d+ /.test(line)).length} leak logs, ${frames.length} frames`);
    };
    await waitForLeaks(0, 5, 12_000);
    await sleep(350);
    const first = frames.findLast((frame) => frame.leaks.length >= 5);
    assert.ok(first, "no frame contained five fixture detections");
    const unique = (frame: CaptureFrame) => [...new Map(frame.leaks.map((leak) => [leak.fingerprint, leak])).values()];
    const initialLeaks = unique(first);
    assert.equal(initialLeaks.length, 5, `expected five distinct leaks, got ${initialLeaks.length}`);
    assert.deepEqual(initialLeaks.map((leak) => leak.kind).sort(), ["api_key", "api_key", "api_key", "email", "password"]);

    const activeMasks = async () => {
      const { sceneItems } = await obs.call("GetSceneItemList", { sceneName: BROADCAST });
      return Promise.all(sceneItems.filter((item) => /^Twitchy Mask \d+$/.test(item.sourceName) && item.sceneItemEnabled).map(async (item) => {
        const t = (await obs.call("GetSceneItemTransform", { sceneName: BROADCAST, sceneItemId: item.sceneItemId })).sceneItemTransform;
        return { id: item.sourceName, x: t.positionX, y: t.positionY, w: t.boundsWidth || t.width, h: t.boundsHeight || t.height };
      }));
    };
    const contains = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
      a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;
    const masks = await activeMasks();
    assert.ok(initialLeaks.every((leak) => masks.some((mask) => contains(mask, leak.box))), "initial mask misses a detected secret box");
    origLog("Initial frame verification:", JSON.stringify({ distinctSecrets: initialLeaks.length, enabledMasks: masks.length,
      maskTransforms: masks,
      logs: logs.filter((line) => /^Leak #\d+ /.test(line)) }, null, 2));

    const frameStart = frames.length;
    const oldBoxes = initialLeaks.map((leak) => ({ ...leak.box }));
    await obs.call("SetSceneItemTransform", { sceneName: CONTENT, sceneItemId: tempId, sceneItemTransform: { positionX: 60, positionY: 50 } });
    const moveDeadline = Date.now() + 8_000;
    let movedFrame: CaptureFrame | undefined;
    while (Date.now() < moveDeadline) {
      movedFrame = frames.slice(frameStart).find((frame) => unique(frame).length >= 5);
      if (movedFrame) break;
      await sleep(100);
    }
    assert.ok(movedFrame, "no five-secret OCR frame after source movement");
    const movedLeaks = unique(movedFrame);
    const movedMasks = await activeMasks();
    assert.ok(movedLeaks.every((leak) => movedMasks.some((mask) => contains(mask, leak.box))), "moved mask misses a detected secret box");
    const offsets = movedLeaks.flatMap((leak) => {
      const old = initialLeaks.find((candidate) => candidate.fingerprint === leak.fingerprint);
      return old ? [{ dx: leak.box.x - old.box.x, dy: leak.box.y - old.box.y }] : [];
    });
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    assert.ok(offsets.length >= 4 && Math.abs(median(offsets.map((p) => p.dx)) - 60) <= 8 && Math.abs(median(offsets.map((p) => p.dy)) - 50) <= 8,
      `detector boxes did not follow 60x50 move: ${JSON.stringify(offsets)}`);
    const oldTrail = oldBoxes.filter((box) => movedMasks.some((mask) => contains(mask, box))).length;
    assert.ok(oldTrail >= 4, `old trail covers only ${oldTrail}/5 positions`);
    origLog("Movement verification:", JSON.stringify({ requestedOffset: [60, 50], observedMedian: [median(offsets.map((p) => p.dx)), median(offsets.map((p) => p.dy))],
      enabledMasks: movedMasks.length, oldPositionsStillCovered: oldTrail }, null, 2));

    const removedAt = Date.now();
    await obs.call("RemoveSceneItem", { sceneName: CONTENT, sceneItemId: tempId });
    tempId = undefined;
    try { await obs.call("RemoveInput", { inputName: tempName }); } catch { /* OBS removes an unreferenced input with its scene item */ }
    const clearDeadline = Date.now() + config.delayMs + config.safetyMarginMs + 4_000;
    while (Date.now() < clearDeadline && (await activeMasks()).length > 0) await sleep(75);
    const remaining = await activeMasks();
    assert.equal(remaining.length, 0, `masks remained enabled after removal: ${JSON.stringify(remaining)}`);
    origLog("Removal verification:", JSON.stringify({ elapsedMs: Date.now() - removedAt,
      leakClearedAfterMs: clearedAt.map((at) => at - removedAt), enabledMasks: 0 }, null, 2));
    assert.ok(Date.now() - removedAt >= config.delayMs, "masks went down less than one delay after removal");
  } catch (caught) {
    error = caught;
  } finally {
    if (tempId !== undefined) {
      try { await obs.call("RemoveSceneItem", { sceneName: CONTENT, sceneItemId: tempId }); } catch { /* already absent */ }
      try { await obs.call("RemoveInput", { inputName: tempName }); } catch { /* already absent */ }
    }
    if (stopEngine) {
      try { await stopEngine(); } catch (caught) { error ??= caught; }
    }
    if (engineStarted) {
      for (const item of masksBefore) {
        const t = item.transform;
        try {
          const target: Record<string, unknown> = {
            positionX: t.positionX, positionY: t.positionY, rotation: t.rotation, scaleX: t.scaleX, scaleY: t.scaleY,
            alignment: t.alignment, boundsType: t.boundsType, boundsAlignment: t.boundsAlignment,
            cropLeft: t.cropLeft, cropRight: t.cropRight, cropTop: t.cropTop, cropBottom: t.cropBottom,
          };
          if (t.boundsWidth > 0) target.boundsWidth = t.boundsWidth;
          if (t.boundsHeight > 0) target.boundsHeight = t.boundsHeight;
          await obs.call("SetSceneItemTransform", { sceneName: BROADCAST, sceneItemId: item.sceneItemId, sceneItemTransform: target });
          await obs.call("SetSceneItemEnabled", { sceneName: BROADCAST, sceneItemId: item.sceneItemId, sceneItemEnabled: false });
        } catch (caught) { error ??= new Error(`Failed to restore ${item.sourceName}: ${String(caught)}`); }
      }
    }
    if (obs.identified) await obs.disconnect();
    console.log = origLog;
  }

  const verify = new OBSWebSocket();
  await verify.connect(config.env.OBS_WS_URL, config.env.OBS_WS_PASSWORD);
  let after: Record<string, any[]>;
  try { after = await inspect(verify); } finally { if (verify.identified) await verify.disconnect(); }
  origLog("OBS scene items after:", JSON.stringify(brief(after), null, 2));
  assert.deepEqual(brief(after), brief(before), "scene item list/order/enabled state differs from baseline");
  assert.deepEqual(after, before, "scene transforms differ from baseline");
  assert.ok(!(after[CONTENT] ?? []).some((item) => item.sourceName === tempName), "temporary fixture source still exists");
  assert.ok((after[BROADCAST] ?? []).filter((item) => /^Twitchy Mask \d+$/.test(item.sourceName)).every((item) => !item.sceneItemEnabled));
  if (error) throw error;
  origLog("Live E2E completed; OBS scene items restored and all masks disabled.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
