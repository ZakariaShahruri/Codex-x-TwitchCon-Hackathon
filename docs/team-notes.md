# Team notes

Things one track needs to know about the other's changes. Newest first. Each note says who it's for, what changed, and whether you need to do anything.

## 2026-11-03 · Dashboard redesigned again: clean bento, new fonts (Zakaria → Salina)

Replaces the 8-bit restyle below; still visual only, same ids, events and commands. Rounded tiles on near-black with one spacing value (`--space`) for gaps, padding and gutter; Twitch violet and Twitchy mint as solid accents; Funnel Sans / Funnel Display (OFL, vendored in `web/dashboard/fonts/`) instead of Inter and the pixel headings. Two small JS touches: `countTo` animates from 0 the first time a number appears, and the Recap button scrolls the recap into view. Inter and Pixelify stay in `fonts/` because the video build uses them.

## 2026-11-03 · Dashboard restyled as Twitchy's 8-bit control room (Zakaria → Salina)

Visual only: no events, commands or data changed. Pixel font for headings and big numbers, 2–4 px corners, hard 2 px borders and offset shadows, purple only on primary actions, green/amber/red only for status. Removed: the eyebrow labels, the "Local only", "2 steps", saves and latency-health badges, and the duplicate latency stat in the hero (the Latency tile still has it). Twitchy in the hero is bigger and its frame takes the state colour. The recap tile (`#report-panel`) is hidden until the stream ends or **Recap** (the old "Show report now", same `#show-report` id, now in the saves tile) is pressed, and hides again when a new stream goes live. Empty states are one line. Nothing for you to do; the details are in `architecture.md`.

## 2026-11-03 · README rewritten for judges (Zakaria → Salina)

The README now leads with the pitch, how it works, the Gauntlet result, features, setup and a "Built with Codex" section. Your Twitch setup steps are kept under "Twitch setup"; the detailed Track B notes now live only in `docs/commands.md`. It no longer calls the rules editor experimental, and neither does the dashboard: the rules tile's eyebrow now reads "Compiled once, runs locally" and the tile is open by default (still collapsible). Only `index.html` and one CSS comment changed.

## 2026-11-03 · Smooth caret on dashboard inputs (Zakaria → Salina)

- Zakaria asked for skiper-ui's skiper106 smooth caret. That's React + framer-motion, so it's ported to plain JS in `web/dashboard/smooth-caret.js` (its own `<script type="module">` after `dashboard.js`, which is unchanged) plus a few lines under the input styles in `dashboard.css`. The content-scene, watchlist label and watchlist value inputs get a purple caret that springs to the cursor; the rules textarea keeps the native caret. The native caret is hidden only on inputs the script has taken over, so if the script fails the inputs work as before. Values are only measured locally, never stored or sent.

## 2026-11-03 · Dashboard preloader (Zakaria → Salina)

- A full-screen preloader (`.preloader` in `index.html`, styles above your skeleton block in `dashboard.css`) shows Twitchy blinking between the `off` and `armed` poses while the dashboard connects. It's CSS only and leaves with your `body.loading` class, so `finishLoading()` (first message, the 0.9 s minimum and the 2.5 s fallback) controls it; no JS changed. If the script never runs it fades out on its own after 4 s. It covers your skeleton while it's up; your tile reveal plays as it fades.

## 2026-11-03 · Scroll fade on the dashboard lists (Zakaria → Salina)

- Zakaria asked for skiper-ui's skiper87 scroll fade on the dashboard. That's a React/shadcn component, so I rebuilt the same pure-CSS effect in `web/dashboard/dashboard.css` (block after `.leak-log`): the leak log, watchlist and rules lists fade at an edge only while there's more to scroll that way. Scroll-driven CSS animation, no JS; lists that fit don't fade. Nothing for you to do, just pull before your next dashboard edit.

## 2026-11-03 · Plain-English rules are live (Zakaria → Salina)

- The shield now answers `rules.compile` with `rules.compiled` (usually 1–4 s, always before your 15 s timeout). On success, `rules` holds every saved rule's `RuleSummary` (e.g. `{description: "your student ID", detector: "1 pattern"}`), and `private.state.rules` is filled at startup and after every change. Removing through `config.updated.removedRuleIds` works. Matches arrive as `leak.detected` with `kind: "custom_rule"` and `preview: "rule: <description>"`; your shield-bash reaction already covers it.
- Errors are plain sentences you can show as is, e.g. "The OpenAI account has no credits left…" or "Twitchy couldn't make a safe rule from that: … Try wording it more specifically." A second compile while one runs gets `ok: false`, "Twitchy is still learning the previous rule."
- **Your call:** the rules section is still collapsed and marked experimental. It works now, so consider opening it by default and dropping "experimental": it's storyboard step 4 in `docs/video.md`. Also the README line that calls it experimental.

## 2026-11-02 · `ip` and `seed_phrase` leaks are live (Zakaria → Salina)

- Track A now emits `leak.detected` with `kind: "ip"` (public IPv4/IPv6 addresses) and `kind: "seed_phrase"` (a 12–24 word crypto recovery phrase, masked as one box). Your overlay already maps them (house and vault), so nothing to change. I updated the one sentence in architecture §6 that said Track A didn't emit them.
- A seed phrase counts once: a `Secret Recovery Phrase:` label no longer adds a second `api_key` leak for the same words.

## 2026-11-02 · Dashboard "Set up OBS" is live (Zakaria → Salina)

- The shield now answers `obs.setup` with `obs.setupResult`. `changes` lists only what setup created or added (or `"Everything was already set up."`), then a last line with the manual step: stream `Twitchy Broadcast` and set the audio Sync Offset. A second click while setup runs gets `ok: false` with `"OBS setup is already running."` Errors never contain the OBS password. Nothing for you to change; the dashboard's `·`-joined display works as is.

## 2026-11-02 · `twitch.status.live` (Salina → Zakaria)

- **Small contract change, Track B only:** `twitch.status` gains optional `live?: boolean` (true after `stream.online`, false after `stream.offline`) so the dashboard can build the private end-of-stream report. `twitch.status` only travels Twitch → dashboard; nothing for Track A to do.

## 2026-11-02 · Streamer dashboard (Salina → Zakaria)

- Track B now serves `/dashboard/` with shield controls, OBS setup, Twitch status, watchlist labels, engine metrics, a private redacted leak log/report and a collapsed experimental rules editor. The local browser bridge validates bounded commands from dashboard sockets only; overlay sockets stay receive-only, and `config.updated` is never logged or returned to a browser.
- Track B emits `twitch.status` connection and token updates plus `live: true/false` on online/offline. The dashboard uses the stream transition for its private end-of-stream report. No additional shared event shape changed.

## 2026-11-02 · Chat cheers for saves (Salina → Zakaria)

- Twitch emits the existing `chat.cheer { by, at }` event for `!cheer`, `GG`, `PogChamp`, `<3` and "good job Twitchy" within 10 seconds after a save. It allows one cheer per viewer per save and caps accepted cheers at three per second.
- The overlay merges close cheers into one queued heart reaction after saves; each cheered save gets at most one count-only chat summary. No shared event shapes changed.

## 2026-11-02 · Tier 2 contract events (Salina ↔ Zakaria)

- **Contract change, agreed by both.** New events in `src/shared/events.ts`: `obs.setup` (B → A, `{ requestId, contentScene? }`), `obs.setupResult` (A → B, `{ requestId, ok, changes?: string[], error? }`), `chat.cheer` and `twitch.status` (both B → B). Nothing existing changed.
- `browserEvents` now also forwards `obs.setupResult`, `chat.cheer` and `twitch.status`. New `browserCommands` lists the only events a page may send (dashboard role only, payloads validated, Origin and Host checked, `config.updated` never logged).
- **Zakaria:** answer `obs.setup` with `obs.setupResult` (readable change lines, no OBS password in errors). **Salina:** emit `chat.cheer` and `twitch.status`, and enforce `browserCommands` in the web bridge.

## 2026-11-02 · Phone, card and QR leaks are live (Zakaria → Salina)

- New `leak.detected` kinds you'll now see: `phone` (preview `phone number`), `card` (`credit card`) and `qr_code` (`QR code`). They are enabled in `twitchy.config.json`. The per-type Twitchy reactions from Tier 2 can key off these, and the QR one is in the demo montage.
- A QR mask covers the whole code plus a margin, so its `box` is bigger than the code.
- No event shapes changed; nothing to do.

## 2026-11-02 · `!unblur` never unmasks the watchlist (Zakaria → Salina)

- Like sensitive regions, watchlist matches now stay masked through `!unblur`, so there's no `leak.cleared` for them. Dismissing ignores a match for the whole session, and one mod's `!unblur` would otherwise leave the streamer's address unmasked until restart. To stop masking an entry, remove it from the watchlist.
- No event shapes changed; nothing to do.

## 2026-11-02 · Personal watchlist storage (Zakaria → Salina)

- Track A now consumes the existing `config.updated.watchlist` add/remove payload, stores values only in gitignored `twitchy.private.json`, and emits `private.state` with IDs and labels only at startup and after updates. Watchlist leak previews are `watchlist: <label>`; labels containing any part of a stored value are rejected to keep previews safe.
- The dashboard can send the current shared contract; no event shapes changed. `npm run watchlist -- add|list|remove <id>` manages entries before the dashboard is ready. Add prompts with hidden input; never pass a value as an argument.

## 2026-11-02 · Track B counters and mock removal (Salina → Zakaria)

- Removed the web Track A mock: real Track A handles `shield.command` even without OBS, so running a second responder could publish conflicting shield states.
- `stream.online` still emits `shield.command on`; web normalizes `leak.detected.totalBlocked` and reconnect snapshots to a per-stream count, matching chat's `!twitchy` and offline report.
- Port-taken startup is back to Zakaria's fail-fast behavior: Track B exits with the port, likely cause and `lsof` command instead of starting another shield/chat bot without its own overlay.
- Broadcaster/moderator chat commands emit `shield.command` with the sender login in `by`; unauthorized viewers' moderation commands are silently ignored. No shared event shapes changed.

## 2026-11-02 · Leak Gauntlet uses your overlay (Zakaria → Salina)

- `npm run gauntlet` boots the shield and **your web track** in its own process (and Twitch with `--with-twitch`), so the overlay and counter react during the run, which is what we'll film for demo step 5. It flashes 25 secrets in about a minute, so expect ~28 `leak.detected` in a burst. Stop `npm run dev` first; both use `webPort`.
- A connection string like `postgres://user:pass@host` is now **one** `password` leak, not a password plus an `email`.
- No event shapes changed; nothing to do.

## 2026-11-02 · One leak stays one leak (Zakaria → Salina)

- **Moving a secret no longer re-announces it.** OCR reads the same key slightly differently as it moves (`-` as `=`), which used to send a new `leak.detected`, bump `totalBlocked` and make Twitchy jump again. Now one secret is one leak for its whole time on screen. Different secrets still count separately, so the Leak Gauntlet counts stay right.
- **`leak.cleared` arrives one frame later** (~150–300 ms): a leak now has to be missing from two frames in a row before its countdown starts, because one empty frame can be an OCR miss.
- No event shapes changed; nothing to do.

## 2026-11-02 · Two optional Twitch env values (Salina → Zakaria)

- `src/shared/config.ts` now also loads `TWITCH_CLIENT_SECRET` and `TWITCH_BOT_REFRESH_TOKEN` into `config.env`, so Track B can renew the bot's Twitch token (it expires after ~4 h, which would silence the bot mid-demo).
- Both are optional and only used by Track B. No event or behavior change for Track A; nothing to do.

## 2026-11-02 · Track A detector audit (Zakaria → Salina)

- No event payloads changed. Tier 1 now catches provider tokens shown in ordinary terminal prose (for example, npm's `Invalid token …`) and password properties nested inside TypeScript/JSON object lines.
- JSON `null` and type placeholders such as `"string"` are ignored as values. These cases should no longer create leak animations.
- Known gap: if OCR returns a secret split across separate line results (tested with a wrapped API key and email), current detectors do not join those lines and miss the secret. Spaces between OCR words within one line are handled.

## 2026-11-02 · Track A hardening (Zakaria → Salina)

**No event shapes changed** (`src/shared/events.ts` is untouched), so nothing breaks. You don't need to change anything; this is what you'll see differently.

### `unblur` now means two different things
- **During a panic:** `unblur` only lifts the panic. Secrets detected under the panic stay masked, so the overlay gets `shield.state` (back to `armed` or `degraded`) and **no `leak.cleared`** for them.
- **Otherwise:** `unblur` dismisses what is masked *right now* as a false positive. You get one `leak.cleared` per dismissed leak, and that text is ignored for the rest of the session.
- It never ignores secrets that were masked earlier but are no longer on screen, and never clears configured sensitive regions (no `leak.cleared` for them, and no repeat `leak.detected` after).
- **For `!unblur` chat replies:** you can tell which case it was from the last `shield.state` before the command: `panic` means "panic lifted"; anything else means "false positive dismissed".

### `leak.cleared` comes later
A leak now stays active as long as it's on screen. Its `leak.cleared` arrives about 1.1 s (`delayMs + safetyMarginMs`) after the **first frame where it's gone**, the moment its mask comes down on the broadcast. Before, it could arrive while the secret was still visible. Don't use `leak.cleared` as "Twitchy can relax" while text is still on screen.

### Fewer surprise leaks
- Detectors now skip code and versions that used to trigger `leak.detected`: `react@18.3.1`, `password: string`, `req.body.password`, `****`, and similar.
- They now catch more real secrets: connection-string passwords, JSON `"password":`, Bearer tokens, and Google, Stripe, GitLab, Hugging Face and npm keys.
- Scrolling text no longer grows one giant mask. The `box` in `leak.detected` is still where the leak was first seen.

### Tip: fake secrets in tests
GitHub push protection blocks pushes containing realistic fake keys (it caught a fake Stripe key in our detector tests). Build them at runtime instead, e.g. `` `${"sk_"}live_…` ``, if your Twitch fixtures ever need token-shaped strings.
