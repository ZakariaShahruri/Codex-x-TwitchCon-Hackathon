import OBSWebSocket from "obs-websocket-js";
import type { Config } from "../shared/config.js";

const SCENES = {
  content: "Twitchy Content",
  raw: "Twitchy Raw",
  broadcast: "Twitchy Broadcast",
} as const;
const OVERLAY = "Twitchy Overlay";
const FILTER_PREFIX = "Twitchy Render Delay ";
const MASK_PREFIX = "Twitchy Mask ";

type JsonRecord = Record<string, unknown>;
type SceneItem = { sourceName: string; sceneItemId: number; sceneItemEnabled: boolean };
type Input = { inputName: string; inputKind: string };
type Filter = { filterName: string; filterKind: string };

function rows(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord => typeof item === "object" && item !== null) : [];
}
function sceneItems(value: unknown): SceneItem[] {
  return rows(value).filter((item): item is JsonRecord & SceneItem =>
    typeof item.sourceName === "string" && typeof item.sceneItemId === "number" && typeof item.sceneItemEnabled === "boolean");
}
function findNamed<T extends { [key: string]: unknown }>(items: T[], key: string, name: string): T | undefined {
  return items.find((item) => item[key] === name);
}
export function renderDelayParts(delayMs: number): number[] {
  const parts: number[] = [];
  for (let remaining = delayMs; remaining > 0; remaining -= 500) parts.push(Math.min(500, remaining));
  return parts;
}

/** Twitchy-owned Broadcast sources from bottom (OBS index 0) to top: delayed content, masks over it, overlay on top. */
export function broadcastOrder(maskCount: number): string[] {
  return [SCENES.raw, ...Array.from({ length: maskCount }, (_, i) => `${MASK_PREFIX}${String(i + 1).padStart(2, "0")}`), OVERLAY];
}

/** Builds the reserved Twitchy scenes and sources without changing the active scene. */
export async function setupObs(config: Config, options: { contentScene?: string } = {}): Promise<void> {
  const url = config.env.OBS_WS_URL;
  if (!url) throw new Error("OBS_WS_URL is missing. Set it in .env (for example ws://127.0.0.1:4455).");

  const obs = new OBSWebSocket();
  const changes: string[] = [];
  try {
    await obs.connect(url, config.env.OBS_WS_PASSWORD);
    let sceneList = rows((await obs.call("GetSceneList")).scenes);
    const ensureScene = async (name: string): Promise<void> => {
      if (sceneList.some((scene) => scene.sceneName === name)) {
        changes.push(`Found scene: ${name}`);
      } else {
        await obs.call("CreateScene", { sceneName: name });
        sceneList = rows((await obs.call("GetSceneList")).scenes);
        changes.push(`Created scene: ${name}`);
      }
    };

    await ensureScene(SCENES.content);
    await ensureScene(SCENES.raw);
    await ensureScene(SCENES.broadcast);

    const contentItems = sceneItems((await obs.call("GetSceneItemList", { sceneName: SCENES.content })).sceneItems);
    if (contentItems.length === 0) {
      const chosenScene = options.contentScene ?? (await obs.call("GetCurrentProgramScene")).currentProgramSceneName;
      if (!sceneList.some((scene) => scene.sceneName === chosenScene)) throw new Error(`Content scene not found in OBS: ${chosenScene}`);
      if (chosenScene === SCENES.content || chosenScene === SCENES.raw || chosenScene === SCENES.broadcast)
        throw new Error(`Cannot use reserved Twitchy scene as Twitchy Content: ${chosenScene}`);
      await obs.call("CreateSceneItem", { sceneName: SCENES.content, sourceName: chosenScene, sceneItemEnabled: true });
      changes.push(`Added content scene: ${chosenScene} → ${SCENES.content}`);
    } else {
      const nestedScene = contentItems[0].sourceName;
      if (options.contentScene && nestedScene !== options.contentScene)
        throw new Error(`${SCENES.content} already contains ${nestedScene}; it was preserved. Choose it or leave --content-scene off.`);
      changes.push(`Found content scene: ${nestedScene} → ${SCENES.content}`);
    }

    await ensureSceneItem(obs, SCENES.raw, SCENES.content, true, changes);
    await ensureFilters(obs, SCENES.raw, config.delayMs, changes);

    const video = await obs.call("GetVideoSettings");
    const width = video.baseWidth;
    const height = video.baseHeight;
    await ensureSceneItem(obs, SCENES.broadcast, SCENES.raw, true, changes);

    const inputList = rows((await obs.call("GetInputList")).inputs).map((item) => ({
      inputName: String(item.inputName ?? ""), inputKind: String(item.inputKind ?? ""),
    }));
    const maskCount = Math.max(config.maskPoolSize, inputList.filter((item) => item.inputName.startsWith(MASK_PREFIX)).length);
    for (let index = 1; index <= maskCount; index += 1) {
      const name = `${MASK_PREFIX}${String(index).padStart(2, "0")}`;
      const existing = inputList.find((item) => item.inputName === name);
      if (existing && existing.inputKind !== "color_source")
        throw new Error(`OBS input name conflict: ${name} exists as ${existing.inputKind}, expected color_source. Rename it manually and retry.`);
      if (existing && !sceneItems((await obs.call("GetSceneItemList", { sceneName: SCENES.broadcast })).sceneItems).some((item) => item.sourceName === name))
        throw new Error(`OBS input name conflict: ${name} is not in ${SCENES.broadcast}; refusing to repurpose it.`);
      if (!existing) {
        await obs.call("CreateInput", {
          sceneName: SCENES.broadcast, inputName: name, inputKind: "color_source",
          inputSettings: { color: 0xff000000, width, height }, sceneItemEnabled: false,
        });
        inputList.push({ inputName: name, inputKind: "color_source" });
        changes.push(`Created hidden mask: ${name}`);
      } else {
        changes.push(`Found mask: ${name}`);
      }
      const item = sceneItems((await obs.call("GetSceneItemList", { sceneName: SCENES.broadcast })).sceneItems)
        .find((candidate) => candidate.sourceName === name);
      if (item?.sceneItemEnabled) await obs.call("SetSceneItemEnabled", { sceneName: SCENES.broadcast, sceneItemId: item.sceneItemId, sceneItemEnabled: false });
    }
    for (const extra of inputList.filter((item) => item.inputName.startsWith(MASK_PREFIX) && Number(item.inputName.slice(MASK_PREFIX.length)) > config.maskPoolSize))
      changes.push(`Kept extra mask disabled: ${extra.inputName}`);

    const overlayExisting = inputList.find((item) => item.inputName === OVERLAY);
    if (overlayExisting && overlayExisting.inputKind !== "browser_source")
      throw new Error(`OBS input name conflict: ${OVERLAY} exists as ${overlayExisting.inputKind}, expected browser_source. Rename it manually and retry.`);
    const broadcastItems = sceneItems((await obs.call("GetSceneItemList", { sceneName: SCENES.broadcast })).sceneItems);
    if (overlayExisting && !broadcastItems.some((item) => item.sourceName === OVERLAY))
      throw new Error(`OBS input name conflict: ${OVERLAY} is not in ${SCENES.broadcast}; refusing to repurpose it.`);
    if (!overlayExisting) {
      await obs.call("CreateInput", {
        sceneName: SCENES.broadcast, inputName: OVERLAY, inputKind: "browser_source",
        inputSettings: { url: `http://127.0.0.1:${config.webPort}/overlay/`, width, height }, sceneItemEnabled: true,
      });
      changes.push(`Created browser overlay: ${OVERLAY}`);
    } else {
      changes.push(`Found browser overlay: ${OVERLAY}`);
    }
    await ensureFilters(obs, OVERLAY, config.delayMs, changes);

    // Set order only for Twitchy-owned sources, leaving any streamer-owned items intact.
    const finalItems = sceneItems((await obs.call("GetSceneItemList", { sceneName: SCENES.broadcast })).sceneItems);
    const ownedOrder = broadcastOrder(maskCount);
    for (let index = 0; index < ownedOrder.length; index += 1) {
      const item = finalItems.find((candidate) => candidate.sourceName === ownedOrder[index]);
      if (item) await obs.call("SetSceneItemIndex", { sceneName: SCENES.broadcast, sceneItemId: item.sceneItemId, sceneItemIndex: index });
    }

    for (const line of changes) console.log(`• ${line}`);
    console.log("\nManual OBS steps:");
    console.log(`1. Set the scene sent to stream to ${SCENES.broadcast} when you are ready to broadcast through Twitchy.`);
    console.log(`2. Set Sync Offset on each active audio source to about ${config.delayMs} ms (Render Delay is video only).`);
    console.log("3. Verify stacked delay with a stopwatch before streaming; see docs/architecture.md §9.");
    console.log(`Canvas: ${width}×${height}. Program scene was not changed.`);
  } catch (error) {
    throw new Error(`OBS setup failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    if (obs.identified) await obs.disconnect();
  }
}

async function ensureSceneItem(obs: OBSWebSocket, sceneName: string, sourceName: string, enabled: boolean, changes: string[]): Promise<void> {
  const items = sceneItems((await obs.call("GetSceneItemList", { sceneName })).sceneItems);
  const found = items.find((item) => item.sourceName === sourceName);
  if (found) {
    changes.push(`Found ${sourceName} in ${sceneName}`);
    return;
  }
  await obs.call("CreateSceneItem", { sceneName, sourceName, sceneItemEnabled: enabled });
  changes.push(`Added ${sourceName} to ${sceneName}`);
}

async function ensureFilters(obs: OBSWebSocket, sourceName: string, delayMs: number, changes: string[]): Promise<void> {
  const current = rows((await obs.call("GetSourceFilterList", { sourceName })).filters)
    .map((item) => ({ filterName: String(item.filterName ?? ""), filterKind: String(item.filterKind ?? "") } as Filter));
  const parts = renderDelayParts(delayMs);
  const total = Math.max(parts.length, current.filter((filter) => filter.filterName.startsWith(FILTER_PREFIX)).length);
  for (let index = 1; index <= total; index += 1) {
    const filterName = `${FILTER_PREFIX}${index}`;
    const existing = current.find((filter) => filter.filterName === filterName);
    if (existing && existing.filterKind !== "gpu_delay")
      throw new Error(`Filter name conflict on ${sourceName}: ${filterName} is ${existing.filterKind}, expected gpu_delay.`);
    const sleepMillis = parts[index - 1] ?? 0;
    if (existing) {
      await obs.call("SetSourceFilterSettings", { sourceName, filterName, filterSettings: { delay_ms: sleepMillis }, overlay: true });
      changes.push(`${sleepMillis ? "Configured" : "Disabled excess"} delay filter ${filterName} on ${sourceName}: ${sleepMillis} ms`);
    } else {
      await obs.call("CreateSourceFilter", { sourceName, filterName, filterKind: "gpu_delay", filterSettings: { delay_ms: sleepMillis } });
      changes.push(`Created delay filter ${filterName} on ${sourceName}: ${sleepMillis} ms`);
    }
  }
}
