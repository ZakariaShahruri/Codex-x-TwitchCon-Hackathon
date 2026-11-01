import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { StartTrack } from "../shared/track.js";
import { redacted, type EventMap } from "../shared/events.js";
import { connectContentCapture, type CaptureFrame, type ContentCaptureHandle } from "./capture-loop.js";
import { ShieldStateMachine } from "./shield-state.js";

interface ActiveLeak {
  id: string;
  expiresAt: number;
}

function p95(samples: readonly number[]): number {
  if (!samples.length) return 0;
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0;
}

export const start: StartTrack = async (bus, config) => {
  const state = new ShieldStateMachine(config.armOnStart, (snapshot) => {
    bus.emit("shield.state", snapshot);
    console.log(`Shield state: ${snapshot.status}${snapshot.reason ? ` (${snapshot.reason})` : ""}`);
  });
  state.start();

  const holdMs = config.delayMs + config.safetyMarginMs;
  const budgetMs = Math.max(0, config.delayMs - config.safetyMarginMs - config.captureIntervalMs);
  const activeLeaks = new Map<string, ActiveLeak>();
  const pendingMaskCommands: Array<"panic" | "unblur"> = [];
  const frameSamples: number[] = [];
  let totalBlocked = 0;
  let frameCount = 0;
  let lastFrameMs = 0;
  let metricWindowAt = Date.now();
  let capture: ContentCaptureHandle | undefined;
  let connectionAttempt: Promise<void> | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let reconnectDelayMs = 250;
  let stopping = false;
  let lastError = "";
  let terminal: ReadlineInterface | undefined;

  const clearLeakEvents = (at: number): void => {
    for (const leak of activeLeaks.values()) bus.emit("leak.cleared", { id: leak.id, at });
    activeLeaks.clear();
  };

  const commandListener = async (command: EventMap["shield.command"]): Promise<void> => {
    state.command(command.action);
    if (command.action !== "panic" && command.action !== "unblur") return;
    if (!capture) {
      pendingMaskCommands.push(command.action);
      return;
    }
    try {
      if (command.action === "panic") await capture.masks.panicNow();
      else {
        await capture.masks.unblur();
        clearLeakEvents(command.at);
      }
    } catch (error) {
      pendingMaskCommands.push(command.action);
      state.degrade(error instanceof Error ? error.message : String(error));
      console.error(`Shield ${command.action} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  bus.on("shield.command", commandListener);

  const onFrame = async (frame: CaptureFrame): Promise<void> => {
    if (capture && pendingMaskCommands.length) await applyPendingMaskCommands(capture.masks, frame.at);
    frameCount += 1;
    lastFrameMs = frame.totalMs;
    frameSamples.push(frame.totalMs);
    if (frameSamples.length > 120) frameSamples.shift();

    if (process.env.DEBUG === "1" || process.env.DEBUG === "true") {
      console.log(`capture ${frame.captureMs.toFixed(1)}ms · ocr ${frame.ocrMs.toFixed(1)}ms · detect ${frame.detectMs.toFixed(1)}ms · mask ${(frame.maskMs ?? 0).toFixed(1)}ms · total ${frame.totalMs.toFixed(1)}ms`);
    }
    if (frame.totalMs > budgetMs) {
      const reason = `frame over budget (${frame.totalMs.toFixed(1)}ms > ${budgetMs.toFixed(1)}ms)`;
      state.degrade(reason);
      if (lastError !== reason) console.error(`Shield degraded: ${reason}`);
      lastError = reason;
    } else {
      state.recover();
      lastError = "";
    }

    for (const candidate of frame.leaks) {
      if (capture?.masks.isIgnored(candidate.fingerprint)) continue;
      let leak = activeLeaks.get(candidate.fingerprint);
      if (!leak) {
        leak = { id: randomUUID(), expiresAt: frame.at + holdMs };
        activeLeaks.set(candidate.fingerprint, leak);
        totalBlocked += 1;
        bus.emit("leak.detected", {
          id: leak.id,
          kind: candidate.kind,
          box: candidate.box,
          preview: redacted(candidate.preview),
          totalBlocked,
          at: frame.at,
        });

        const capturedAt = frame.firstSeenAt?.get(candidate.fingerprint) ?? frame.capturedAt;
        const captureToMaskMs = Math.max(0, performance.now() - capturedAt);
        const worstCaseMs = config.captureIntervalMs + captureToMaskMs;
        const safe = worstCaseMs < config.delayMs - config.safetyMarginMs;
        console.log(`Leak #${totalBlocked} ${candidate.kind}: capture-to-mask ${captureToMaskMs.toFixed(1)}ms / ${config.delayMs}ms delay; worst case incl. ${config.captureIntervalMs}ms capture interval ${worstCaseMs.toFixed(1)}ms / ${config.delayMs - config.safetyMarginMs}ms available (${safe ? "within budget" : "OVER BUDGET"}).`);
      } else {
        leak.expiresAt = frame.at + holdMs;
      }
    }

    for (const [fingerprint, leak] of activeLeaks) {
      if (leak.expiresAt > frame.at) continue;
      bus.emit("leak.cleared", { id: leak.id, at: frame.at });
      activeLeaks.delete(fingerprint);
    }
  };

  const onCaptureError = (error: Error): void => {
    state.degrade(error.message);
    if (lastError !== error.message) console.error(`Shield degraded: ${error.message}`);
    lastError = error.message;
  };

  const applyPendingMaskCommands = async (masks: ContentCaptureHandle["masks"], at: number): Promise<void> => {
    const queued = pendingMaskCommands.splice(0);
    for (let index = 0; index < queued.length; index += 1) {
      try {
        const action = queued[index]!;
        if (action === "panic") await masks.panicNow();
        else {
          await masks.unblur();
          clearLeakEvents(at);
        }
      } catch (error) {
        pendingMaskCommands.unshift(...queued.slice(index));
        throw error;
      }
    }
  };

  const attemptConnection = async (): Promise<void> => {
    if (stopping || !config.env.OBS_WS_URL) return;
    let connected: ContentCaptureHandle | undefined;
    try {
      connected = await connectContentCapture(config, {
        onFrame,
        onError: onCaptureError,
        isArmed: () => state.isArmed,
      });
      if (stopping) {
        await connected.stop();
        return;
      }
      capture = connected;
      await applyPendingMaskCommands(connected.masks, Date.now());
      if (state.isPanicked) await connected.masks.panicNow();
      connected.start();
      reconnectDelayMs = 250;
      lastError = "";
      state.recover();
    } catch (error) {
      capture = undefined;
      if (connected) {
        try { await connected.stop(); }
        catch (stopError) { console.error(`Shield cleanup after failed OBS setup: ${stopError instanceof Error ? stopError.message : String(stopError)}`); }
      }
      onCaptureError(error instanceof Error ? error : new Error(String(error)));
      if (stopping) return;
      const waitMs = reconnectDelayMs;
      reconnectDelayMs = Math.min(8_000, reconnectDelayMs * 2);
      console.error(`Shield OBS retry scheduled in ${waitMs}ms.`);
      retryTimer = setTimeout(() => {
        connectionAttempt = attemptConnection().finally(() => { connectionAttempt = undefined; });
      }, waitMs);
      retryTimer.unref();
    }
  };

  const metricsTimer = setInterval(() => {
    const now = Date.now();
    const elapsedSeconds = Math.max(0.001, (now - metricWindowAt) / 1_000);
    bus.emit("engine.metrics", {
      lastFrameMs,
      p95FrameMs: p95(frameSamples),
      budgetMs,
      framesPerSec: frameCount / elapsedSeconds,
      at: now,
    });
    if (process.env.DEBUG === "1" || process.env.DEBUG === "true")
      console.log(`engine.metrics: last ${lastFrameMs.toFixed(1)}ms · p95 ${p95(frameSamples).toFixed(1)}ms · budget ${budgetMs.toFixed(1)}ms · ${ (frameCount / elapsedSeconds).toFixed(1)} fps`);
    frameCount = 0;
    frameSamples.length = 0;
    metricWindowAt = now;
  }, 1_000);
  metricsTimer.unref();

  if (config.env.OBS_WS_URL) await attemptConnection();
  else onCaptureError(new Error("OBS_WS_URL is missing; shield capture is unavailable."));

  if (process.env.TWITCHY_DEV_COMMANDS === "1") {
    terminal = createInterface({ input: process.stdin, output: process.stdout });
    console.log("Shield dev commands: on, off, panic, unblur, quit");
    terminal.on("line", (raw) => {
      const action = raw.trim().toLowerCase();
      if (action === "quit" || action === "q") { process.kill(process.pid, "SIGINT"); return; }
      if (action === "on" || action === "off" || action === "panic" || action === "unblur")
        bus.emit("shield.command", { action, by: "local dev command", at: Date.now() });
      else console.log("Enter on, off, panic, unblur, or quit.");
    });
  }

  return async () => {
    if (stopping) return;
    stopping = true;
    bus.off("shield.command", commandListener);
    if (retryTimer) clearTimeout(retryTimer);
    clearInterval(metricsTimer);
    terminal?.close();
    await connectionAttempt;
    const current = capture;
    await current?.stop();
    if (current && !current.masks.panic) clearLeakEvents(Date.now());
    capture = undefined;
  };
};
