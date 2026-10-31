# Concept: Twitchy — Stream Shield

**Codex x TwitchCon Hackathon** · Deadline: Nov 2, 2026, 2:00pm PST (Tue Nov 3, 06:00 Shanghai)

**Pitch:** Twitchy catches leaks before your viewers ever see them.

---

## The problem

Streamers regularly leak API keys, passwords, emails, addresses and private DMs on stream. Once it airs, it's in the VOD, in clips, and in screenshots. Damage is instant and permanent.

## The solution

A privacy firewall between the streamer's screen and the broadcast. It detects sensitive information on screen and blurs it **before the frame goes out**, fronted by **Twitchy**, a cute 8-bit mascot that jumps onto the stream whenever it saves you.

### Core loop
1. Streamer accidentally shows a secret (opens `.env`, pastes a key, opens DMs)
2. Twitchy detects it within the delay window
3. A blur lands on exactly that region before the frame airs
4. Twitchy pops up on the overlay, "pulls" the blur over the spot, and the **leaks blocked** counter ticks up
5. Viewers see the save, never the secret

---

## How it works

```
OBS capture ──┬──► [~1s render delay] ──► broadcast
              │
              └──► undelayed screenshot every ~200ms (obs-websocket)
                     ├─ frame unchanged? → skip
                     ▼
                   local OCR (on-device, free)
                     ▼
                   detectors (regex + entropy)
                     ▼
                   blur box moved over the region in OBS
                   before the delayed frame airs
```

- **Runs locally, ~$0 running cost.** No LLM watching every frame.
- **The delay buffer is the core guarantee:** detection happens before the frame is broadcast.
- **Optional LLM** only for rare ambiguous text (e.g. is this a private DM?). Not required for the demo.

### Detectors (scope: nail these, nothing more)
- API keys and tokens (`sk-…`, `ghp_…`, `AKIA…`, JWTs, high-entropy strings)
- Email addresses
- Password fields / password-like strings
- Manually marked sensitive windows (e.g. Discord DMs)

### Twitch integration
| Feature | Tech |
|---|---|
| Auto-arm when going live | EventSub `stream.online` |
| Mod panic button: blur entire screen | Chat command `!panic` (mods only) |
| Mod controls | `!shield on/off`, `!unblur` |
| Twitchy announces saves in chat | Chat bot ("Twitchy blocked a leak 🛡") |
| Twitchy + counter on stream | Overlay browser source |

### Twitchy
- 8-bit, cute, minimal; lives in a corner of the overlay
- Idle animation while guarding; jumps into action on detection
- Counter: "🛡 3 leaks blocked this stream"
- Makes an invisible feature visible and fun to watch

---

## Building blocks
| Part | Tech |
|---|---|
| Frame capture | obs-websocket (`GetSourceScreenshot` on undelayed source) |
| Delay | OBS Render Delay filter on broadcast scene |
| OCR | On-device (Apple Vision on macOS; Tesseract fallback) |
| Detection | Regex + entropy rules |
| Masking | OBS blur/pixelate source positioned via obs-websocket |
| Chat + events | Twitch EventSub + chat bot |
| Overlay | Browser source (Twitchy, counter, animations) |

## Scope guardrails
- Reliability beats breadth: 4 detectors that never miss in the demo
- No viewer reporting (they'd already have seen it)
- No Chrome extension, no clipping, no narrator
- Demo works on one machine, one OBS setup

## Go/no-go test (today)
OBS delayed scene + undelayed screenshots → OCR → an email typed in a text editor is blurred **before** it appears in the delayed output. If this works, the project is viable.

## Demo video (3 min)
1. **Hook:** recreated leak moments (streamer shows a key/email on stream)
2. "Introducing… **Twitchy**": mascot reveal
3. Live: open `.env` on stream → blur lands → Twitchy celebrates → counter ticks
4. Mod `!panic` from chat
5. How it works + how we built it with Codex
6. Outro

> Recreate leaks ourselves; don't use other streamers' real footage.

---

## Rejected ideas
- **Instant Replay (+ AI narrator):** fun, but clipping already exists as a category
- **Chat Ships It:** strong, but chose the clearer problem-first story
- **Living Crowd, Chat Called It, PuppetMaster:** niche, risky or no core loop
- **Combining everything:** unfinishable in the time left