# Erasezo — working notes for coding agents

Chrome extension (MV3) that removes Google's watermark from images and video,
plus the Express + Postgres service behind it at erasezo.com.

Read this before editing. Most of it is things that will silently not work if
you don't know them.

> The tracked copy is `erasezo-web/AGENTS.md`; the one at the workspace root is
> written by `npm run sync`. Edit the tracked one, or your change disappears on
> the next sync. Same for `.cursor/rules/` — originals in
> `erasezo-web/cursor-rules/`.

---

## Layout

    erasezo-web/          Express server, marketing site, dashboard, Control Room, ALL tests
                          git → github.com/vthapan29-cloud/erasezo
    Erasezo-extension/    The extension. EDIT HERE. git, local only (no remote yet)
    1.1.2_0/              Unpacked copy Chrome loads. A mirror — never edit by hand

`1.1.2_0/` is byte-identical to `Erasezo-extension/` and a test enforces it.

---

## Rules that are not obvious

### 1. Edit the extension in `Erasezo-extension/`, then sync

    npm --prefix erasezo-web run sync

Editing `1.1.2_0/` directly is silently reverted by the next sync. This exact
trap already ate a shipped contrast fix once, through a sync script that has
since been deleted for that reason.

### 2. The site's CSP has no `unsafe-inline` in `style-src`

A `style="..."` attribute in served markup is **dropped without an error**.
Four progress bars once rendered at 100% because their inline widths were
discarded and the fill elements are blocks.

- In markup: use a class, or a `data-` attribute with a matching CSS rule.
- From JavaScript: `el.style.setProperty(...)` is fine — CSP governs markup,
  not CSSOM.

Header is set in `erasezo-web/server.js`. Do not weaken it to make something work.

### 3. Colours come from `tokens.css`, never from a literal

`erasezo-web/public/tokens.css` is the only place a colour is decided. It fans
out to both extension folders. Two things about it:

- The dark palette is written **twice** (a media query and an attribute
  selector cannot share a rule). Change one, change both — `test/theme.test.js`
  compares them.
- `--ez-accent-ink` means *what sits on the accent fill*. `--ez-accent-text`
  means *the accent used as text on a neutral ground*. They are opposites. Mixing
  them up made every primary button in the Control Room 2.34:1.

Same shape for the semantic colours: `--ez-crit` / `--ez-crit-ink`, and so on.

### 4. Content scripts outlive the extension

Reload the extension and every already-open tab keeps running an orphaned
script. `chrome.storage` and `chrome.runtime` still **exist as objects**, so
`if (chrome && chrome.storage)` passes and the call underneath throws
`Extension context invalidated`. Only `chrome.runtime.id` goes away.

`contextGuard.js` runs first in both content-script lists and wraps the entry
points. Don't add a new unguarded `chrome.*` call path outside it.

### 5. Flow's DOM has moved once and will move again

`page/flowInjector.js` attaches the in-page button. Anything Google-owned in
there is a preference, not a requirement:

- Media URLs: **one** definition, `MEDIA_ENDPOINT`, covering all three shapes
  the app has served. Don't spell the pattern out a second time — it was
  written three times and fixing one of them shipped two broken.
- Containers: `TILE_SELECTOR` lists Google's names, and `isTileLike()` is the
  structural fallback for when they rename them. The old build used
  `data-tile-id`; the current Angular build uses `flow-image-tile` and does not
  emit `data-tile-id` at all.

If the button stops appearing, run `__erasioFlowDiag()` in the Flow tab's
console. It reports which of the five gates rejected each tile.

---

## Commands

    npm --prefix erasezo-web test     # all 14 suites, 194 checks, pg-mem — no real DB
    npm --prefix erasezo-web run sync # tokens + mark + whole extension → 1.1.2_0
    railway logs                      # production
    railway variables                 # production env

Run a single suite: `node erasezo-web/test/<name>.test.js`

Tests are plain Node with `assert`. No framework, no fixtures. Postgres is
`pg-mem`, enabled by `USE_PGMEM=1` which each test sets itself.

---

## Conventions

- **No new dependencies** without a reason the standard library can't cover.
  The server is Express + `pg` + `bcryptjs` + `jsonwebtoken` + `cookie-parser`. TOTP is
  implemented on Node `crypto` against the RFC 6238 test vector.
- **Every control must do something.** Settings that persist a value nothing
  reads have been deleted from the Control Room before; don't add more. A
  dropdown that switches nothing is worse than no dropdown.
- **Don't invent content.** No testimonials, no user counts, no claims about
  competitors. Every statement on the marketing site traces to code: the
  supported surfaces come from the manifest, "never uploaded" from the absence
  of any upload host in the processing path.
- **Prices are read from `/api/plans`**, the table the server bills against.
  Never hardcode a price in markup.
- **Verify, don't assert.** Contrast is measured against the composited
  background in both themes, not eyeballed. If a measurement looks impossible,
  measure that one element directly before believing the sweep — and let a
  theme change settle first, or you will catch a half-applied frame.

---

## Money paths — extra care

- `moveCredits()` spends in one statement:
  `UPDATE ... WHERE credit_balance >= n`. The guard is in the SQL so it is
  testable; a test fires two concurrent spends at a single credit. Don't move
  that check into JavaScript.
- Entitlement resolves in one order: `users.daily_quota` → the active
  subscription's plan → free. The Control Room must show the same number the
  server enforces; it once showed a Pro subscriber "15/day" while the server
  allowed 500.
- `POST /api/billing/checkout` puts `notes.user_id` on the Razorpay
  subscription **from the session, never the request body**. That is how the
  webhook matches a payment to an account.
- The webhook verifies HMAC over the **raw body** and records the event id, so
  a retry is a no-op rather than a re-grant.

---

## Auth model

- Users: `erasezo_token` cookie, httpOnly, SameSite=Lax. The extension's
  service worker uses `Authorization: Bearer` instead, because it is
  cross-origin.
- Admin: a **separate** `erasezo_admin` cookie carrying an `adm` claim, minted
  only by `/api/admin/login` after password **and** TOTP. The ordinary session
  cookie does not open the Control Room.
- `adminAuth` re-reads `is_admin` and `disabled` from the database on every
  request — not from the token.
- The Control Room ships no data of its own; every byte comes from
  `/api/admin/*`. Serving the shell to an anonymous visitor reveals nothing.

---

## Known gaps

Don't be surprised by these; they are not bugs to fix in passing.

- **No privacy policy page.** `/privacy` redirects to `/dashboard`. The Web
  Store requires one before the extension can be updated.
- **No password reset.** No mailer dependency exists at all, and admins cannot
  reset a password either. A password user who forgets is locked out unless
  their email is a Google account.
- **Razorpay is unconfigured.** Checkout and the webhook are written and tested
  against a stub; no keys are set. See `erasezo-web/RAZORPAY.md`.
- **Six placeholder routes** (`/tool`, `/guide`, `/contact`, `/privacy`, two
  guide URLs) redirect to `/dashboard` so links out of the extension don't 404.
- **4K and upscaled 1080p Flow video are unsupported.** The panel says so
  rather than producing a bad correction.
- **Site is English only** while the extension ships 14 locales.

---

## Deploy

`erasezo-web` deploys to Railway on push to `main`. There is no build step —
the server serves `public/` directly. Extension changes do **not** deploy;
they need a Web Store upload.
