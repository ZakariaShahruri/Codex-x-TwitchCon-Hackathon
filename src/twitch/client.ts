import { parseChatNotification } from "./chat.js";

const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";
const SUBSCRIPTIONS = [
  { type: "channel.chat.message", version: "1", condition: (broadcaster: string, bot: string) => ({ broadcaster_user_id: broadcaster, user_id: bot }) },
  { type: "stream.online", version: "1", condition: (broadcaster: string) => ({ broadcaster_user_id: broadcaster }) },
  { type: "stream.offline", version: "1", condition: (broadcaster: string) => ({ broadcaster_user_id: broadcaster }) },
] as const;
const HELIX_SUBSCRIPTIONS_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";
const TOKEN_HELP = 'Get a replacement with `twitch token --user-token --scopes "user:read:chat user:write:chat user:bot"`, then update TWITCH_BOT_TOKEN.';

interface SocketMessage { data: unknown }
interface SocketClose { code?: number; reason?: string }
export interface EventSubSocket {
  readyState?: number;
  addEventListener(type: string, listener: (event: any) => void, options?: unknown): void;
  close(code?: number, reason?: string): void;
}
type Timer = ReturnType<typeof setTimeout>;
type Logger = Pick<Console, "log" | "warn" | "error">;
type SocketRole = "active" | "candidate";
interface Connection {
  socket: EventSubSocket;
  url: string;
  role: SocketRole;
  previous?: Connection;
  inheritedSubscriptions: boolean;
  sessionId?: string;
  keepaliveSeconds?: number;
  subscribed: boolean;
  welcomeTimer?: Timer;
  keepaliveTimer?: Timer;
}

export interface EventSubDependencies {
  createSocket?: (url: string) => EventSubSocket;
  fetch?: typeof fetch;
  logger?: Logger;
  keepaliveGraceMs?: number;
  welcomeTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  authRetryMs?: number;
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" ? value as Record<string, any> : undefined;
}

/** Creates the Twitch track with replaceable edges for recorded-message tests. */
export function createEventSubTrack(dependencies: EventSubDependencies = {}) {
  const createSocket = dependencies.createSocket ?? ((url: string) => new WebSocket(url));
  const fetcher = dependencies.fetch ?? fetch;
  const logger = dependencies.logger ?? console;
  const keepaliveGraceMs = dependencies.keepaliveGraceMs ?? 3_000;
  const welcomeTimeoutMs = dependencies.welcomeTimeoutMs ?? 15_000;
  const retryBaseMs = dependencies.retryBaseMs ?? 1_000;
  const retryMaxMs = dependencies.retryMaxMs ?? 30_000;
  const authRetryMs = dependencies.authRetryMs ?? 60_000;

  return async (_bus: unknown, config: { env?: Record<string, string | undefined> }) => {
    const env = config?.env ?? {};
    const required = ["TWITCH_CLIENT_ID", "TWITCH_BOT_TOKEN", "TWITCH_BOT_USER_ID", "TWITCH_BROADCASTER_ID"] as const;
    const missing = required.filter((name) => !env[name]?.trim());
    if (missing.length) {
      logger.warn(`[twitch] disabled: missing ${missing.join(", ")}; Twitch EventSub will not start.`);
      return async () => {};
    }

    const clientId = env.TWITCH_CLIENT_ID!;
    const token = env.TWITCH_BOT_TOKEN!.replace(/^oauth:/i, "");
    const botId = env.TWITCH_BOT_USER_ID!;
    const broadcasterId = env.TWITCH_BROADCASTER_ID!;
    const headers = {
      "Client-Id": clientId,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const sockets = new Set<Connection>();
    let active: Connection | undefined;
    let candidate: Connection | undefined;
    let reconnectTimer: Timer | undefined;
    let candidateRetryTimer: Timer | undefined;
    let retryAttempt = 0;
    let stopped = false;

    const clearConnectionTimers = (connection: Connection) => {
      if (connection.welcomeTimer) clearTimeout(connection.welcomeTimer);
      if (connection.keepaliveTimer) clearTimeout(connection.keepaliveTimer);
      connection.welcomeTimer = undefined;
      connection.keepaliveTimer = undefined;
    };

    const removeConnection = (connection: Connection, closeSocket: boolean) => {
      if (!sockets.delete(connection)) return false;
      clearConnectionTimers(connection);
      if (active === connection) active = undefined;
      if (candidate === connection) candidate = undefined;
      if (closeSocket) {
        try { connection.socket.close(); } catch { /* A closed socket needs no further cleanup. */ }
      }
      return true;
    };

    const scheduleReconnect = (delay?: number) => {
      if (stopped || active || candidate || reconnectTimer) return;
      const backoff = Math.min(retryBaseMs * (2 ** retryAttempt), retryMaxMs);
      retryAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        if (!stopped && !active && !candidate) {
          try { openConnection(EVENTSUB_URL, "active", undefined, false); }
          catch (error) {
            logger.error(`[twitch] Could not open EventSub socket (${error instanceof Error ? error.message : "socket error"}); retrying.`);
            scheduleReconnect();
          }
        }
      }, delay ?? backoff);
    };

    const scheduleCandidateRetry = (url: string, previous: Connection) => {
      if (stopped || candidateRetryTimer) return;
      const delay = Math.min(retryBaseMs * (2 ** retryAttempt), retryMaxMs);
      retryAttempt += 1;
      logger.warn(`[twitch] EventSub handover socket failed; retrying the supplied reconnect URL in ${delay} ms while the current socket stays open.`);
      candidateRetryTimer = setTimeout(() => {
        candidateRetryTimer = undefined;
        if (!stopped && !candidate && active === previous) {
          try { openConnection(url, "candidate", previous, true); }
          catch (error) {
            logger.warn(`[twitch] Could not open EventSub reconnect URL (${error instanceof Error ? error.message : "socket error"}); retaining the current socket.`);
            scheduleCandidateRetry(url, previous);
          }
        }
        else if (!stopped && !active && !candidate) scheduleReconnect();
      }, delay);
    };

    const failConnection = (connection: Connection, reason: string) => {
      const wasActive = active === connection;
      const wasCandidate = candidate === connection;
      const previous = connection.previous;
      const url = connection.url;
      if (!removeConnection(connection, true)) return;
      if (stopped) return;
      logger.warn(`[twitch] EventSub ${wasCandidate ? "replacement " : ""}socket ${reason}.`);
      if (wasCandidate && previous && active === previous) scheduleCandidateRetry(url, previous);
      else if (!active && !candidate) scheduleReconnect();
    };

    const startWelcomeTimer = (connection: Connection) => {
      if (connection.welcomeTimer) clearTimeout(connection.welcomeTimer);
      connection.welcomeTimer = setTimeout(() => failConnection(connection, "did not send a welcome message in time; reconnecting"), welcomeTimeoutMs);
    };

    const startKeepaliveTimer = (connection: Connection) => {
      if (connection.welcomeTimer) clearTimeout(connection.welcomeTimer);
      connection.welcomeTimer = undefined;
      if (connection.keepaliveTimer) clearTimeout(connection.keepaliveTimer);
      const timeoutMs = Math.max(0, (connection.keepaliveSeconds ?? 10) * 1_000 + keepaliveGraceMs);
      connection.keepaliveTimer = setTimeout(() => failConnection(connection, `missed keepalive for ${timeoutMs} ms; reconnecting`), timeoutMs);
    };

    const makeSubscriptionBody = (type: typeof SUBSCRIPTIONS[number]["type"], sessionId: string) => {
      const definition = SUBSCRIPTIONS.find((item) => item.type === type)!;
      const condition = definition.type === "channel.chat.message"
        ? definition.condition(broadcasterId, botId)
        : definition.condition(broadcasterId);
      return { type: definition.type, version: definition.version, condition, transport: { method: "websocket", session_id: sessionId } };
    };

    const postSubscription = async (type: typeof SUBSCRIPTIONS[number]["type"], sessionId: string) => {
      const response = await fetcher(HELIX_SUBSCRIPTIONS_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(makeSubscriptionBody(type, sessionId)),
      });
      return response.status;
    };

    const authenticationFailed = (connection: Connection) => {
      logger.error(`[twitch] Helix returned 401: TWITCH_BOT_TOKEN is invalid or expired. ${TOKEN_HELP}`);
      if (!removeConnection(connection, true)) return;
      scheduleReconnect(authRetryMs);
    };

    const subscribeAll = async (connection: Connection) => {
      if (!connection.sessionId || connection.subscribed) return;
      const results = await Promise.all(SUBSCRIPTIONS.map(async ({ type }) => {
        try { return { type, status: await postSubscription(type, connection.sessionId!) }; }
        catch (error) { return { type, error }; }
      }));
      if (stopped || !sockets.has(connection)) return;
      const unauthorized = results.some((result) => "status" in result && result.status === 401);
      if (unauthorized) { authenticationFailed(connection); return; }
      const failures = results.filter((result) => "error" in result || ("status" in result && (result.status < 200 || result.status >= 300)));
      if (failures.length) {
        for (const failure of failures) {
          const detail = "error" in failure ? "network error" : `HTTP ${failure.status}`;
          logger.error(`[twitch] Could not create EventSub subscription ${failure.type} (${detail}); retrying with a fresh session.`);
        }
        failConnection(connection, "subscription setup failed; reconnecting");
        return;
      }
      connection.subscribed = true;
      retryAttempt = 0;
      logger.log("[twitch] EventSub subscriptions active: channel.chat.message, stream.online, stream.offline.");
    };

    const resubscribeRevoked = async (connection: Connection, type: string, status: string) => {
      const recoverable = status === "version_removed" || status === "beta_maintenance";
      if (!recoverable || !connection.sessionId || !SUBSCRIPTIONS.some((item) => item.type === type)) {
        if (status === "authorization_revoked") logger.error(`[twitch] Reauthorize the bot token and restart EventSub. ${TOKEN_HELP}`);
        if (status === "user_removed") logger.error("[twitch] Verify TWITCH_BOT_USER_ID and TWITCH_BROADCASTER_ID; Twitch removed a user referenced by the subscription.");
        return;
      }
      try {
        const code = await postSubscription(type as typeof SUBSCRIPTIONS[number]["type"], connection.sessionId);
        if (code === 401) { authenticationFailed(connection); return; }
        if (code >= 200 && code < 300) logger.log(`[twitch] Resubscribed to ${type} after recoverable revocation (${status}).`);
        else logger.error(`[twitch] Could not resubscribe to ${type} after ${status} (HTTP ${code}); it will be retried with a fresh session.`);
      } catch {
        logger.error(`[twitch] Network error resubscribing to ${type} after ${status}; it will be retried with a fresh session.`);
        failConnection(connection, "recoverable revocation resubscribe failed; reconnecting");
      }
    };

    const promoteCandidate = (connection: Connection) => {
      if (candidate !== connection) return false;
      const previous = connection.previous;
      candidate = undefined;
      connection.role = "active";
      active = connection;
      if (previous && previous !== connection) removeConnection(previous, true);
      retryAttempt = 0;
      logger.log("[twitch] EventSub reconnect handover complete.");
      return true;
    };

    const onWelcome = async (connection: Connection, session: Record<string, any>) => {
      connection.sessionId = typeof session.id === "string" ? session.id : undefined;
      connection.keepaliveSeconds = Number.isFinite(session.keepalive_timeout_seconds) ? session.keepalive_timeout_seconds : 10;
      startKeepaliveTimer(connection);
      if (!connection.sessionId) { failConnection(connection, "welcome message had no session ID; reconnecting"); return; }
      if (connection.role === "candidate") {
        if (!connection.inheritedSubscriptions) {
          failConnection(connection, "replacement session cannot inherit subscriptions; reconnecting");
          return;
        }
        connection.subscribed = true;
        promoteCandidate(connection);
        return;
      }
      if (connection !== active) return;
      await subscribeAll(connection);
    };

    const handleMessage = async (connection: Connection, data: unknown) => {
      if (!sockets.has(connection)) return;
      if (connection.keepaliveSeconds === undefined) startWelcomeTimer(connection);
      else startKeepaliveTimer(connection);
      let message: unknown;
      try { message = JSON.parse(typeof data === "string" ? data : String(data)); }
      catch { logger.warn("[twitch] Ignoring malformed EventSub message."); return; }
      const frame = asRecord(message);
      const metadata = asRecord(frame?.metadata);
      const payload = asRecord(frame?.payload);
      if (!metadata || !payload || typeof metadata.message_type !== "string") return;

      switch (metadata.message_type) {
        case "session_welcome": {
          const session = asRecord(asRecord(payload.session)?.session) ?? asRecord(payload.session);
          if (session) await onWelcome(connection, session);
          return;
        }
        case "session_keepalive":
          return;
        case "session_reconnect": {
          const session = asRecord(payload.session);
          const url = session?.reconnect_url;
          if (typeof url !== "string" || !url) { logger.error("[twitch] EventSub reconnect message had no reconnect_url; keeping the current socket and retrying separately."); return; }
          if (candidate) removeConnection(candidate, true);
          try { openConnection(url, "candidate", connection, true); }
          catch (error) {
            logger.warn(`[twitch] Could not open EventSub reconnect URL (${error instanceof Error ? error.message : "socket error"}); keeping the current socket.`);
            scheduleCandidateRetry(url, connection);
          }
          return;
        }
        case "notification": {
          const parsed = parseChatNotification(message);
          if (parsed) logger.log(`chat ${parsed.user} [${parsed.badges.join(", ")}]: ${parsed.text}`);
          else {
            const subscription = asRecord(payload.subscription);
            const event = asRecord(payload.event);
            if (subscription?.type === "stream.online") logger.log(`[twitch] stream.online${typeof event?.broadcaster_user_name === "string" ? `: ${event.broadcaster_user_name}` : "."}`);
            if (subscription?.type === "stream.offline") logger.log(`[twitch] stream.offline${typeof event?.broadcaster_user_name === "string" ? `: ${event.broadcaster_user_name}` : "."}`);
          }
          return;
        }
        case "revocation": {
          const subscription = asRecord(payload.subscription);
          const type = typeof subscription?.type === "string" ? subscription.type : "unknown subscription";
          const status = typeof subscription?.status === "string" ? subscription.status : "unknown reason";
          logger.warn(`[twitch] EventSub revoked ${type}: ${status}.`);
          await resubscribeRevoked(connection, type, status);
          return;
        }
        default:
          return;
      }
    };

    function openConnection(url: string, role: SocketRole, previous?: Connection, inheritedSubscriptions = false) {
      if (stopped) return;
      const socket = createSocket(url);
      const connection: Connection = { socket, url, role, previous, inheritedSubscriptions, subscribed: false };
      sockets.add(connection);
      if (role === "candidate") candidate = connection;
      else active = connection;
      startWelcomeTimer(connection);
      socket.addEventListener("message", (event: SocketMessage) => { void handleMessage(connection, event.data).catch((error) => logger.error("[twitch] EventSub message handler failed:", error)); });
      socket.addEventListener("error", () => failConnection(connection, "socket error; reconnecting"));
      socket.addEventListener("close", (event: SocketClose) => {
        if (!sockets.has(connection)) return;
        const wasActive = active === connection;
        const wasCandidate = candidate === connection;
        removeConnection(connection, false);
        if (stopped) return;
        logger.warn(`[twitch] EventSub ${wasCandidate ? "replacement " : ""}socket closed${event.code ? ` (${event.code}${event.reason ? `: ${event.reason}` : ""})` : ""}.`);
        if (wasCandidate && previous && active === previous) scheduleCandidateRetry(url, previous);
        else if (!active && !candidate) scheduleReconnect();
        else if (wasActive && candidate) logger.warn("[twitch] Current EventSub socket closed while handover is in progress; waiting for the replacement welcome.");
      });
    }

    try { openConnection(EVENTSUB_URL, "active"); }
    catch (error) {
      logger.error(`[twitch] Could not open EventSub socket (${error instanceof Error ? error.message : "socket error"}); retrying.`);
      scheduleReconnect();
    }

    return async () => {
      if (stopped) return;
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (candidateRetryTimer) clearTimeout(candidateRetryTimer);
      reconnectTimer = undefined;
      candidateRetryTimer = undefined;
      for (const connection of [...sockets]) removeConnection(connection, true);
      active = undefined;
      candidate = undefined;
    };
  };
}
