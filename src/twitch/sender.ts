import type { EventBus } from "../shared/bus.js";
import type { EventMap, LeakKind } from "../shared/events.js";
import type { createTokenManager } from "./token.js";

const CHAT_URL = "https://api.twitch.tv/helix/chat/messages";
/** Twitch rejects chat messages longer than 500 characters. */
export const MAX_CHAT_LENGTH = 500;
const MAX_PENDING_REPLIES = 20;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const KIND_LABELS: Record<LeakKind, [singular: string, plural: string]> = {
  api_key: ["api key", "api keys"], email: ["email", "emails"], password: ["password", "passwords"],
  phone: ["phone number", "phone numbers"], card: ["card number", "card numbers"], ip: ["IP address", "IP addresses"],
  seed_phrase: ["seed phrase", "seed phrases"], qr_code: ["QR code", "QR codes"],
  watchlist: ["watchlist match", "watchlist matches"], custom_rule: ["custom rule match", "custom rule matches"],
  sensitive_region: ["sensitive region", "sensitive regions"],
};
type TokenManager = ReturnType<typeof createTokenManager>;
type Logger = Pick<Console, "log" | "warn" | "error">;
type Outcome = { kind: "sent" } | { kind: "retry"; delayMs?: number } | { kind: "drop"; status: number };

export interface ChatSenderOptions {
  bus: EventBus;
  token: TokenManager;
  broadcasterId: string;
  botId: string;
  logger?: Logger;
  /** Minimum time between two leak announcements; the first leak of a batch also waits this long so a burst becomes one message. */
  batchMs?: number;
  messageGapMs?: number;
}

function fit(message: string): string {
  return message.length <= MAX_CHAT_LENGTH ? message : `${message.slice(0, MAX_CHAT_LENGTH - 1)}…`;
}

/** Builds one leak announcement from per-kind counts; previews never enter the sender. */
export function leakSummary(counts: ReadonlyMap<LeakKind, number>): string {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const parts = [...counts].map(([kind, count]) => `${count} ${KIND_LABELS[kind][count === 1 ? 0 : 1]}`);
  return fit(`🛡 Twitchy blocked ${total} leak${total === 1 ? "" : "s"}: ${parts.join(", ")}`);
}

/**
 * Sends public replies and batched leak announcements. Replies go first and never wait behind a failing
 * announcement. Only 429, 5xx and network errors are retried; any other rejection is dropped so the queue keeps moving.
 */
export function createChatSender(options: ChatSenderOptions) {
  const logger = options.logger ?? console;
  const batchMs = options.batchMs ?? 5_000;
  const messageGapMs = options.messageGapMs ?? 1_000;
  const pendingReplies: string[] = [];
  const leakCounts = new Map<LeakKind, number>();
  let leakReadyAt: number | undefined;
  let nextLeakAt = 0;
  let nextMessageAt = 0;
  let replyRetryAt = 0;
  let leakRetryAt = 0;
  let replyFailures = 0;
  let leakFailures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let stopped = false;

  const backoff = (failures: number) => Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
  const replyDueAt = () => Math.max(nextMessageAt, replyRetryAt);
  const leakDueAt = () => Math.max(nextMessageAt, leakRetryAt, nextLeakAt, leakReadyAt ?? 0);

  const schedule = () => {
    if (stopped || sending) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    const due = [
      ...(pendingReplies.length ? [replyDueAt()] : []),
      ...(leakCounts.size ? [leakDueAt()] : []),
    ];
    if (!due.length) return;
    timer = setTimeout(() => { timer = undefined; void pump(); }, Math.max(0, Math.min(...due) - Date.now()));
    timer.unref?.();
  };

  const leakListener = (leak: EventMap["leak.detected"]) => {
    if (stopped) return;
    leakCounts.set(leak.kind, (leakCounts.get(leak.kind) ?? 0) + 1);
    leakReadyAt ??= Date.now() + batchMs;
    schedule();
  };
  options.bus.on("leak.detected", leakListener);

  const send = async (message: string): Promise<Outcome> => {
    try {
      const response = await options.token.request(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ broadcaster_id: options.broadcasterId, sender_id: options.botId, message }),
      });
      if (response.status >= 200 && response.status < 300) return { kind: "sent" };
      if (response.status === 429) {
        const reset = Number(response.headers.get("Ratelimit-Reset"));
        return { kind: "retry", delayMs: Number.isFinite(reset) && reset > 0 ? Math.max(1_000, reset * 1_000 - Date.now()) : RETRY_BASE_MS };
      }
      if (response.status >= 500) return { kind: "retry" };
      return { kind: "drop", status: response.status };
    } catch {
      return { kind: "retry" };
    }
  };

  const pump = async () => {
    if (stopped || sending) return;
    const now = Date.now();
    const isReply = pendingReplies.length > 0 && now >= replyDueAt();
    const isLeak = !isReply && leakCounts.size > 0 && now >= leakDueAt();
    if (!isReply && !isLeak) { schedule(); return; }

    const sentCounts = new Map(isLeak ? leakCounts : []);
    const label = isReply ? "reply" : "leak announcement";
    sending = true;
    const outcome = await send(isReply ? pendingReplies[0]! : leakSummary(sentCounts));
    sending = false;
    if (stopped) return;
    nextMessageAt = Date.now() + messageGapMs;

    if (outcome.kind === "retry") {
      const failures = isReply ? ++replyFailures : ++leakFailures;
      const delayMs = outcome.delayMs ?? backoff(failures);
      if (isReply) replyRetryAt = Date.now() + delayMs;
      else leakRetryAt = Date.now() + delayMs;
      // A 429 limits the whole bot, so hold both queues until the reset.
      if (outcome.delayMs !== undefined) nextMessageAt = Math.max(nextMessageAt, Date.now() + delayMs);
      logger.warn(`[twitch] Chat ${label} not sent; retrying in ${delayMs} ms.`);
      schedule();
      return;
    }

    if (outcome.kind === "drop") logger.warn(`[twitch] Chat ${label} rejected by Twitch (HTTP ${outcome.status}); dropped so the queue keeps moving.`);
    else logger.log("[twitch] chat message sent.");
    if (isReply) {
      pendingReplies.shift();
      replyFailures = 0;
      replyRetryAt = 0;
    } else {
      for (const [kind, count] of sentCounts) {
        const left = (leakCounts.get(kind) ?? 0) - count;
        if (left > 0) leakCounts.set(kind, left);
        else leakCounts.delete(kind);
      }
      leakFailures = 0;
      leakRetryAt = 0;
      nextLeakAt = Date.now() + batchMs;
      leakReadyAt = leakCounts.size ? Date.now() : undefined;
    }
    schedule();
  };

  return {
    sendReply(message: string) {
      if (stopped) return;
      if (pendingReplies.length >= MAX_PENDING_REPLIES) {
        logger.warn("[twitch] Chat reply queue full; dropping the oldest reply.");
        pendingReplies.shift();
      }
      pendingReplies.push(fit(message));
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      options.bus.off("leak.detected", leakListener);
      pendingReplies.length = 0;
      leakCounts.clear();
    },
    /** Read-only view useful for local diagnostics and tests; contains no leak previews. */
    pendingCounts: () => ({ replies: pendingReplies.length, leaks: [...leakCounts.values()].reduce((sum, count) => sum + count, 0) }),
  };
}
