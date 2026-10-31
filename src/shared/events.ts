/** Leak classifications shared across both tracks. */
export type LeakKind =
  | "api_key" | "email" | "password" | "phone" | "card" | "ip"
  | "seed_phrase" | "qr_code" | "watchlist" | "custom_rule" | "sensitive_region";

/** Canvas pixel coordinates. */
export interface Box { x: number; y: number; w: number; h: number }

export type ShieldStatus = "off" | "armed" | "degraded" | "panic";

/** Safe, non-sensitive rule metadata. Never include rule text, secrets, or watchlist values. */
export interface RuleSummary {
  id: string;
  description: string;
  detector: string;
}

/** A watchlist entry as typed in the dashboard. `value` is secret: it only travels in-process to Track A. */
export interface WatchlistEntryInput { label: string; value: string }

/** A saved watchlist entry without its value, safe to show anywhere. */
export interface WatchlistLabel { id: string; label: string }

/** A preview that has already been reduced to a safe label; never use raw detected text. */
export type RedactedPreview = string & { readonly __redactedPreview: unique symbol };

/** Marks a label as safe to broadcast. Only call it with text that contains no detected content. */
export function redacted(label: string): RedactedPreview {
  return label as RedactedPreview;
}

/**
 * Every preview is a redacted label only (for example, "email" or "sk-…9aF").
 * Secret contents and watchlist values never appear in A → B events, logs or files other than twitchy.private.json.
 */
export interface EventMap {
  /** A → B */
  "leak.detected": { id: string; kind: LeakKind; box: Box; preview: RedactedPreview; totalBlocked: number; at: number };
  /** A → B */
  "leak.cleared": { id: string; at: number };
  /** A → B */
  "shield.state": { status: ShieldStatus; reason?: string; at: number };
  /** A → B */
  "engine.metrics": { lastFrameMs: number; p95FrameMs: number; budgetMs: number; framesPerSec: number; at: number };
  /** A → B */
  "rules.compiled": { requestId: string; ok: boolean; rules?: RuleSummary[]; error?: string };
  /** A → B; the saved watchlist and rules, without values. Sent at startup and after every change. */
  "private.state": { watchlist: WatchlistLabel[]; rules: RuleSummary[]; at: number };
  /** B → A */
  "shield.command": { action: "on" | "off" | "panic" | "unblur"; by: string; at: number };
  /** B → A; the only event that carries watchlist values. Never forwarded to a browser or logged. */
  "config.updated": {
    watchlist?: { add?: WatchlistEntryInput[]; removeIds?: string[] };
    enabledDetectors?: LeakKind[];
    sensitiveRegions?: Box[];
    removedRuleIds?: string[];
  };
  /** B → A */
  "rules.compile": { requestId: string; text: string };
}

export type EventName = keyof EventMap;

/** The only events the web bridge may forward to browser pages (overlay, dashboard). */
export const browserEvents = [
  "leak.detected", "leak.cleared", "shield.state", "engine.metrics", "rules.compiled", "private.state",
] as const satisfies readonly EventName[];
