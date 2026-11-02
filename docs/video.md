# Demo video

Everything worth saying or showing in the 3-minute video, so nothing gets forgotten. The storyboard in `concept.md` is the plan; this file is the checklist. Add points as they come up; cross out what doesn't make the cut.

## Hard requirements (Devpost)

- [ ] **3:00 or shorter.**
- [ ] **Shows it working on Twitch:** a real channel, real chat, the overlay on the stream.
- [ ] **Shows how Codex was used** during development.
- [ ] Uploaded to YouTube, **public**.

## Judges score these, so the video must hit each

| Criterion | What shows it |
|---|---|
| Innovation | Masks land *inside the stream delay*, so viewers never see the secret: not "blur it after", but "it never aired" |
| Impact | Real leaks that end careers or empty bank accounts: API keys, passwords, home address, QR login codes |
| Technical + Codex | Leak Gauntlet numbers, on-device OCR, the timing budget, Codex threads on screen |
| Design | Twitchy reacting, the counter, one-command setup, chat controls |

## Storyboard, with what we actually have

1. **Hook (0:00–0:15).** Streamer opens `.env` live. Freeze frame: "this is how keys get stolen." Rewind, same moment with Twitchy: masked before it airs.
2. **Introducing Twitchy.** Mascot reveal on the overlay.
3. **Live montage**, each masked as it appears, counter ticking:
   - API key in an editor (`sk_live_…`, `ghp_…`)
   - password in a `.env` or config
   - email
   - **home address from the watchlist** (anti-doxxing, the strongest story)
   - **QR login code** (the whole code disappears)
   - phone number or credit card
4. ~~Plain-English rule~~: **not built, cut it.**
5. **Leak Gauntlet:** `npm run gauntlet -- --seed=2` → **33/33 blocked, 0 false alarms, every mask up before air.** Put the numbers on screen.
6. **Chat controls:** a mod types `!panic` → whole stream blacked out → `!unblur` lifts it. Viewer types `!twitchy` → Twitchy replies with the count.
7. **How it works + built with Codex** (see below).
8. **Outro:** "Twitchy catches leaks before your viewers ever see them."

## Lines worth saying

- "Once a secret airs, it's in the VOD, the clips and the screenshots. You can't take it back." (the problem)
- "Twitchy reads your screen *before* your viewers do." (the idea in one line)
- "One second of delay. Twitchy needs about half of it." (p95 534 ms of the 1000 ms delay)
- "Everything runs on your Mac. No frame ever leaves your machine, and there's no AI bill." (Apple Vision OCR, regex + checks, $0 running cost)
- "Your watchlist never leaves your laptop, and not even a moderator can unmask it."
- "It knows the difference": decoys stay unmasked (`react@18.3.1`, `password: string`, a 16-digit order number that fails the card checksum, a name one letter off from the watchlist).
- "We didn't just say it works, we built a test that tries to break it."

## Numbers to show

| Number | Source |
|---|---|
| **33/33** secrets blocked, **0** false alarms (11 decoys), **3/3** quick flashes | Gauntlet seed 2 |
| p50 **287 ms**, p95 **534 ms** detect-to-mask, **1 s** stream delay | Gauntlet seed 2 |
| 8 kinds of leak: API keys (OpenAI, Anthropic, Stripe, GitHub, GitLab, AWS, Google, Slack, Hugging Face, npm, JWTs, Bearer tokens), passwords, emails, phones, cards, QR codes, watchlist, fixed screen regions | `architecture.md` §5 |
| Cards checked with issuer prefix + Luhn; watchlist fuzzy-matched against OCR mistakes | `architecture.md` §5 |

## Codex part (required)

Show, don't tell: the Codex threads on screen (session IDs in `codex-sessions.md`), scrolling through a prompt and the commit it produced.

- Two developers, two parallel Codex threads, one per track (shield engine / Twitch + Twitchy), talking only through a shared event contract (`architecture.md`).
- `AGENTS.md` set the rules Codex followed: stay in your track's folders, test, update the docs, commit small.
- What Codex built: the shield engine, the Leak Gauntlet scoring and runner, the private watchlist, the Twitch bot and overlay. *(Check with Salina what to list for Track B.)*
- CI on every push: typecheck + tests, including an OCR accuracy test on a real macOS runner.

## Twitch integration to show

- **Auto-arm:** the shield turns on by itself when you go live (EventSub `stream.online`).
- **Chat commands:** `!panic`, `!unblur`, `!shield on/off` (mods only), `!twitchy` (everyone).
- **Twitchy announces saves in chat.**
- **Overlay** on the live stream: Twitchy + leaks-blocked counter.

## Don't

- **Don't show anything real.** Close the real `.env`, password manager, email and DMs. Use fake keys and a fake address (the Gauntlet once read a real password from an editor left open behind it). Never show the OBS stream key.
- Don't claim what isn't built: plain-English rules, IP addresses, seed phrases, Windows. *(Dashboard and per-leak Twitchy reactions: only if Salina has them working.)*
- Don't say "blur": masks are opaque boxes.
- Don't say "100% safe": say "33 out of 33 in our test".

## Shots to capture

- [ ] Screen recording of OBS program view (what viewers see) and, side by side, the undelayed content (what the streamer sees)
- [ ] The Twitch channel page with the stream live and chat visible
- [ ] Full Gauntlet run, seed 2, with the final score
- [ ] `npm run watchlist -- add` with hidden input
- [ ] Mod `!panic` / `!unblur` from a second account
- [ ] Codex threads and the commit history
