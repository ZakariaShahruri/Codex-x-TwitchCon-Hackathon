# Twitchy — Stream Shield

[![CI](https://github.com/ZakariaShahruri/Codex-x-TwitchCon-Hackathon/actions/workflows/ci.yml/badge.svg)](https://github.com/ZakariaShahruri/Codex-x-TwitchCon-Hackathon/actions/workflows/ci.yml)

**Twitchy catches leaks before your viewers ever see them.**

Streamers leak API keys, passwords, home addresses and login QR codes on stream all the time. Once a frame airs, it's in the VOD, the clips and someone's screenshot, and you can't take it back.

Twitchy sits between OBS and Twitch. Your stream already runs on a short delay; Twitchy reads the *undelayed* picture, finds secrets, and puts a mask over them inside that delay, so the frame that reaches Twitch is already covered. A pixel mascot, Twitchy, pops up on the overlay and in chat every time it makes a save.

Built for the [Codex x TwitchCon Hackathon](https://twitchcon-codex.devpost.com/) with OpenAI Codex.

## How it works

```
OBS ──┬── 1 s render delay ──────────────────────────────► Twitch
      │                                      ▲
      └── undelayed frame every 150 ms       │ mask placed in OBS
             │                               │ before the frame airs
             ▼                               │
          Apple Vision OCR + QR (on device) ─► detectors
```

1. OBS shows your content through a 1 second delay before it goes out.
2. Every 150 ms Twitchy screenshots the undelayed content over obs-websocket and reads it with Apple Vision, on your Mac.
3. Detectors look for secrets: API keys and tokens, passwords, emails, phone numbers, card numbers (issuer prefix + Luhn), public IP addresses, crypto seed phrases (BIP39 checksum), QR codes, your private watchlist and your own plain-English rules.
4. A black mask is moved over exactly that spot in OBS. It's up long before the delayed frame airs.

No frame leaves your machine and there's no AI on the live path, so it costs nothing to run. The only AI call is compiling a plain-English rule, once, when you make it.

## Does it work? The Leak Gauntlet

`npm run gauntlet -- --seed=3` flashes 37 fake secrets, 14 lookalikes and 3 quick flashes on a real OBS stream and checks whether each mask was up before the frame aired.

| | Result (seed 3, Apple silicon MacBook Air, 1 s delay) |
|---|---|
| Secrets blocked before air | **37 / 37** |
| False alarms on lookalikes | **0 / 14** (`react@18.3.1`, `password: string`, an order number that fails Luhn, `192.168.…`, `8.8.8.8`, 12 wordlist words that fail BIP39, a name one letter off the watchlist…) |
| Quick flashes (250–600 ms) | **3 / 3** |
| Screen to mask | p50 **244 ms**, p95 **311 ms** of the 1000 ms delay |

## Features

- **Shield:** 11 detectors (keys and tokens, passwords, emails, phones, cards, IPs, seed phrases, QR codes, fixed screen regions, the watchlist and your rules), masked before air. A mod can black out the whole stream with `!panic`.
- **Private watchlist:** your real name, address, family names. Fuzzy-matched against OCR mistakes, stored only on your Mac, and not even a mod can unmask it.
- **Plain-English rules:** "hide my student ID, it's the letter r followed by 7 digits". AI turns it into a pattern once, Twitchy tests it against its own examples and ordinary stream text, and it then runs locally on every frame.
- **Twitch:** arms itself when you go live (EventSub `stream.online`), announces saves in chat, chat commands for mods (`!panic`, `!unblur`, `!shield on/off`) and viewers (`!twitchy`).
- **Overlay:** Twitchy and a "leaks blocked this stream" counter on stream.
- **Dashboard:** one-click OBS setup, arm/disarm, watchlist and rules, live latency, leak log and an end-of-stream report.

## Run it

**You need:** macOS (Apple Vision does the OCR) with the Xcode Command Line Tools (`xcode-select --install`, for `swiftc`), Node.js 22+, and OBS 28+ with the WebSocket server on (OBS → Tools → WebSocket Server Settings). Twitch credentials and an OpenAI key are optional.

```sh
npm install
cp .env.example .env      # set OBS_WS_URL and OBS_WS_PASSWORD at least
npm run dev
```

1. Open the dashboard at http://127.0.0.1:4173/dashboard/ and press **Set up OBS**. It creates the Twitchy scenes, the delay and the masks, using the scene that's live as your content (or name one).
2. Add http://127.0.0.1:4173/overlay/ as a Browser Source in OBS for Twitchy and the counter.
3. Stream the `Twitchy Broadcast` scene. Open a `.env` full of fake keys and watch them get masked.

No Twitch account handy? `npm run dev:commands` lets you type `on`, `off`, `panic` and `unblur` in the terminal, and `npm run demo:events` previews the overlay with fake events and no OBS at all.

**Prove it on your machine:** stop `npm run dev` (both use port 4173), then run `npm run gauntlet -- --seed=3`. It uses a throwaway watchlist and restores OBS exactly as it was afterwards.

**Add private details:** `npm run watchlist -- add` asks for a label and then the value with hidden input. Values live in `twitchy.private.json` (gitignored, readable only by you).

### Twitch setup

Register an app at [dev.twitch.tv](https://dev.twitch.tv/console), then sign in as the bot account with the [Twitch CLI](https://dev.twitch.tv/docs/cli/) and request a chat token:

```sh
twitch token --user-token --scopes "user:read:chat user:write:chat user:bot"
```

Put the access token in `TWITCH_BOT_TOKEN`, its refresh token in `TWITCH_BOT_REFRESH_TOKEN`, and fill in `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_BOT_USER_ID` and `TWITCH_BROADCASTER_ID` in `.env`. If the bot isn't the broadcaster, make it a moderator. Twitchy renews the token in memory and never logs credentials.

### Plain-English rules

Add `OPENAI_API_KEY` to `.env`, restart, and use the rules section of the dashboard. The rule text goes to OpenAI once; nothing about your stream ever does.

Every command, chat command and config option is in [docs/commands.md](docs/commands.md).

## Built with Codex

Two of us built Twitchy in parallel, each with our own Codex thread:

| Track | Who | What it covers |
|---|---|---|
| A: Shield engine | Zakaria | OBS capture loop, Apple Vision OCR helper, detectors, mask manager, watchlist, rules compiler, Leak Gauntlet |
| B: Twitch + Twitchy | Salina | Twitch bot and EventSub, chat commands, overlay and Twitchy, dashboard, end-of-stream report |

- The tracks only talk through a typed event contract ([docs/architecture.md](docs/architecture.md)), agreed and committed first, so the two Codex threads could build at the same time without stepping on each other.
- [AGENTS.md](AGENTS.md) gave Codex its rules: stay inside your track's folders, test your work, update the docs, commit small with Conventional Commits.
- Features started as intent-based prompts (goal, context, constraints, definition of done), sent in a few steps for the big ones. Codex wrote the code and the tests, ran them, updated the docs and committed. The Leak Gauntlet was built that way, and it became the regression test we ran before demo takes.
- CI runs the typecheck and tests on every push, including an OCR accuracy test on a macOS runner.

Session IDs are in [docs/codex-sessions.md](docs/codex-sessions.md). The main build thread is `01a1871a-72d6-7331-9ab2-74224d067d9e`.

## Limits

- macOS only for now: the OCR uses Apple Vision. A Windows OCR backend is the next step.
- It reads text and QR codes. It can't hide a face or a picture.
- Text has to fit on one line on screen to be matched (an address wrapped over two lines isn't caught).

## Docs

| Doc | What's in it |
|---|---|
| [docs/concept.md](docs/concept.md) | The idea and the scope |
| [docs/architecture.md](docs/architecture.md) | Tracks, event contract, detectors, timing budget |
| [docs/commands.md](docs/commands.md) | Every command and setting |
| [video/](video/) | How the demo video was recorded and edited |

## Team

Zakaria Shahruri and Salina Giri.
