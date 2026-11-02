const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const TOKEN_HELP = 'Get a new token with `twitch token --user-token --scopes "user:read:chat user:write:chat user:bot"`, then update TWITCH_BOT_TOKEN and TWITCH_BOT_REFRESH_TOKEN.';

type Logger = Pick<Console, "log" | "warn" | "error">;

export interface TokenManagerOptions {
  clientId: string;
  accessToken: string;
  clientSecret?: string;
  refreshToken?: string;
  fetch?: typeof fetch;
  logger?: Logger;
  renewalBufferMs?: number;
}

/** Holds Twitch credentials only in memory and renews them without ever logging their values. */
export function createTokenManager(options: TokenManagerOptions) {
  const fetcher = options.fetch ?? fetch;
  const logger = options.logger ?? console;
  const canRefresh = Boolean(options.clientSecret && options.refreshToken);
  const renewalBufferMs = options.renewalBufferMs ?? 5 * 60_000;
  let accessToken = options.accessToken.replace(/^oauth:/i, "");
  let refreshToken = options.refreshToken;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let refreshInFlight: Promise<boolean> | undefined;

  const clearRenewal = () => {
    if (renewalTimer) clearTimeout(renewalTimer);
    renewalTimer = undefined;
  };

  const scheduleRenewal = (expiresIn: number) => {
    clearRenewal();
    if (!canRefresh || stopped) return;
    const delay = Math.max(0, expiresIn * 1_000 - renewalBufferMs);
    renewalTimer = setTimeout(() => {
      renewalTimer = undefined;
      void renew().then((ok) => {
        if (!ok && !stopped) scheduleRenewal(60);
      });
    }, delay);
    renewalTimer.unref?.();
  };

  const validateCurrent = async () => {
    const response = await fetcher(VALIDATE_URL, { headers: { Authorization: `OAuth ${accessToken}` } });
    if (!response.ok) return { ok: false as const, status: response.status };
    const data = await response.json() as { login?: unknown; expires_in?: unknown };
    const login = typeof data.login === "string" ? data.login : "unknown";
    const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) ? data.expires_in : 0;
    logger.log(`[twitch] token validated for ${login}; expires in ${(expiresIn / 3600).toFixed(2)} hours.`);
    scheduleRenewal(expiresIn);
    return { ok: true as const, status: response.status };
  };

  const renew = (): Promise<boolean> => {
    if (!canRefresh || stopped) return Promise.resolve(false);
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const body = new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret!,
          grant_type: "refresh_token",
          refresh_token: refreshToken!,
        });
        const response = await fetcher(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
        if (!response.ok) {
          logger.error(`[twitch] Token renewal failed (HTTP ${response.status}); the bot may need new credentials. ${TOKEN_HELP}`);
          return false;
        }
        const data = await response.json() as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
        if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string") {
          logger.error(`[twitch] Token renewal response was incomplete; the bot may need new credentials. ${TOKEN_HELP}`);
          return false;
        }
        accessToken = data.access_token;
        refreshToken = data.refresh_token;
        const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) ? data.expires_in : 14_400;
        logger.log(`[twitch] bot token renewed; expires in ${(expiresIn / 3600).toFixed(2)} hours.`);
        scheduleRenewal(expiresIn);
        return true;
      } catch {
        logger.error(`[twitch] Token renewal failed because Twitch could not be reached. ${TOKEN_HELP}`);
        return false;
      } finally {
        refreshInFlight = undefined;
      }
    })();
    return refreshInFlight;
  };

  const start = async () => {
    try {
      let result = await validateCurrent();
      if (!result.ok && result.status === 401 && canRefresh && await renew()) result = await validateCurrent();
      if (!result.ok) {
        if (result.status === 401) logger.error(`[twitch] Token validation returned 401: TWITCH_BOT_TOKEN is invalid or expired. ${TOKEN_HELP}`);
        else logger.warn(`[twitch] Token validation failed (HTTP ${result.status}); EventSub will continue and retry.`);
      }
    } catch {
      logger.warn("[twitch] Could not validate the bot token because Twitch could not be reached; EventSub will continue and retry.");
    }
  };

  const request = async (url: string, init: RequestInit = {}) => {
    const withToken = (token: string): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string> | undefined), "Client-Id": options.clientId, Authorization: `Bearer ${token}` } });
    let response = await fetcher(url, withToken(accessToken));
    if (response.status === 401) {
      if (canRefresh && await renew()) response = await fetcher(url, withToken(accessToken));
      if (response.status === 401) logger.error(`[twitch] Helix returned 401: TWITCH_BOT_TOKEN is invalid or expired. ${TOKEN_HELP}`);
    }
    return response;
  };

  const stop = () => { stopped = true; clearRenewal(); };
  return { start, request, renew, stop };
}
