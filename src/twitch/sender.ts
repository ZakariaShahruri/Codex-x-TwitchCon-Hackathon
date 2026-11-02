import type { EventBus } from "../shared/bus.js";
import type { EventMap, LeakKind } from "../shared/events.js";
import type { createTokenManager } from "./token.js";

const CHAT_URL = "https://api.twitch.tv/helix/chat/messages";
const KIND_LABELS: Record<LeakKind, string> = {
  api_key: "api key", email: "email", password: "password", phone: "phone", card: "card",
  ip: "IP address", seed_phrase: "seed phrase", qr_code: "QR code", watchlist: "watchlist match",
  custom_rule: "custom rule", sensitive_region: "sensitive region",
};
type TokenManager = ReturnType<typeof createTokenManager>;
type Logger = Pick<Console, "log" | "warn" | "error">;

export interface ChatSenderOptions {
  bus: EventBus;
  token: TokenManager;
  broadcasterId: string;
  botId: string;
  logger?: Logger;
  batchMs?: number;
  messageGapMs?: number;
}

/** Queues public replies and batches safe leak kinds; previews never enter the sender. */
export function createChatSender(options: ChatSenderOptions) {
  const logger = options.logger ?? console;
  const batchMs = options.batchMs ?? 5_000;
  const messageGapMs = options.messageGapMs ?? 1_000;
  const pendingReplies: string[] = [];
  const pendingKinds: LeakKind[] = [];
  let leakReadyAt: number | undefined;
  let nextMessageAt = 0;
  let nextLeakAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let stopped = false;

  const leakListener = (leak: EventMap["leak.detected"]) => {
    pendingKinds.push(leak.kind);
    if (leakReadyAt === undefined) leakReadyAt = Date.now() + batchMs;
    schedule();
  };
  options.bus.on("leak.detected", leakListener);

  const schedule = (delay?: number) => {
    if (stopped || sending) return;
    if (timer) clearTimeout(timer);
    let wait = delay ?? Math.max(0, nextMessageAt - Date.now());
    if (!pendingReplies.length && pendingKinds.length) wait = Math.max(wait, (leakReadyAt ?? Date.now()) - Date.now(), nextLeakAt - Date.now());
    if (!pendingReplies.length && !pendingKinds.length) return;
    timer = setTimeout(() => { timer = undefined; void pump(); }, Math.max(0, wait));
    timer.unref?.();
  };

  const pump = async () => {
    if (stopped || sending || (!pendingReplies.length && !pendingKinds.length)) return;
    const now = Date.now();
    if (now < nextMessageAt) { schedule(nextMessageAt - now); return; }
    const isLeakBatch = pendingKinds.length > 0 && now >= Math.max(leakReadyAt ?? now, nextLeakAt);
    if (isLeakBatch && now < Math.max(leakReadyAt ?? now, nextLeakAt)) {
      schedule(Math.max(leakReadyAt ?? now, nextLeakAt) - now);
      return;
    }
    const kindsCount = isLeakBatch ? pendingKinds.length : 0;
    const message = isLeakBatch
      ? `🛡 Twitchy blocked ${kindsCount} leak${kindsCount === 1 ? "" : "s"}: ${pendingKinds.map((kind) => KIND_LABELS[kind]).join(", ")}`
      : pendingReplies[0]!;
    sending = true;
    let retryDelay: number | undefined;
    try {
      const response = await options.token.request(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ broadcaster_id: options.broadcasterId, sender_id: options.botId, message }),
      });
      if (response.status >= 200 && response.status < 300) {
        if (isLeakBatch) {
          pendingKinds.splice(0, kindsCount);
          leakReadyAt = pendingKinds.length ? Date.now() : undefined;
          nextLeakAt = Date.now() + 5_000;
        } else pendingReplies.shift();
        logger.log("[twitch] chat message sent.");
      } else if (response.status === 429) {
        const reset = Number(response.headers.get("Ratelimit-Reset"));
        retryDelay = Number.isFinite(reset) && reset > 0 ? Math.max(1_000, reset * 1_000 - Date.now()) : 5_000;
        logger.warn(`[twitch] Chat send rate limited; queued message will retry in ${retryDelay} ms.`);
      } else {
        retryDelay = 5_000;
        logger.warn(`[twitch] Chat send failed (HTTP ${response.status}); queued message will retry.`);
      }
    } catch {
      retryDelay = 5_000;
      logger.warn("[twitch] Chat send failed because Twitch could not be reached; queued message will retry.");
    } finally {
      sending = false;
      nextMessageAt = Date.now() + messageGapMs;
      schedule(retryDelay);
    }
  };

  return {
    sendReply(message: string) {
      if (stopped) return;
      pendingReplies.push(message);
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      options.bus.off("leak.detected", leakListener);
      pendingReplies.length = 0;
      pendingKinds.length = 0;
    },
    /** Read-only view useful for local diagnostics and tests; contains no leak previews. */
    pendingCounts: () => ({ replies: pendingReplies.length, leaks: pendingKinds.length }),
  };
}
