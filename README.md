# Twitchy — Stream Shield

[![CI](https://github.com/ZakariaShahruri/Codex-x-TwitchCon-Hackathon/actions/workflows/ci.yml/badge.svg)](https://github.com/ZakariaShahruri/Codex-x-TwitchCon-Hackathon/actions/workflows/ci.yml)

## Run it

Requirements: Node.js 22+ and npm.

```sh
npm install
cp .env.example .env
npm run dev
```

Run the shared foundation checks with `npm test` and `npm run typecheck`. The shared loader allows service credentials to be absent; tracks validate credentials when they use those services.

## Run Track B

Configure the [Twitch CLI](https://dev.twitch.tv/docs/cli/) with the bot app's client ID and secret using `twitch configure`. On macOS, the CLI keeps these credentials in `~/Library/Application Support/twitch-cli/.twitch-cli.env`; keep that file private. Sign in as the bot account and request the chat token:

```sh
twitch token --user-token --scopes "user:read:chat user:write:chat user:bot"
```

Put the returned access token in `TWITCH_BOT_TOKEN`, its refresh token in `TWITCH_BOT_REFRESH_TOKEN`, and the app secret in `TWITCH_CLIENT_SECRET` in `.env`. Also set `TWITCH_CLIENT_ID`, `TWITCH_BOT_USER_ID`, and `TWITCH_BROADCASTER_ID`. Track B validates the access token and renews it in memory before expiry; it never logs credentials. If the bot is not the broadcaster, make it a moderator or have the broadcaster grant the app `channel:bot` authorization.

Run `npm run dev` and open the local streamer dashboard at `http://127.0.0.1:4173/dashboard/`. Use **Set up OBS** to install the scenes and masks, then add `http://127.0.0.1:4173/overlay/` as a transparent OBS Browser Source. The dashboard provides shield controls, private watchlist labels, live latency, leak history and an end-of-stream report; the optional experimental rules editor is collapsed by default. `npm run demo:events` previews the web track without Twitch or OBS. `npm run gauntlet` starts its own shield and web tracks and drives roughly 28 leak events over a minute; stop `npm run dev` first because both use the configured `webPort`. Add `-- --with-twitch` only when you want the gauntlet connected to Twitch chat.
