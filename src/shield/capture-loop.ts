import { createHash } from "node:crypto";
import OBSWebSocket from "obs-websocket-js";
import type { Config } from "../shared/config.js";
import type { LeakKind } from "../shared/events.js";
import { detectApiKeys, detectEmails, detectPasswords, detectSensitiveRegions, type LeakCandidate } from "./detectors/index.js";
import { AppleVisionOCR } from "./ocr/apple-vision.js";
import type { OCRService } from "./ocr/types.js";

export interface CaptureFrame {
  leaks: LeakCandidate[];
  unchanged: boolean;
  at: number;
}

export interface CaptureLoopOptions {
  capture: () => Promise<Uint8Array>;
  ocr: Pick<OCRService, "recognize">;
  intervalMs: number;
  enabledDetectors: readonly LeakKind[];
  sensitiveRegions: Config["sensitiveRegions"];
  onFrame: (frame: CaptureFrame) => void;
  onError?: (error: Error) => void;
}

type ManagedOCR = Pick<OCRService, "recognize"> & Partial<Pick<OCRService, "close">>;

/** Serial capture/OCR loop. Ticks arriving during work are deliberately dropped. */
export class CaptureLoop {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private previousFingerprint: string | undefined;
  private previousLeaks: LeakCandidate[] = [];

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
      const png = await this.options.capture();
      const fingerprint = createHash("sha256").update(png).digest("hex");
      const at = Date.now();
      if (fingerprint === this.previousFingerprint) {
        this.options.onFrame({ leaks: this.previousLeaks, unchanged: true, at });
        return true;
      }

      const lines = await this.options.ocr.recognize(png);
      const enabled = new Set(this.options.enabledDetectors);
      const leaks: LeakCandidate[] = [];
      if (enabled.has("api_key")) leaks.push(...detectApiKeys(lines));
      if (enabled.has("email")) leaks.push(...detectEmails(lines));
      if (enabled.has("password")) leaks.push(...detectPasswords(lines));
      if (enabled.has("sensitive_region")) leaks.push(...detectSensitiveRegions(this.options.sensitiveRegions));
      this.previousFingerprint = fingerprint;
      this.previousLeaks = leaks;
      this.options.onFrame({ leaks, unchanged: false, at });
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
  ocr?: ManagedOCR;
}): Promise<() => Promise<void>> {
  const url = config.env.OBS_WS_URL;
  if (!url) throw new Error("OBS_WS_URL is missing. Set it in .env before starting shield capture.");
  const obs = new OBSWebSocket();
  const ocr = options.ocr ?? new AppleVisionOCR({ level: "accurate" });
  try {
    await obs.connect(url, config.env.OBS_WS_PASSWORD);
    const loop = new CaptureLoop({
      capture: async () => {
        const result = await obs.call("GetSourceScreenshot", { sourceName: "Twitchy Content", imageFormat: "png" });
        const prefix = "data:image/png;base64,";
        if (!result.imageData.startsWith(prefix)) throw new Error("OBS Twitchy Content screenshot was not returned as PNG data");
        return Buffer.from(result.imageData.slice(prefix.length), "base64");
      },
      ocr,
      intervalMs: config.captureIntervalMs,
      enabledDetectors: config.enabledDetectors,
      sensitiveRegions: config.sensitiveRegions,
      onFrame: options.onFrame,
      onError: options.onError,
    });
    loop.start();
    return async () => {
      await loop.stop();
      if (options.ocr === undefined) await ocr.close?.();
      if (obs.identified) await obs.disconnect();
    };
  } catch (error) {
    if (options.ocr === undefined) await ocr.close?.();
    if (obs.identified) await obs.disconnect();
    throw new Error(`Could not start Twitchy Content capture: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
