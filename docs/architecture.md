# Architecture

Technical source of truth for Twitchy — Stream Shield. Product, scope tiers and milestones live in `concept.md`; how we work lives in `AGENTS.md` / `CLAUDE.md`.

---

## 1. The guarantee

**A secret is masked before the frame containing it is broadcast.**

The broadcast is delayed by `delayMs`. The engine looks at the *undelayed* picture, so it has `delayMs` to find a secret and place a mask. Every design choice below protects this. **Nothing slow (AI, network) ever runs on this path.**

```
Worst case for one secret:
  appears just after a capture  →  waits ≤ captureIntervalMs
  + screenshot + OCR + detect + place mask
  must be  <  delayMs − safetyMarginMs
```

| Budget item | Target |
|---|---|
| `captureIntervalMs` | 100–200 ms |
| Screenshot (obs-websocket) | < 50 ms |
| OCR (+ QR detection) | < 200 ms |
| Detectors | < 10 ms |
| Place mask (obs-websocket) | < 20 ms |
| `safetyMarginMs` | 100 ms |

The engine measures every frame end to end. A frame over budget is logged and puts the shield in `degraded`.

---

## 2. OBS layout

```
Scene "Twitchy Broadcast"   ← what goes to Twitch (top of list = drawn on top)
 ├─ Twitchy Overlay   browser source, Render Delay = delayMs   (Track B)
 ├─ Mask 1..N         opaque color sources, NOT delayed          (Track A)
 └─ Twitchy Raw       scene source, Render Delay = delayMs
      └─ Twitchy Content   scene source, NO filters  ← the engine screenshots this
            └─ the streamer's actual content (display/window capture, camera…)
```

- The engine screenshots **`Twitchy Content`** at canvas resolution, so OCR coordinates are canvas coordinates. No mapping needed. It must not be `Twitchy Raw`: `GetSourceScreenshot` renders a source *with its filters* (`obs_source_video_render`), so a screenshot of `Twitchy Raw` would already be delayed. The delay filters live on the wrapper scene only.
- **Masks are not delayed:** they appear immediately, covering the region slightly *before* the secret airs.
- **The overlay is delayed like the content**, so Twitchy's animation lands exactly when viewers would have seen the secret.
- **Render Delay is capped at 500 ms per filter** (OBS source, `plugins/obs-filters/gpu-delay.c`). `delayMs` is reached by stacking `ceil(delayMs / 500)` filters (1000 ms = 2 filters) on both `Twitchy Raw` and `Twitchy Overlay`. Each filter buffers frames in GPU memory (about 0.5 GB per second of delay at 1080p60, per source), so the config caps `delayMs` at 2000.
- **Audio:** Render Delay delays video only. Set the same delay as Sync Offset on audio sources, or mouths and screens drift.
- `npm run obs:setup` (and the dashboard's setup wizard, which calls the same code) creates this layout via obs-websocket: scenes, mask pool, filters. Pass `-- --content-scene "Scene Name"` to select the content scene on first setup; otherwise it nests the current program scene. Existing content choices are preserved on later runs. The command leaves the active program scene unchanged, reports each source it found or created, and leaves masks disabled. Afterward, switch the stream output to `Twitchy Broadcast` manually and set the audio sync offset.

### Masks
- **Style:** opaque pixel-art censor block. Opaque is safer than blur (blurred text can sometimes be recovered) and needs no OBS plugins. A blur look is Tier 3.
- **Pool:** `maskPoolSize` color sources created at setup, enabled and moved with `SetSceneItemTransform` / `SetSceneItemEnabled`. No creating sources at runtime.
- **Lifetime rule (critical):** each detected box lives until `lastSeen + delayMs + safetyMarginMs`. The delayed output still shows the secret after it disappears from the live picture, so the mask must outlast it. Active masks = all unexpired boxes; when text moves, the old position remains covered as the candidate box expands to include the new position.
- **Pool exhaustion:** pad boxes, merge overlaps, then merge nearest boxes into larger covering boxes until the plan fits the pool. Never discard a live box. A one-way SHA-256 fingerprint stays in process memory to suppress the same text after `unblur`; plaintext matches are not retained in events, files or logs.
- **Stop/restart:** graceful stop holds enabled masks for at least `delayMs + safetyMarginMs` before clearing them. On startup, enabled pool sources are adopted and held for that same interval. A full-canvas panic mask remains enabled across stop and restart until `unblur`.
- **Unchanged frames:** if the PNG's SHA-256 fingerprint is identical to the previous capture, skip OCR and return the prior boxes so the engine can refresh `lastSeen`.

---

## 3. Components

```
                          ┌──────────── src/shared ─────────────┐
                          │  event contract · bus · config      │
                          └──────▲────────────────────────▲─────┘
  Track A: src/shield/ …         │                        │        Track B: src/twitch/, src/web/, web/
 ┌───────────────────────────────┴──┐               ┌─────┴──────────────────────────────────────┐
 │ capture → screenshot Content     │ leak.*        │ eventsub → chat, stream.online/offline     │
 │ diff    → skip unchanged frames  │ shield.state  │ commands → !shield, !panic, !unblur,       │
 │ ocr     → text + boxes + QR      │ engine.metrics│            !twitchy, cheers                │
 │ detect  → leak boxes             │ rules.compiled│ chat     → announcements, stream report    │
 │ masks   → place/expire in OBS    │ ────────────► │ web server → overlay + dashboard over WS   │
 │ rules   → plain English → rules  │ ◄──────────── │ web/overlay   → Twitchy, counter, reactions│
 │ obs:setup · Leak Gauntlet        │ shield.command│ web/dashboard → setup, controls, editors,  │
 └──────────────────────────────────┘ config.updated│                 latency meter, leak log    │
                                      rules.compile └────────────────────────────────────────────┘
```

One Node process (`npm run dev`) boots both tracks and wires them through an in-process typed event bus. The overlay and dashboard are browser pages connected over WebSocket.

Each track's `index.ts` exports `start: StartTrack` (`src/shared/track.ts`): it starts, subscribes to the bus and returns a `stop()` that closes everything it opened (sockets, child processes, timers). `src/index.ts` calls the stops in reverse order on Ctrl+C / SIGTERM, and on a failed start. Async bus listeners are fine: a rejected promise is logged, never crashes the process.

### Folders and ownership

| Track | Owner | Owns | Folders |
|---|---|---|---|
| **A: Shield engine** | Zakaria | Capture, diff, OCR helper, detectors, watchlist, masks, rules compiler, OBS setup, Leak Gauntlet | `src/shield/`, `tools/ocr-vision/`, `tools/gauntlet/`, `scripts/` |
| **B: Twitch + Twitchy** | Salina | EventSub, chat bot, commands, stream report, web server, overlay, dashboard, mascot art | `src/twitch/`, `src/web/`, `web/` |
| **Shared** | both, agreed first | Event contract, bus, config loader, `src/index.ts` wiring | `src/shared/`, `src/index.ts` |

---

## 4. Event contract

Defined in `src/shared/events.ts`. The tracks talk **only** through these events. Change this table and that file in the same commit.

| Event | Direction | Payload |
|---|---|---|
| `leak.detected` | A → B | `{ id, kind, box: {x,y,w,h}, preview, totalBlocked, at }` |
| `leak.cleared` | A → B | `{ id, at }` (mask expired) |
| `shield.state` | A → B | `{ status: 'off' \| 'armed' \| 'degraded' \| 'panic', reason?, at }` |
| `engine.metrics` | A → B | `{ lastFrameMs, p95FrameMs, budgetMs, framesPerSec, at }` (every second) |
| `rules.compiled` | A → B | `{ requestId, ok, rules?: RuleSummary[], error? }` |
| `shield.command` | B → A | `{ action: 'on' \| 'off' \| 'panic' \| 'unblur', by, at }` |
| `private.state` | A → B | `{ watchlist: {id,label}[], rules: RuleSummary[], at }` (saved watchlist and rules **without values**; at startup and after every change) |
| `config.updated` | B → A | `{ watchlist?: { add?: {label,value}[], removeIds? }, enabledDetectors?, sensitiveRegions?, removedRuleIds? }` (from the dashboard) |
| `rules.compile` | B → A | `{ requestId, text }` (plain-English rule from the dashboard) |

- `kind`: `'api_key' | 'email' | 'password' | 'phone' | 'card' | 'ip' | 'seed_phrase' | 'qr_code' | 'watchlist' | 'custom_rule' | 'sensitive_region'`
- `box`: canvas pixels
- `preview`: redacted label only, e.g. `"sk-…9aF"`, `"j…@gmail.com"`, `"watchlist: home address"`. **Secrets and watchlist values never leave the machine and never appear in events to the overlay, chat, logs or files** (watchlist lives only in `twitchy.private.json`).
- `at`: epoch ms, for latency logs.

- `RuleSummary`: `{ id, description, detector }`. Never contains rule source text, secrets or watchlist values.
- `preview` is typed `RedactedPreview`; build it with `redacted(label)` from `events.ts`, only from text that contains no detected content.
- **Watchlist values** travel only dashboard → web bridge → `config.updated` → Track A, in-process, and are never logged. **Track A is the only writer of `twitchy.private.json`** (watchlist and compiled rules) and reports what's saved through `private.state`, labels only.
- **Browser boundary:** the web bridge forwards only the events in `browserEvents` (`events.ts`, all A → B). B → A events never reach a browser.

### Command semantics
- `on` / `off`: arm or disarm detection. Masks already placed still expire normally.
- `panic`: full-canvas mask immediately; stays until `unblur`.
- `unblur`: removes all masks (false positive or panic over) and ignores re-detection of the same text for this session.
- Only the broadcaster and moderators can issue commands (checked by badge on the chat message).

---

## 5. Track A: shield engine (Zakaria)

- **Capture:** `GetSourceScreenshot` on `Twitchy Content` (never `Twitchy Raw`, see §2), PNG, canvas resolution, every `captureIntervalMs`. Never overlap captures; if one is still processing, skip the tick.
- **Diff:** hash the compressed PNG bytes with SHA-256; identical → skip OCR and return prior boxes to refresh their `lastSeen`.
- **OCR:** behind one interface, `recognize(png) → { text, box, words: { text, box }[] }[]` plus `barcodes(png) → { payload, box }[]`. The Node client shares one helper response when both are requested for the same PNG buffer, restarts the helper after a crash, and applies a per-frame timeout.
  - Primary: **Apple Vision** (text recognition + barcode detection in one pass) via a small Swift helper in `tools/ocr-vision/`, built with `npm run ocr:build`, kept running and fed 4-byte big-endian length-prefixed PNG frames over stdin (no process spawn per frame). It emits one JSON line per frame with text lines, whitespace-delimited word boxes, and barcode payload boxes. Boxes are clamped, outward-rounded canvas pixels with a top-left origin. Inputs larger than 1280 pixels on their longest side are thumbnailed for recognition; normalized Vision boxes are mapped back onto the original canvas dimensions. `--level fast|accurate` selects Vision's recognition level (the helper defaults to `fast`; the Node client defaults to `accurate` based on §9); language correction is disabled to preserve technical strings. `tools/ocr-vision/fixtures/screen.png` is the OCR smoke fixture, and `fake-env-1080p.png` is the reproducible benchmark/detector fixture. `npm test` builds and exercises the helper on macOS (CI runs it on a `macos-latest` job); non-macOS test runs skip its platform-specific integration tests.
  - Fallback: deferred for now; no Tesseract dependency or non-macOS OCR backend is wired. The fixture integration test runs on macOS and skips elsewhere. Windows OCR remains Tier 3.
- **Detectors:** pure functions `(ocrResult) → Leak[]`, one file each, unit-tested with fixture strings.
  - Tier 1: `api_key` (known prefixes `sk-`, `ghp_`, `github_pat_`, `AKIA`, `xox[bp]-`, JWT `eyJ…`, plus long high-entropy tokens) · `email` · `password` (values next to password/secret labels, `KEY=value` lines) · `sensitive_region` (always-masked areas from config)
  - Tier 2: `phone` · `card` (13–19 digits, Luhn-checked) · `ip` (public IPv4/IPv6) · `seed_phrase` (≥ 12 consecutive BIP39 words) · `qr_code` (any QR; masks the whole code) · `watchlist` (normalized, fuzzy to tolerate OCR errors) · `custom_rule` (compiled rules)
- **Rules compiler** (`src/shield/rules/`): plain-English rule → an OpenAI model with structured output → typed rules (keywords, regex, watchlist entries, window titles) + positive/negative examples → validated (regexes compile, examples pass) → saved to `twitchy.private.json` → `rules.compiled`. Runs once per rule, **never per frame**. The model is `rulesModel` in config; the default `gpt-4o-mini` is a placeholder: before building the compiler, list the models the key can use (`GET /v1/models`) and pick the newest small model that supports structured outputs.
- **Masks:** lifetime rule from §2; merge overlapping boxes; pad a few pixels.
- **Leak Gauntlet** (`tools/gauntlet/`): local page shown in `Twitchy Content` that flashes 20+ secrets of every kind, each with a known appear time; the engine logs detection time; prints block rate and p50/p95 latency. Also our regression test before every demo take.
- **Degraded:** OBS disconnect, OCR failure or over-budget frames → `shield.state degraded` with a reason. Detection keeps trying; `!panic` still works.

## 6. Track B: Twitch + Twitchy (Salina)

- **EventSub WebSocket** (`wss://eventsub.wss.twitch.tv/ws`) subscriptions:
  - `channel.chat.message` v1: condition `broadcaster_user_id` + `user_id` (bot)
  - `stream.online` v1 → `shield.command on` (auto-arm)
  - `stream.offline` v1 → end-of-stream report
- Handle `session_keepalive`, `session_reconnect` and revocations. The example chatbot guide doesn't, and a dropped socket mid-demo kills the commands.
- **Chat:** `POST https://api.twitch.tv/helix/chat/messages`. Batch leak announcements (at most one message every few seconds). Commands: mod-only `!shield on/off`, `!panic`, `!unblur`; everyone: `!twitchy` (stats) and cheering after a save (Twitchy reacts on the overlay).
- **Auth:** user access token for the bot account with `user:read:chat`, `user:write:chat`, `user:bot`. Configure the Twitch CLI, then run `twitch token --user-token --scopes "user:read:chat user:write:chat user:bot"`; put the result in `TWITCH_BOT_TOKEN` in `.env`. If the bot isn't the broadcaster, the broadcaster grants `channel:bot` or mods the bot. See README for setup details.
- **Web server** (`src/web/`): `npm run dev` serves `web/overlay/` at `http://127.0.0.1:<webPort>/overlay/` and `web/dashboard/` at `http://127.0.0.1:<webPort>/dashboard/` when that page exists. The WebSocket bridge listens on localhost and forwards only `browserEvents`; the overlay receives leak events and shield state, while the dashboard receives all browser events. On connect/reconnect it sends one `{ snapshot: { shieldState, leakCount, privateState } }` message (`privateState` for the dashboard only) instead of replaying events, so a reloaded page shows the current state without re-animating old leaks. `npm run demo:events` starts only this track and runs a scripted event loop for previewing the overlay without Track A.
- **Overlay** (`web/overlay/`): plain HTML/CSS/JS, sprite sheets in `web/overlay/assets/`. Canvas = OBS canvas size, so `box` coordinates are used as-is.
  - Twitchy sleeps when `off`, guards with a gentle idle animation when `armed`, looks worried when `degraded`, and raises an alarm when `panic`.
  - On each live `leak.detected`, Twitchy hops from its corner to the clamped box position, sweeps a transparent pixel frame over the already-masked area, then returns home; saves queue in order and the counter pops once per new count. A snapshot updates state and count without replaying an animation.
- **Dashboard** (`web/dashboard/`): setup wizard (OBS connect + `obs:setup` + Twitch check), arm/disarm/panic, watchlist editor, plain-English rules editor (`rules.compile` → shows compiled result), live latency meter (`engine.metrics`), leak log (redacted).
- **End-of-stream report:** on `stream.offline`, a public chat message ("Twitchy blocked N leaks this stream 🛡") and a private redacted report on the dashboard.
- `npm run demo:events` fires fake events at the overlay and dashboard so Track B never waits on Track A.

---

## 7. Stack and conventions

- **Runtime:** Node 22+, TypeScript strict, run with `tsx`. npm.
- **Libraries:** `obs-websocket-js` (OBS 28+ has obs-websocket v5 built in), `ws` for the web WebSocket server, `openai` for the rules compiler only. EventSub uses Node's built-in WebSocket client. Anything else: justify it in the commit.
- **Tests:** `node:test`. Detectors, watchlist matching and mask lifetime logic must have unit tests; the engine has a fixture test (screenshot of a fake `.env` → expected boxes); the Leak Gauntlet is the end-to-end test.
- **Errors:** handle at the boundaries (obs-websocket, OCR helper, OpenAI, Twitch API, EventSub) with log lines that say what failed and what happens next.
- **CI** (`.github/workflows/ci.yml`): every push to `main` and every PR runs `npm ci`, `npm run typecheck` and `npm test` on Ubuntu, plus a `macos-latest` job that builds the Apple Vision helper and runs the OCR tests. It must stay green.
- **Logging:** per-frame timing line in debug mode: `capture 34ms · ocr 141ms · detect 2ms · mask 6ms · total 183ms`.

## 8. Configuration

- `.env` (never committed; `.env.example` kept current): `TWITCH_CLIENT_ID`, `TWITCH_BOT_TOKEN`, `TWITCH_BOT_USER_ID`, `TWITCH_BROADCASTER_ID`, `OBS_WS_URL`, `OBS_WS_PASSWORD`, `OPENAI_API_KEY`
- `twitchy.config.json` (committed defaults): `delayMs`, `captureIntervalMs`, `safetyMarginMs`, `maskPoolSize`, `enabledDetectors`, `sensitiveRegions`, `armOnStart`, `webPort`, `rulesModel`. Validated at startup with a message naming the bad key; `delayMs` must exceed `captureIntervalMs + safetyMarginMs` and be at most 2000 (§2).
- `twitchy.private.json` (gitignored): watchlist and compiled rules

## 9. Verify first (go/no-go, Saturday night)

1. **Render Delay stacking:** the 500 ms cap per filter is confirmed in OBS source. Confirm in OBS that two stacked filters on `Twitchy Raw` give ~1 s (film a stopwatch next to the preview). If not, set `delayMs` to 500 and fit the whole budget in §1 into it.
2. **OCR latency:** the chosen Apple Vision text + barcode pass on a 1080p `.env` editor frame must stay under 200 ms p95 and reliably read the fake credentials.
3. **End to end:** type an email into a text editor in `Twitchy Content` → the mask is on screen in `Twitchy Broadcast` before the delayed frame shows the email. Record it; this clip is the core of the demo.

### Benchmark with live OBS (2026-11-01)

`npm run bench:ocr` on macOS 15.6.1, arm64, OBS 33.0.1, 1920×1080 canvas; 30 samples after 3 warmups. Fixture: `tools/ocr-vision/fixtures/fake-env-1080p.png` (synthetic values only, regenerate with `npm run fixture:ocr`).

| Operation | p50 | p95 | Target |
|---|---:|---:|---|
| OBS screenshot (`Twitchy Content`, PNG) | 41.7 ms | 43.5 ms | < 50 ms ✅ |
| Apple Vision OCR `fast` | 18.8 ms | 20.0 ms | reads 3/4 keys ❌ |
| Apple Vision OCR `accurate` | 95.0 ms | 98.4 ms | < 200 ms ✅, reads 4/4 keys |

- **Go/no-go #2 passes.** The Node client uses `accurate`. Worst-case frame subtotal: capture interval 150 + screenshot 43.5 + OCR 98.4 + detect/mask targets 30 ≈ **322 ms of the 900 ms available** (`delayMs` 1000 − `safetyMarginMs` 100).
- These OCR measurements predate the helper's 1280-pixel thumbnail path for larger input frames; rerun `npm run bench:ocr` to refresh latency and read-rate figures for the current path.
- `fast` missed `FAKE_AWS_SECRET_0123456789abcdef` in every sample, so it is not safe for detection.
- **Vision inserts spaces after colons**: `oauth:fake-twitch-token…` reads as `oauth: fake-twitch-token…` and `postgres://demo:FakePassword123@…` as `postgres://demo: FakePassword123@…`. Word boxes split on whitespace, so a secret can span several words. Detectors must match on the line text with this kind of whitespace tolerated, then mask the union of the words the match covers.
- Still open: #1 (stopwatch check of the stacked delay) and #3 (end to end, after the engine is built). These numbers are an idle OBS; the engine's per-frame timing log measures the real path under load.

## 10. Out of scope

Tier 3 items wait until Tier 2 is solid (see `concept.md`). Never: viewer reporting, Chrome extension, clipping, multi-machine setups.
