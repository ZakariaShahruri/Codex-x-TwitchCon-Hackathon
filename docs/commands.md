# Commands

Every command in one place. Run them from the repo root.

## First-time setup

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `cp .env.example .env` | Create your local secrets file, then fill in OBS and Twitch values |
| `npm run ocr:build` | Build the Apple Vision OCR helper (macOS). `npm test`, `npm run gauntlet` and `npm run bench:ocr` build it for you |
| `npm run obs:setup` | Create the Twitchy scenes, delay filters and masks in OBS. Add `-- --content-scene "My Scene"` to use an existing scene as the content. The dashboard's "Set up OBS" button runs the same setup |

OBS needs obs-websocket enabled (Tools → WebSocket Server Settings). Its URL and password go in `.env` as `OBS_WS_URL` and `OBS_WS_PASSWORD`.

## Running Twitchy

| Command | What it does |
|---|---|
| `npm run dev` | Start everything: shield, Twitch bot, overlay. The shield arms on start (`armOnStart`) and when you go live |
| `npm run dev:commands` | Same, plus terminal controls: type `on`, `off`, `panic`, `unblur` or `quit` and press Enter. Handy without Twitch |
| `DEBUG=1 npm run dev` | Also print engine timing every second (frame time, p95, fps) |
| `npm run demo:events` | Preview the overlay with fake events. No OBS or Twitch needed |

The overlay is `http://127.0.0.1:4173/overlay/`, added as a transparent Browser Source in OBS.

## Twitch chat commands

| Command | Who | What it does |
|---|---|---|
| `!panic` | Mods, broadcaster | Black out the whole stream right away |
| `!unblur` | Mods, broadcaster | During panic, lift it. Otherwise, dismiss the masks on screen now as false positives for the rest of the session. **Never** dismisses watchlist entries or sensitive regions |
| `!shield on` / `!shield off` | Mods, broadcaster | Arm or disarm the shield |
| `!twitchy` | Anyone | Twitchy replies with how many leaks it blocked this stream (per-viewer cooldown) |

## Watchlist (your private details)

Things a pattern can't spot: your real name, address, phone, family names. Always masked, fuzzy-matched, stored only on your Mac.

| Command | What it does |
|---|---|
| `npm run watchlist -- add` | Asks for a label, then the value with hidden input. **Don't** type the value on the command line |
| `npm run watchlist -- list` | Show IDs and labels (never values) |
| `npm run watchlist -- remove <id>` | Delete one entry (get the ID from `list`) |

Example:

```text
$ npm run watchlist -- add
Safe label (for example, home address): real name
Private value (input hidden): ••••••••••••••••
Watchlist entry added.
```

- **Label:** what the entry is ("real name", "home address", "mom's name"). It appears in leak events and the overlay as "watchlist: real name", so it must not contain the value: a label that shares a word with the value is rejected.
- **Value:** the actual text. One entry per thing: add your full name, and add your first or last name on their own if those alone would also give you away.
- Entries are saved in `twitchy.private.json`: gitignored, readable only by you. A running `npm run dev` doesn't reload the file, so restart it after adding entries.
- Matching ignores case, punctuation and OCR mix-ups (O/0, l/I/1) and allows a few wrong letters on longer entries. Entries of 4 characters or fewer must match exact whole words.
- Limit: the value must sit on one line on screen. An address wrapped onto two lines isn't caught.

## Leak Gauntlet (proof it works)

Shows 33 fake secrets, 11 decoys and 3 quick flashes on your OBS stream and scores how many were masked before they aired.

| Command | What it does |
|---|---|
| `npm run gauntlet` | Run with seed 1. Stop `npm run dev` first (both use port 4173) |
| `npm run gauntlet -- --seed=3` | **Demo run:** 37/37 blocked, 0 false alarms |
| `npm run gauntlet -- --with-twitch` | Also post the saves in Twitch chat |

It uses its own temporary watchlist (your real one is never touched), covers your desktop with a black backdrop while it runs, and restores OBS exactly as it was afterwards. "Blocked" means the mask was up before the frame aired and stayed until the secret was gone.

## Checks and benchmarks

| Command | What it does |
|---|---|
| `npm test` | All tests (on macOS also the OCR accuracy matrix) |
| `npm run typecheck` | TypeScript check. CI runs this plus `npm test` on every push |
| `npm run bench:ocr` | OCR speed benchmark |
| `npm run fixture:ocr` / `npm run fixture:ocr:matrix` | Regenerate OCR test images |

## Config (`twitchy.config.json`)

| Key | Default | Meaning |
|---|---|---|
| `delayMs` | `1000` | Stream delay. Masks must be up before this runs out. Max 2000 |
| `captureIntervalMs` | `150` | How often the undelayed picture is screenshotted |
| `enabledDetectors` | all built | Remove a kind (e.g. `"phone"`) to stop masking it |
| `sensitiveRegions` | `[]` | Screen areas always masked, as `{ "x", "y", "w", "h" }` boxes in 1920×1080 canvas pixels (e.g. where your DMs pop up) |
| `armOnStart` | `true` | Arm the shield as soon as Twitchy starts |
| `webPort` | `4173` | Port for the overlay |

## If something goes wrong

| Problem | Fix |
|---|---|
| Something private is on screen right now | `!panic` in chat (or `panic` in `npm run dev:commands`) |
| A harmless thing is masked | `!unblur` |
| `EADDRINUSE` on port 4173 | Another `npm run dev` or gauntlet is running. Stop it |
| "OBS_WS_URL is missing" or no capture | Check OBS is open, the WebSocket server is on, and `.env` has the right URL and password |
