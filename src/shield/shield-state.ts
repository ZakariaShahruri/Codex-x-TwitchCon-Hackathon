import type { ShieldStatus } from "../shared/events.js";

export interface ShieldStateSnapshot { status: ShieldStatus; reason?: string; at: number }

/** Detection arming, panic override and recoverable degraded reason for the Track A lifecycle. */
export class ShieldStateMachine {
  private armed: boolean;
  private panicActive = false;
  private degradedReason: string | undefined;
  private lastPublished = "";

  constructor(
    armOnStart: boolean,
    private readonly publish: (state: ShieldStateSnapshot) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.armed = armOnStart;
  }

  get isArmed(): boolean { return this.armed; }
  get isPanicked(): boolean { return this.panicActive; }
  get reason(): string | undefined { return this.degradedReason; }

  start(): void { this.publishIfChanged(); }

  command(action: "on" | "off" | "panic" | "unblur"): void {
    switch (action) {
      case "on": this.armed = true; break;
      case "off": this.armed = false; break;
      case "panic": this.panicActive = true; break;
      case "unblur": this.panicActive = false; break;
    }
    this.publishIfChanged();
  }

  degrade(reason: string): void {
    this.degradedReason = reason;
    this.publishIfChanged();
  }

  recover(): void {
    if (this.degradedReason === undefined) return;
    this.degradedReason = undefined;
    this.publishIfChanged();
  }

  private publishIfChanged(): void {
    const status: ShieldStatus = this.panicActive ? "panic" : this.degradedReason ? "degraded" : this.armed ? "armed" : "off";
    const key = `${status}\u0000${this.degradedReason ?? ""}`;
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    const state: ShieldStateSnapshot = { status, at: this.now() };
    if (this.degradedReason) state.reason = this.degradedReason;
    this.publish(state);
  }
}
