# Team notes

Things one track needs to know about the other's changes. Newest first. Each note says who it's for, what changed, and whether you need to do anything.

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
