import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import type { OCRBarcode, OCRService, OCRTextLine } from "./types.js";

const MAX_FRAME_BYTES = 128 * 1024 * 1024;
const MAX_STDOUT_LINE_BYTES = 32 * 1024 * 1024;
const STDERR_TAIL_BYTES = 2_000;
const MAX_PENDING_FRAMES = 8;
/** Vision loads its models on the first frame of each helper process: ~230–500 ms vs ~90 ms warm on 1080p. */
const COLD_START_TIMEOUT_MS = 2_000;

interface FrameResult {
  ok: boolean;
  width: number;
  height: number;
  text: OCRTextLine[];
  barcodes: OCRBarcode[];
  error: string | null;
}

interface PendingFrame {
  resolve: (result: FrameResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface ProcessState {
  child: ChildProcessWithoutNullStreams;
  pending: PendingFrame[];
  stdout: Buffer;
  stderr: Buffer;
  ended: boolean;
  /** False until the helper has answered once; the first frame gets the cold-start timeout. */
  warm: boolean;
  killTimer?: NodeJS.Timeout;
}

export interface AppleVisionOCROptions {
  executablePath?: string;
  level?: "fast" | "accurate";
  timeoutMs?: number;
  coldStartTimeoutMs?: number;
  onRestart?: () => void;
}

class HelperExitedError extends Error {}

/** A persistent, framed stdin/stdout client for the Apple Vision Swift helper. */
export class AppleVisionOCR implements OCRService {
  private readonly executablePath: string;
  private readonly level: "fast" | "accurate";
  private readonly timeoutMs: number;
  private readonly coldStartTimeoutMs: number;
  private readonly onRestart?: () => void;
  private readonly analyses = new WeakMap<Uint8Array, Promise<FrameResult>>();
  private processState: ProcessState | undefined;
  private closed = false;

  constructor(options: AppleVisionOCROptions = {}) {
    this.executablePath = options.executablePath ?? `${process.cwd()}/tools/ocr-vision/.build/twitchy-ocr`;
    this.level = options.level ?? "accurate";
    this.timeoutMs = options.timeoutMs ?? 500;
    this.coldStartTimeoutMs = options.coldStartTimeoutMs ?? Math.max(this.timeoutMs, COLD_START_TIMEOUT_MS);
    this.onRestart = options.onRestart;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error("OCR timeoutMs must be a positive integer");
    if (!Number.isInteger(this.coldStartTimeoutMs) || this.coldStartTimeoutMs < 1) throw new Error("OCR coldStartTimeoutMs must be a positive integer");
  }

  async recognize(png: Uint8Array): Promise<OCRTextLine[]> {
    return (await this.analyze(png)).text;
  }

  async barcodes(png: Uint8Array): Promise<OCRBarcode[]> {
    return (await this.analyze(png)).barcodes;
  }

  async close(): Promise<void> {
    this.closed = true;
    const state = this.processState;
    if (!state) return;
    const exited = new Promise<void>((resolve) => state.child.once("close", () => resolve()));
    this.stopState(state, new Error("Apple Vision OCR client closed"));
    let timeout: NodeJS.Timeout;
    await Promise.race([exited, new Promise<void>((resolve) => { timeout = setTimeout(resolve, 1_000); })]);
    clearTimeout(timeout!);
    if (state.child.exitCode === null && state.child.signalCode === null) state.child.kill("SIGKILL");
  }

  private analyze(png: Uint8Array): Promise<FrameResult> {
    if (this.closed) return Promise.reject(new Error("Apple Vision OCR client is closed"));
    if (!(png instanceof Uint8Array) || png.byteLength === 0) return Promise.reject(new Error("OCR frame must be a non-empty PNG byte array"));
    if (png.byteLength > MAX_FRAME_BYTES) return Promise.reject(new Error(`OCR frame exceeds ${MAX_FRAME_BYTES} bytes`));

    const cached = this.analyses.get(png);
    if (cached) return cached;
    const result = this.submitWithRestart(png);
    this.analyses.set(png, result);
    void result.catch(() => this.analyses.delete(png));
    return result;
  }

  private async submitWithRestart(png: Uint8Array): Promise<FrameResult> {
    try {
      return await this.submit(png);
    } catch (error) {
      if (error instanceof HelperExitedError && !this.closed) {
        this.onRestart?.();
        return this.submit(png);
      }
      throw error;
    }
  }

  private submit(png: Uint8Array): Promise<FrameResult> {
    if (this.closed) return Promise.reject(new Error("Apple Vision OCR client is closed"));
    if (!existsSync(this.executablePath)) {
      return Promise.reject(new Error(`Apple Vision OCR helper not found at ${this.executablePath}; run npm run ocr:build first.`));
    }
    const state = this.getProcess();
    if (state.pending.length >= MAX_PENDING_FRAMES) {
      return Promise.reject(new Error(`Apple Vision OCR has ${MAX_PENDING_FRAMES} frames in flight; wait for a result before submitting more.`));
    }

    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(png.byteLength);
    const packet = Buffer.concat([header, Buffer.from(png.buffer, png.byteOffset, png.byteLength)]);

    const timeoutMs = state.warm ? this.timeoutMs : this.coldStartTimeoutMs;
    return new Promise<FrameResult>((resolve, reject) => {
      const pending: PendingFrame = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.stopState(state, new Error(`Apple Vision OCR frame timed out after ${timeoutMs} ms; the helper was restarted. Retry the frame.`));
        }, timeoutMs),
      };
      state.pending.push(pending);
      state.child.stdin.write(packet, (error) => {
        if (error) this.stopState(state, new HelperExitedError(`Apple Vision OCR helper stdin failed: ${error.message}`));
      });
    });
  }

  private getProcess(): ProcessState {
    if (this.processState && !this.processState.ended) return this.processState;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.executablePath, ["--level", this.level], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      throw new Error(`Could not start Apple Vision OCR helper: ${error instanceof Error ? error.message : String(error)}`);
    }

    const state: ProcessState = { child, pending: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), ended: false, warm: false };
    this.processState = state;
    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(state, chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      state.stderr = Buffer.concat([state.stderr, chunk]).subarray(-STDERR_TAIL_BYTES);
    });
    // Writing to a helper that just died emits EPIPE here; unhandled, it would crash the whole engine.
    child.stdin.on("error", (error) => {
      this.stopState(state, new HelperExitedError(`Apple Vision OCR helper stdin failed: ${error.message}`));
    });
    child.on("error", (error) => {
      this.stopState(state, new HelperExitedError(`Could not run Apple Vision OCR helper: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (state.killTimer) clearTimeout(state.killTimer);
      const detail = state.stderr.toString("utf8").trim();
      const reason = `Apple Vision OCR helper exited (code ${String(code)}, signal ${String(signal)})${detail ? `: ${detail}` : ""}; it will restart on the next frame.`;
      this.stopState(state, new HelperExitedError(reason));
    });
    return state;
  }

  private consumeStdout(state: ProcessState, chunk: Buffer): void {
    state.stdout = Buffer.concat([state.stdout, chunk]);
    if (state.stdout.byteLength > MAX_STDOUT_LINE_BYTES && !state.stdout.includes(0x0a)) {
      this.stopState(state, new Error(`Apple Vision OCR helper response exceeded ${MAX_STDOUT_LINE_BYTES} bytes.`));
      return;
    }
    while (true) {
      const newline = state.stdout.indexOf(0x0a);
      if (newline < 0) return;
      const line = state.stdout.subarray(0, newline).toString("utf8").trim();
      state.stdout = state.stdout.subarray(newline + 1);
      if (!line) continue;
      const pending = state.pending.shift();
      if (!pending) {
        this.stopState(state, new Error("Apple Vision OCR helper wrote an unsolicited response line."));
        return;
      }
      clearTimeout(pending.timeout);
      state.warm = true;
      let result: FrameResult;
      try {
        result = JSON.parse(line) as FrameResult;
      } catch {
        pending.reject(new Error("Apple Vision OCR helper returned invalid JSON; the helper was restarted."));
        this.stopState(state, new Error("Apple Vision OCR helper returned invalid JSON."));
        return;
      }
      if (!this.isFrameResult(result)) {
        pending.reject(new Error("Apple Vision OCR helper returned an invalid frame result; the helper was restarted."));
        this.stopState(state, new Error("Apple Vision OCR helper returned an invalid frame result."));
        return;
      }
      if (!result.ok) pending.reject(new Error(`Apple Vision OCR rejected the PNG frame: ${result.error ?? "unknown image error"}`));
      else pending.resolve(result);
    }
  }

  private isFrameResult(value: FrameResult): boolean {
    return typeof value === "object" && value !== null && typeof value.ok === "boolean" &&
      Number.isInteger(value.width) && Number.isInteger(value.height) &&
      Array.isArray(value.text) && Array.isArray(value.barcodes);
  }

  private stopState(state: ProcessState, error: Error): void {
    if (state.ended) return;
    state.ended = true;
    if (this.processState === state) this.processState = undefined;
    for (const pending of state.pending.splice(0)) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    if (state.child.exitCode === null && state.child.signalCode === null) {
      state.child.kill("SIGTERM");
      state.killTimer = setTimeout(() => {
        if (state.child.exitCode === null && state.child.signalCode === null) state.child.kill("SIGKILL");
      }, 500);
      state.killTimer.unref();
    }
  }
}
