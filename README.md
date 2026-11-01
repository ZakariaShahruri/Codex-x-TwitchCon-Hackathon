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

## Twitch chat token

Install and configure the [Twitch CLI](https://dev.twitch.tv/docs/cli/) with your Twitch app's client ID and client secret. Register `http://localhost:3000` as an OAuth redirect URL for the app. Then sign in as the bot account and request a user token with the chat scopes:

```sh
twitch configure
twitch token --user-token --scopes "user:read:chat user:write:chat user:bot"
```

Copy the returned access token to `TWITCH_BOT_TOKEN` in `.env`, and set `TWITCH_BOT_USER_ID`, `TWITCH_BROADCASTER_ID`, and `TWITCH_CLIENT_ID`. Never commit the token or app secret. If the bot account is not the broadcaster, make it a moderator in the channel or have the broadcaster grant the app `channel:bot` authorization.
