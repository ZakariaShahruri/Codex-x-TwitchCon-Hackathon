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
