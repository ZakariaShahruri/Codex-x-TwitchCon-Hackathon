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

/** A preview that has already been reduced to a safe label; never use raw detected text. */
export type RedactedPreview = string & { readonly __redactedPreview: unique symbol };

/**
 * Every preview is a redacted label only (for example, "email" or "sk-…9aF").
 * Secret contents and watchlist values must never be included in any event payload.
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
  /** B → A */
  "shield.command": { action: "on" | "off" | "panic" | "unblur"; by: string; at: number };
  /** B → A; watchlistChanged is a notification, never watchlist content. */
  "config.updated": { watchlistChanged?: boolean; enabledDetectors?: LeakKind[]; sensitiveRegions?: Box[]; rules?: RuleSummary[] };
  /** B → A */
  "rules.compile": { requestId: string; text: string };
}

export type EventName = keyof EventMap;
