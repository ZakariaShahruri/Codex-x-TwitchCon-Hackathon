# Concept: Twitchy — Stream Shield

**Codex x TwitchCon Hackathon** · Deadline: Nov 2, 2026, 2:00pm PST (Tue Nov 3, 06:00 Shanghai)

**Pitch:** Twitchy catches leaks before your viewers ever see them.

## Goal: win

**Winning (top 5, aiming for 1st) is the number one priority.** We're working overtime and the scope is ambitious on purpose (see *Scope tiers*). Every decision is judged by one question: does it raise our score on Innovation, Impact, Technical implementation (incl. Codex) or Design, *in the 3-minute video*?

| Track | Owner |
|---|---|
| A: Shield engine | Zakaria |
| B: Twitch + Twitchy | Salina |

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

### Tier 1 detectors (nail these first)
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

## Scope tiers

Ambitious, but gated: **never start a tier until the one before it works flawlessly in the demo.** A leak that airs on camera loses the hackathon; a missing Tier 3 feature doesn't.

### Tier 1: core (must be flawless)
Everything above: the 4 detectors, delay + masks, Twitch commands, auto-arm, chat announcements, Twitchy overlay with counter.

### Tier 2: what makes it win (planned, overtime)
| Feature | Why it scores | Track |
|---|---|---|
| **More detectors:** phone numbers, credit cards (Luhn-checked), IP addresses, crypto seed phrases, QR codes (2FA / login QR) | Impact: covers the leaks that actually ruin streamers | A |
| **Personal watchlist:** streamer lists their real name, home address, phone, family names; always masked, fuzzy-matched. Stored locally only | Impact: anti-doxxing, the strongest real-world story | A |
| **Plain-English rules (AI):** "never show my Discord DMs or anything with my mom's name" → compiled once by an LLM into deterministic detector rules, tested against fixtures. Nothing AI runs on the hot path | Innovation + AI story, keeps the speed guarantee | A |
| **Leak Gauntlet:** a test page that flashes 20+ kinds of secrets in sequence; measures block rate and latency ("20/20 blocked, avg 180 ms") | Technical implementation: proof, not promises | A |
| **Streamer dashboard** (local web app): one-click OBS setup wizard, arm/disarm, watchlist + rules editor, live latency meter, leak log | Design: "easy to use" | B |
| **Twitchy reacts per leak type** (key → shield bash, address → hides the house, QR → eats it) + richer idle/panic animations | Design: fun to watch | B |
| **Chat plays along:** `!twitchy` shows stats, chat can cheer Twitchy after a save and Twitchy reacts | Audience participation, a Devpost direction | B |
| **End-of-stream report:** private summary for the streamer (redacted leak list, timestamps, near misses) + a public "Twitchy blocked N leaks" chat message | Impact: habits, not just saves | B |

### Tier 3: only if Tier 2 is solid
- AI classification of windows that look private (DMs, inboxes, banking) when they first appear
- Windows OCR helper (most streamers are on Windows)
- Real blur/pixelate look for masks

### Never
Viewer reporting (they'd already have seen it), Chrome extension, clipping, narrator, multi-machine setups.

## Milestones (Shanghai time)
| When | Done means |
|---|---|
| **Sat Oct 31, night** | Skeleton + event contract committed; go/no-go checks pass (delay limit, OCR latency, end-to-end mask); Track B bot + overlay working on fake events |
| **Sun Nov 1, evening** | Tier 1 integrated and flawless on a live test stream; Leak Gauntlet running |
| **Mon Nov 2, 18:00** | Tier 2 done. Feature freeze |
| **Mon Nov 2, night** | Demo recorded and edited, README + Devpost text written |
| **Tue Nov 3, 02:00** | Submitted (4 h buffer before the 06:00 deadline) |

## Demo video (3 min)
1. **Hook (0:00–0:15):** a streamer opens `.env` live. Freeze frame: "this is how keys get stolen". Then the same moment with Twitchy: masked before it airs
2. "Introducing… **Twitchy**": mascot reveal
3. **Live montage:** API key, email, home address from the watchlist, 2FA QR code, each masked with its own Twitchy reaction; counter ticks; chat cheers
4. **Plain-English rule:** type "hide anything with my mom's name" → it works seconds later
5. **Leak Gauntlet:** 20/20 blocked, latency numbers on screen
6. Mod `!panic` from chat; dashboard setup in one click
7. How it works + how we built it with Codex (Codex threads on screen)
8. Outro: "Twitchy catches leaks before your viewers ever see them."

---

## Rejected ideas
- **Instant Replay (+ AI narrator):** fun, but clipping already exists as a category
- **Chat Ships It:** strong, but chose the clearer problem-first story
- **Living Crowd, Chat Called It, PuppetMaster:** niche, risky or no core loop
- **Combining everything:** unfinishable in the time left