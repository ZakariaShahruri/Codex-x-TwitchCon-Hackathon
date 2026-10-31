# Architecture

Technical source of truth for Twitchy — Stream Shield. Product and scope live in `concept.md`; how we work lives in `AGENTS.md` / `CLAUDE.md`.

---

## 1. The guarantee

**A secret is masked before the frame containing it is broadcast.**

The broadcast is delayed by `delayMs`. The engine looks at the *undelayed* picture, so it has `delayMs` to find a secret and place a mask. Every design choice below protects this.

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
| OCR | < 200 ms |
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
                        └─ the streamer's actual content (display/window capture, camera…)
```

- The engine screenshots **`Twitchy Raw` itself** (undelayed) at canvas resolution, so OCR coordinates are canvas coordinates. No mapping needed.
- **Masks are not delayed:** they appear immediately, covering the region slightly *before* the secret airs.
- **The overlay is delayed like the content**, so Twitchy's animation lands exactly when viewers would have seen the secret.
- **Audio:** Render Delay delays video only. Set the same delay as Sync Offset on audio sources, or mouths and screens drift.
- `npm run obs:setup` creates this layout via obs-websocket (scenes, mask pool, filters), so judges don't build it by hand.

### Masks
- **Style:** opaque pixel-art censor block. Opaque is safer than blur (blurred text can sometimes be recovered) and needs no OBS plugins. A blur look is optional polish later.
- **Pool:** `maskPoolSize` color sources created at setup, enabled and moved with `SetSceneItemTransform` / `SetSceneItemEnabled`. No creating sources at runtime.
- **Lifetime rule (critical):** each detected box lives until `lastSeen + delayMs + safetyMarginMs`. The delayed output still shows the secret after it disappears from the live picture, so the mask must outlast it. Active masks = all unexpired boxes; when the text moves, the old box stays until it expires.
- **Unchanged frames:** if a frame is identical to the previous one, skip OCR and refresh `lastSeen` on current boxes.

---

## 3. Components

```
                         ┌──────────── src/shared ─────────────┐
                         │  event contract · bus · config      │
                         └──────▲───────────────────────▲──────┘
  Track A: src/shield/          │                       │          Track B: src/twitch/, src/overlay/, overlay/
 ┌──────────────────────────────┴───┐             ┌─────┴─────────────────────────────────────┐
 │ capture  → screenshot Twitchy Raw│             │ eventsub → chat messages, stream.online   │
 │ diff     → skip unchanged frames │  leak.*     │ commands → !shield on/off, !panic, !unblur│
 │ ocr      → text + boxes          │ ──────────► │ chat     → "Twitchy blocked a leak 🛡"    │
 │ detect   → leak boxes            │ shield.state│ overlay server → pushes events over WS    │
 │ masks    → place/expire in OBS   │ ◄────────── │                                           │
 │ obs:setup script                 │ shield.cmd  │ overlay/ → Twitchy, counter, animations   │
 └──────────────────────────────────┘             └───────────────────────────────────────────┘
```

One Node process (`npm run dev`) boots both tracks and wires them through an in-process typed event bus. The overlay is the only thing outside the process: an OBS browser source connected over WebSocket.

### Folders and ownership

| Track | Owns | Folders |
|---|---|---|
| **A: Shield engine** | Capture, frame diff, OCR, detectors, masks, OBS setup script | `src/shield/`, `tools/ocr-vision/`, `scripts/obs-setup.ts` |
| **B: Twitch + Twitchy** | EventSub, chat bot, mod commands, overlay server, overlay client, mascot art | `src/twitch/`, `src/overlay/`, `overlay/` |
| **Shared** | Event contract, bus, config loader, `src/index.ts` wiring | `src/shared/`, `src/index.ts` |

Owners: the Area column in `codex-sessions.md`.

---

## 4. Event contract

Defined in `src/shared/events.ts`. The tracks talk **only** through these events. Change this table and that file in the same commit.

| Event | Direction | Payload |
|---|---|---|
| `leak.detected` | A → B | `{ id, kind, box: {x,y,w,h}, preview, totalBlocked, at }` |
| `leak.cleared` | A → B | `{ id, at }` (mask expired) |
| `shield.state` | A → B | `{ status: 'off' \| 'armed' \| 'degraded' \| 'panic', reason?, at }` |
| `shield.command` | B → A | `{ action: 'on' \| 'off' \| 'panic' \| 'unblur', by, at }` |

- `kind`: `'api_key' | 'email' | 'password' | 'sensitive_region'`
- `box`: canvas pixels
- `preview`: redacted label only, e.g. `"sk-…9aF"` or `"j…@gmail.com"`. **The full secret never leaves the shield engine:** not in events, chat, overlay, logs or files.
- `at`: epoch ms. The overlay doesn't need it for sync (it's delayed in OBS), but it's useful for latency logs.

### Command semantics
- `on` / `off`: arm or disarm detection. Masks already placed still expire normally.
- `panic`: full-canvas mask immediately; stays until `unblur`.
- `unblur`: removes all masks (false positive or panic over) and ignores re-detection of the same text for this session.
- Only the broadcaster and moderators can issue commands (checked by badge on the chat message).

---

## 5. Track A: shield engine

- **Capture:** `GetSourceScreenshot` on `Twitchy Raw`, PNG, canvas resolution, every `captureIntervalMs`. Never overlap captures; if one is still processing, skip the tick.
- **Diff:** cheap downscaled hash; identical → skip OCR, refresh boxes.
- **OCR:** behind one interface, `recognize(png) → { text, box }[]` (line/word level with boxes).
  - Primary: **Apple Vision** via a small Swift helper in `tools/ocr-vision/`, kept running and fed frames over stdin (no process spawn per frame).
  - Fallback: `tesseract.js` for non-macOS development. Likely too slow for the live budget; fine for tests.
- **Detectors:** pure functions `(ocrResult) → Leak[]`, one file each, unit-tested with fixture strings.
  - `api_key`: known prefixes (`sk-`, `ghp_`, `github_pat_`, `AKIA`, `xox[bp]-`, JWT `eyJ…`) and long high-entropy tokens
  - `email`
  - `password`: values next to `password` / `passwd` / `pwd` / `secret` labels, and `KEY=value` lines from `.env`-style text
  - `sensitive_region`: always-masked areas from config (e.g. the Discord window's scene item bounds)
- **Masks:** applies the lifetime rule from §2; merges overlapping boxes; pads each box a few pixels.
- **Degraded:** OBS disconnect, OCR failure or over-budget frames → `shield.state degraded` with a reason. Detection keeps trying; `!panic` still works.

## 6. Track B: Twitch + Twitchy

- **EventSub WebSocket** (`wss://eventsub.wss.twitch.tv/ws`) subscriptions:
  - `channel.chat.message` v1: condition `broadcaster_user_id` + `user_id` (bot)
  - `stream.online` v1: condition `broadcaster_user_id` → `shield.command on` (auto-arm)
- Handle `session_keepalive`, `session_reconnect` and revocations. The example chatbot guide doesn't, and a dropped socket mid-demo kills the commands.
- **Send chat:** `POST https://api.twitch.tv/helix/chat/messages`. Batch leak announcements (at most one message every few seconds, e.g. "Twitchy blocked 2 leaks 🛡 (5 this stream)").
- **Auth:** user access token for the bot account with `user:read:chat`, `user:write:chat`, `user:bot`. If the bot isn't the broadcaster, the broadcaster grants `channel:bot` or mods the bot. Token goes in `.env`; README explains getting one (Twitch CLI).
- **Overlay server** (`src/overlay/`): serves `overlay/` over HTTP and forwards bus events over a WebSocket. Overlay canvas = OBS canvas size, so `box` coordinates are used as-is.
- **Overlay client** (`overlay/`): plain HTML/CSS/JS, sprite sheet in `overlay/assets/`.
  - States: `off` sleeping · `armed` idle guarding · `leak.detected` jumps to the box and "pulls" the censor bar over it, counter ticks · `degraded` worried · `panic` alarm.
  - `npm run demo:events` fires fake events at the overlay so Track B never waits on Track A.

---

## 7. Stack and conventions

- **Runtime:** Node 22+, TypeScript strict, run with `tsx`. npm.
- **Libraries:** `obs-websocket-js` (OBS 28+ has obs-websocket v5 built in), `ws` for the overlay WebSocket server. EventSub uses Node's built-in WebSocket client. Anything else: justify it in the PR/commit.
- **Tests:** `node:test`. Detectors and mask lifetime logic must have unit tests; the engine has a fixture test (screenshot of a fake `.env` → expected boxes).
- **Errors:** handle at the boundaries (obs-websocket, OCR helper, Twitch API, EventSub) with log lines that say what failed and what happens next.
- **Logging:** per-frame timing line in debug mode: `capture 34ms · ocr 141ms · detect 2ms · mask 6ms · total 183ms`.

## 8. Configuration

- `.env` (never committed; `.env.example` kept current): `TWITCH_CLIENT_ID`, `TWITCH_BOT_TOKEN`, `TWITCH_BOT_USER_ID`, `TWITCH_BROADCASTER_ID`, `OBS_WS_URL`, `OBS_WS_PASSWORD`
- `twitchy.config.json`: `delayMs`, `captureIntervalMs`, `safetyMarginMs`, `maskPoolSize`, `enabledDetectors`, `sensitiveRegions`, `armOnStart`, `overlayPort`

## 9. Verify first (go/no-go)

1. **Render Delay limit:** OBS caps the Render Delay filter (500 ms per filter at time of writing). Confirm whether stacking two filters gives ~1 s. If not, the whole budget in §1 must fit in 500 ms.
2. **OCR latency:** Apple Vision on a 1080p frame of an editor showing `.env`, measured end to end. Must fit the budget.
3. **End to end:** type an email into a text editor in `Twitchy Raw` → the mask is on screen in `Twitchy Broadcast` before the delayed frame shows the email. Record it; this clip is the core of the demo.

## 10. Out of scope (v1)

LLM classification of ambiguous text, viewer reporting, Chrome extension, clipping, multi-machine setups.
