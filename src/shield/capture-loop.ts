import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import OBSWebSocket from "obs-websocket-js";
import type { Config } from "../shared/config.js";
import type { LeakKind } from "../shared/events.js";
import { detectApiKeys, detectEmails, detectPasswords, detectSensitiveRegions, type LeakCandidate } from "./detectors/index.js";
import { MaskManager, type ExistingMask } from "./mask-manager.js";
import { AppleVisionOCR } from "./ocr/apple-vision.js";
import type { OCRService } from "./ocr/types.js";

export interface CaptureFrame {
  leaks: LeakCandidate[];
  unchanged: boolean;
  at: number;
  startedAt: number;
  capturedAt: number;
  captureMs: number;
  ocrMs: number;
  detectMs: number;
  totalMs: number;
  maskMs?: number;
  firstSeenAt?: ReadonlyMap<string, number>;
}

export interface CaptureLoopOptions {
  capture: () => Promise<Uint8Array>;
  ocr: Pick<OCRService, "recognize">;
  intervalMs: number;
  enabledDetectors: readonly LeakKind[];
  sensitiveRegions: Config["sensitiveRegions"];
  onFrame: (frame: CaptureFrame) => void | Promise<void>;
  onError?: (error: Error) => void;
  isArmed?: () => boolean;
}

type ManagedOCR = Pick<OCRService, "recognize"> & Partial<Pick<OCRService, "close">>;

export interface ContentCaptureHandle {
  masks: MaskManager;
  start(): void;
  stop(): Promise<void>;
}

/** Serial capture/OCR loop. Ticks arriving during work are deliberately dropped. */
export class CaptureLoop {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private previousFingerprint: string | undefined;
  private previousLeaks: LeakCandidate[] = [];
  private wasArmed = true;

  constructor(private readonly options: CaptureLoopOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1) throw new Error("capture intervalMs must be a positive integer");
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  /** Returns false when a previous tick is still capturing or processing. */
  async tick(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const startedAt = performance.now();
      const png = await this.options.capture();
      const capturedAt = performance.now();
      const captureMs = capturedAt - startedAt;
      const fingerprint = createHash("sha256").update(png).digest("hex");
      const at = Date.now();
      const baseTiming = { at, startedAt, capturedAt, captureMs, ocrMs: 0, detectMs: 0, totalMs: 0 };
      const armed = this.options.isArmed?.() ?? true;
      if (!armed) {
        const unchanged = fingerprint === this.previousFingerprint;
        this.previousFingerprint = fingerprint;
        this.previousLeaks = [];
        this.wasArmed = false;
        await this.options.onFrame({ ...baseTiming, leaks: [], unchanged, totalMs: performance.now() - startedAt });
        return true;
      }
      if (this.wasArmed && fingerprint === this.previousFingerprint) {
        await this.options.onFrame({ ...baseTiming, leaks: this.previousLeaks, unchanged: true, totalMs: performance.now() - startedAt });
        return true;
      }

      this.wasArmed = true;
      const ocrStartedAt = performance.now();
      const lines = await this.options.ocr.recognize(png);
      const ocrMs = performance.now() - ocrStartedAt;
      const detectStartedAt = performance.now();
      const enabled = new Set(this.options.enabledDetectors);
      const leaks: LeakCandidate[] = [];
      if (enabled.has("api_key")) leaks.push(...detectApiKeys(lines));
      if (enabled.has("email")) leaks.push(...detectEmails(lines));
      if (enabled.has("password")) leaks.push(...detectPasswords(lines));
      if (enabled.has("sensitive_region")) leaks.push(...detectSensitiveRegions(this.options.sensitiveRegions));
      const detectMs = performance.now() - detectStartedAt;
      this.previousFingerprint = fingerprint;
      this.previousLeaks = leaks;
      await this.options.onFrame({ ...baseTiming, leaks, unchanged: false, ocrMs, detectMs, totalMs: performance.now() - startedAt });
      return true;
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return true;
    } finally {
      this.busy = false;
    }
  }
}

/** Connects OBS and captures the undelayed Twitchy Content scene at its native canvas size. */
export async function connectContentCapture(config: Config, options: {
  onFrame: CaptureLoopOptions["onFrame"];
  onError?: CaptureLoopOptions["onError"];
  isArmed?: () => boolean;
  ocr?: ManagedOCR;
}): Promise<ContentCaptureHandle> {
  const url = config.env.OBS_WS_URL;
  if (!url) throw new Error("OBS_WS_URL is missing. Set it in .env before starting shield capture.");
  const obs = new OBSWebSocket();
  const ocr = options.ocr ?? new AppleVisionOCR({
    level: "accurate",
    onRestart: () => options.onError?.(new Error("Apple Vision OCR helper crashed; restarting and retrying the current frame.")),
  });
  let stopping = false;
  let stopped = false;
  let obsAvailable = false;
  let nextReconnectAt = 0;
  let reconnectDelayMs = 250;
  try {
    await obs.connect(url, config.env.OBS_WS_PASSWORD);
    const video = await obs.call("GetVideoSettings");
    const canvas = { width: video.baseWidth, height: video.baseHeight };
    const broadcast = "Twitchy Broadcast";
    type MaskSceneItem = { sourceName: string; sceneItemId: number; sceneItemEnabled: boolean };
    const loadMaskPool = async (): Promise<{ masks: MaskSceneItem[]; existingMasks: ExistingMask[] }> => {
      const rawSceneItems = (await obs.call("GetSceneItemList", { sceneName: broadcast })).sceneItems;
      const foundMasks = rawSceneItems.flatMap((item) =>
        typeof item.sourceName === "string" && typeof item.sceneItemId === "number" && typeof item.sceneItemEnabled === "boolean" && /^Twitchy Mask \d+$/.test(item.sourceName)
          ? [{ sourceName: item.sourceName, sceneItemId: item.sceneItemId, sceneItemEnabled: item.sceneItemEnabled }]
          : [],
      ).sort((a, b) => a.sourceName.localeCompare(b.sourceName, undefined, { numeric: true }));
      if (foundMasks.length < config.maskPoolSize)
        throw new Error(`OBS mask pool has ${foundMasks.length} sources but config requires ${config.maskPoolSize}; run npm run obs:setup.`);

      const existing: ExistingMask[] = [];
      for (const item of foundMasks) {
        if (!item.sceneItemEnabled) continue;
        const transform = (await obs.call("GetSceneItemTransform", { sceneName: broadcast, sceneItemId: item.sceneItemId })).sceneItemTransform;
        const x = transform.positionX, y = transform.positionY, w = transform.width, h = transform.height;
        if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number" ||
            ![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0)
          throw new Error(`Cannot safely recover enabled OBS mask ${item.sourceName}: its transform is unavailable; leaving it enabled.`);
        existing.push({ id: item.sourceName, box: { x, y, w, h } });
      }
      return { masks: foundMasks, existingMasks: existing };
    };
    let pool = await loadMaskPool();
    let masks = pool.masks;
    obsAvailable = true;
    const maskManager = new MaskManager({
      maskIds: masks.map((item) => item.sourceName),
      width: canvas.width,
      height: canvas.height,
      delayMs: config.delayMs,
      safetyMarginMs: config.safetyMarginMs,
      existingMasks: pool.existingMasks,
      backend: {
        place: async (maskId, box) => {
          const item = masks.find((candidate) => candidate.sourceName === maskId);
          if (!item) throw new Error(`OBS mask source disappeared: ${maskId}`);
          await obs.call("SetSceneItemTransform", {
            sceneName: broadcast,
            sceneItemId: item.sceneItemId,
            sceneItemTransform: {
              positionX: box.x, positionY: box.y, rotation: 0, scaleX: 1, scaleY: 1,
              alignment: 5, boundsType: "OBS_BOUNDS_STRETCH", boundsAlignment: 5,
              boundsWidth: box.w, boundsHeight: box.h,
              cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0,
            },
          });
        },
        enable: async (maskId, enabled) => {
          const item = masks.find((candidate) => candidate.sourceName === maskId);
          if (!item) throw new Error(`OBS mask source disappeared: ${maskId}`);
          await obs.call("SetSceneItemEnabled", { sceneName: broadcast, sceneItemId: item.sceneItemId, sceneItemEnabled: enabled });
        },
      },
    });
    const pendingLeaks = new Map<string, { candidate: LeakCandidate; firstSeenAt: number }>();
    const reconnect = async (): Promise<void> => {
      if (stopping) throw new Error("OBS reconnect cancelled during shield shutdown");
      const waitMs = nextReconnectAt - Date.now();
      if (waitMs > 0) throw new Error("OBS disconnected; reconnect retry is waiting for backoff.");
      try {
        if (obs.identified) await obs.disconnect();
        await obs.connect(url, config.env.OBS_WS_PASSWORD);
        pool = await loadMaskPool();
        masks = pool.masks;
        await maskManager.resync(pool.existingMasks);
        obsAvailable = true;
        nextReconnectAt = 0;
        reconnectDelayMs = 250;
      } catch (error) {
        obsAvailable = false;
        nextReconnectAt = Date.now() + reconnectDelayMs;
        reconnectDelayMs = Math.min(8_000, reconnectDelayMs * 2);
        throw new Error(`OBS reconnect failed; retrying with backoff: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    };
    const loop = new CaptureLoop({
      capture: async () => {
        if (!obsAvailable || !obs.identified) await reconnect();
        try {
          const result = await obs.call("GetSourceScreenshot", { sourceName: "Twitchy Content", imageFormat: "png" });
          const prefix = "data:image/png;base64,";
          if (!result.imageData.startsWith(prefix)) throw new Error("OBS Twitchy Content screenshot was not returned as PNG data");
          return Buffer.from(result.imageData.slice(prefix.length), "base64");
        } catch (error) {
          obsAvailable = false;
          nextReconnectAt = Date.now() + reconnectDelayMs;
          reconnectDelayMs = Math.min(8_000, reconnectDelayMs * 2);
          throw error;
        }
      },
      ocr,
      intervalMs: config.captureIntervalMs,
      enabledDetectors: config.enabledDetectors,
      sensitiveRegions: config.sensitiveRegions,
      isArmed: options.isArmed,
      onFrame: async (frame) => {
        for (const candidate of frame.leaks) {
          if (!pendingLeaks.has(candidate.fingerprint)) pendingLeaks.set(candidate.fingerprint, { candidate, firstSeenAt: frame.capturedAt });
        }
        const pending = [...pendingLeaks.values()];
        frame.leaks = pending.map((item) => item.candidate);
        frame.firstSeenAt = new Map(pending.map((item) => [item.candidate.fingerprint, item.firstSeenAt]));
        const maskStartedAt = performance.now();
        await maskManager.update(frame.leaks, frame.at);
        frame.maskMs = performance.now() - maskStartedAt;
        frame.totalMs = performance.now() - frame.startedAt;
        await options.onFrame(frame);
        pendingLeaks.clear();
      },
      onError: options.onError,
    });
    return {
      masks: maskManager,
      start: () => { loop.start(); },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        stopping = true;
        try {
          await loop.stop();
          await maskManager.stop();
        } finally {
          try {
            if (options.ocr === undefined) await ocr.close?.();
          } finally {
            if (obs.identified) await obs.disconnect();
          }
        }
      },
    };
  } catch (error) {
    if (options.ocr === undefined) await ocr.close?.();
    if (obs.identified) await obs.disconnect();
    throw new Error(`Could not start Twitchy Content capture: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
