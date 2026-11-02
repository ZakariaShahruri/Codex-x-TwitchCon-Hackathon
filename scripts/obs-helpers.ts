import type OBSWebSocket from "obs-websocket-js";

export interface SceneItemSnapshot {
  sourceName: string;
  sceneItemId: number;
  sceneItemIndex: number;
  sceneItemEnabled: boolean;
  transform: Record<string, number>;
}
export type SceneSnapshot = Record<string, SceneItemSnapshot[]>;

export async function inspectScenes(obs: OBSWebSocket, sceneNames: readonly string[]): Promise<SceneSnapshot> {
  const result: SceneSnapshot = {};
  for (const sceneName of sceneNames) {
    const { sceneItems } = await obs.call("GetSceneItemList", { sceneName }) as unknown as { sceneItems: Array<{
      sourceName: string; sceneItemId: number; sceneItemIndex: number; sceneItemEnabled: boolean;
    }> };
    result[sceneName] = await Promise.all(sceneItems.map(async (item) => ({
      sourceName: item.sourceName,
      sceneItemId: item.sceneItemId,
      sceneItemIndex: item.sceneItemIndex,
      sceneItemEnabled: item.sceneItemEnabled,
      transform: (await obs.call("GetSceneItemTransform", { sceneName, sceneItemId: item.sceneItemId })).sceneItemTransform as unknown as Record<string, number>,
    })));
  }
  return result;
}

export function briefScenes(items: SceneSnapshot): Record<string, Array<{ name: string; id: number; index: number; enabled: boolean }>> {
  return Object.fromEntries(Object.entries(items).map(([scene, entries]) => [
    scene, entries.map(({ sourceName, sceneItemId, sceneItemIndex, sceneItemEnabled }) => ({
      name: sourceName, id: sceneItemId, index: sceneItemIndex, enabled: sceneItemEnabled,
    })),
  ]));
}

export async function restoreItemTransform(obs: OBSWebSocket, sceneName: string, item: SceneItemSnapshot): Promise<void> {
  const t = item.transform;
  const target: Record<string, unknown> = {
    positionX: t.positionX, positionY: t.positionY, rotation: t.rotation, scaleX: t.scaleX, scaleY: t.scaleY,
    alignment: t.alignment, boundsType: t.boundsType, boundsAlignment: t.boundsAlignment,
    cropLeft: t.cropLeft, cropRight: t.cropRight, cropTop: t.cropTop, cropBottom: t.cropBottom,
  };
  if (t.boundsWidth > 0) target.boundsWidth = t.boundsWidth;
  if (t.boundsHeight > 0) target.boundsHeight = t.boundsHeight;
  await obs.call("SetSceneItemTransform", { sceneName, sceneItemId: item.sceneItemId, sceneItemTransform: target } as never);
  await obs.call("SetSceneItemEnabled", { sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: item.sceneItemEnabled });
}
