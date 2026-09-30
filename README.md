# USBands Score Database

A SQLite database of USBands circuit competition results, scraped from
[usbands.org](https://usbands.org/events/). Covers every band, every
division/group (RA, A/Open x Group I-V), and every USBands event for the
season — regular season shows, state championships, and USBands
Championships (finals).

Scope is deliberately the **USBands circuit only**. usbands.org's events
calendar also lists other circuits (STATS, DeMoulin, Southwestern,
Southeastern, Ark-La-Tex, Quad States, etc.) that share the same site/booking
platform; those are excluded because they don't use the USBands division
vocabulary (`RA`, `A - Group I..V`, `Open - Group I..V`) that this scraper
filters on.

## Schema

- `bands` — one row per band (`unit_id` is usbands.org's canonical numeric ID)
- `divisions` — the class/group vocabulary (e.g. `A - Group II`)
- `events` — every event kept, tagged `event_kind`: `regular`,
  `state_championship`, or `usbands_championship`
- `championship_groups` — a named state championship or "USBands
  Championships" for a season; several `events` can roll up into one group
  (state champs are often split across multiple venues/dates by group)
- `championship_group_events` — join table for the above
- `scores` — one row per (event, band, division): score + computed rank
- `band_season_division` / `band_season_state_championship` /
  `band_season_final` — per-season tags: which group a band competes in,
  which state championship they're affiliated with, and whether they
  compete at USBands Championships that season (derived from both the
  Scores tab and the Performing Groups/registration tab, so a band shows up
  here as soon as it's registered, even before it's scored)

## Running it

Stdlib only, no dependencies. `<end_year>` is treated as the current/live
season (always scraped fresh); every year from `<start_year>` up to but not
including `<end_year>` is scraped once and cached to `data/cache/<year>.json`
forever after, since a closed season's results never change:

```bash
python scrape/update_scores.py 2022 2026 docs/data/usbands.db data/cache
```

The database itself is still fully deleted and rebuilt from scratch on every
run (idempotent) — the cache is what keeps that cheap (a closed season is a
local JSON read, not ~60 HTTP requests), not an excuse to skip it. See the
`build_database()` docstring in `scrape/update_scores.py` for why a full
rebuild-from-scratch (rather than patching the existing db file in place) is
deliberate: it's what makes re-running with unchanged data byte-identical.

## Testing

```bash
python -m unittest discover -s scrape/tests -v
```

`scrape/tests/` runs the parsing/build logic (`list_events`, `parse_scores`,
`parse_performing_groups`, `classify_event`, `build_database`, the
home-location cache's retry-safety, etc.) offline against saved real
usbands.org pages in `scrape/tests/fixtures/`, plus a couple of hand-written
snippets for edge cases a real page doesn't conveniently exhibit. `.github/
workflows/test.yml` runs this on every push/PR touching `scrape/`, and
`update.yml` runs it again before every scheduled scrape, so a scraper
regression (or a fixture caught up in a real usbands.org markup change) fails
loudly in CI instead of quietly shipping a broken database.

```bash
npm install
npx playwright install --with-deps chromium   # first time only
npm test
```

`tests/pwa/` (Playwright) covers the PWA mechanics of `docs/`: the manifest
and its icons resolve and match their declared sizes, the service worker
registers and actually takes control on the next load (a brand-new
registration does *not* control the page that triggered it -- see the
comment in `sw.js`), the app shell/database/sql.js vendor bundle end up in
Cache Storage, a genuinely offline reload (`context.setOffline(true)`, not
a mock) still renders the leaderboard, and the install banner/icon show,
hide, and re-offer correctly including on a simulated iOS user agent. This
exists as a real-browser suite rather than a DOM simulation because the
actual bugs found while building offline support (a service worker
terminated mid-revalidation, a `Response` clone race) only ever reproduced
under a real browser. `.github/workflows/pwa-tests.yml` runs it on every
push/PR touching `docs/` or `tests/pwa/`.

## Automation

`.github/workflows/update.yml` reruns the scraper every Monday morning ET and
commits `docs/data/usbands.db` (and any newly-created `data/cache/*.json`,
which only happens in the rare week a season first closes out) if anything
changed. No cloud routine or Drive upload dance needed — the database is
just a normal versioned file in this repo, so `git log` on
`docs/data/usbands.db` is the history.

**Update each season:** bump `CURRENT_SEASON_YEAR` in the workflow once
usbands.org posts the next season (`BACKFILL_START_YEAR` rarely needs to
change — it's the earliest season with real marching-band data, currently
2022).

**Failure notification:** if a run fails (or trips the sanity check), the
workflow both files a GitHub issue (titled "Weekly USBands scrape failed,"
auto-closed on the next success) and emails `mgaehring@gmail.com`. The email
step needs two repo secrets that aren't set by this repo automatically:
`MAIL_USERNAME` (a Gmail address) and `MAIL_PASSWORD` (a Gmail [App
Password](https://myaccount.google.com/apppasswords), not the account
password — requires 2-Step Verification on that Google account). Add them
under repo Settings → Secrets and variables → Actions, or via
`gh secret set MAIL_USERNAME` / `gh secret set MAIL_PASSWORD`. Test the whole
path anytime with `gh workflow run update.yml -f simulate_failure=true`
without waiting for a real failure.

## Done

- **Web UI**: a static site (`docs/index.html`, `app.js`, `style.css`) using
  `sql.js` (WASM SQLite) to query `docs/data/usbands.db` directly in the
  browser, deployed on GitHub Pages with no backend — leaderboards scoped by
  division/state/finals, score history charts, and favoriting.
- **Backfill prior seasons + season selector**: seasons 2022-2026 are all in
  the database (a season selector in the site header switches between them),
  with a per-season JSON cache so weekly runs only ever re-scrape the current
  season.
- **User-selectable theming**: a palette icon next to the dark-mode toggle
  opens a popover with Primary/Accent color pickers plus a few common
  school-color presets. Picking a color derives a full light/dark-aware
  ramp automatically (fixed lightness steps per token, hue/saturation from
  the pick) and overrides the theme's CSS custom properties at runtime; the
  choice persists in `localStorage`, same per-browser pattern as dark mode
  and favorites.
- **Cross-season trend view**: the band detail panel has a This Season/All
  Seasons toggle. All Seasons queries every scored event for that `unit_id`
  across every backfilled year, with season-boundary labels/dividers and a
  dashed line segment (plus an auto-shown caption) at any point a band's
  division changed — flagging exactly where scores stop being directly
  comparable, since that can happen mid-season, not just year to year.
- **Silent-failure detection for the scraper**: the weekly job reads the
  current season's score count from the existing db before rebuilding and
  fails loudly (skipping the commit) if it drops more than 20% from that
  baseline — a real scraper breakage should collapse toward zero, while a
  legitimate correction stays within normal week-to-week noise.
- **Compare bands view**: a "Compare" button in My Bands (shown once you've
  favorited 2+) overlays every favorited band's score line on one chart for
  the currently selected season, aligned on a shared date axis with gaps
  where a band didn't attend a given show. Uses a fixed categorical palette
  independent of the site's own (possibly user-customized) theme, since
  comparing several bands needs more mutually distinguishable hues than a
  2-color brand pair guarantees. A band that changed divisions mid-season
  (seen in testing) just shows up as two clearly-labeled series rather than
  needing special-case handling.
- **Shareable URLs**: season/group/state/finals/favorites/search all sync to
  query params (e.g. `?group=3&state=26&q=Audubon`), so a link reproduces
  the exact view. Uses `history.replaceState` (no back-button spam per
  keystroke), applies URL -> controls once on initial load only (so a link
  reproduces a view without fighting your own later changes), and silently
  falls back to defaults for any invalid/stale param instead of erroring.
- **CSV/print export**: buttons above the leaderboard export exactly what's
  currently filtered (recomputed from the same `computeRows()` the table
  itself renders from, never scraped from the DOM) as a CSV, or open the
  browser's print dialog against a print stylesheet that hides chrome
  (filters, header actions, star column) and flattens colors for paper.
- **Home-state filter**: filter the leaderboard by a band's home state,
  independent of which state championship they attend. Home city/state comes
  from each band's usbands.org profile page and is cached permanently per
  `unit_id` in `data/cache/bands.json` (schools don't relocate, so once
  resolved it's never re-fetched). A transient fetch failure is skipped
  rather than cached, so it's automatically retried on the next run instead
  of permanently recording a band as having no home state.
- **PWA manifest**: `docs/manifest.json` plus a themed icon set
  (`docs/icons/`) let a phone's browser install the site to the home screen
  as a standalone app (no address bar), matching the header's music-note
  mark and brand green/gold. Useful for checking scores from a phone at a
  competition without hunting for a browser tab. The `<meta name="theme-
  color">` tag stays synced to whatever theme is active (default, a preset,
  a custom pick, light/dark) by reading the live `--brand-green-700` CSS
  variable back off the DOM, so the browser chrome color always matches.
- **Scraper test suite** (`scrape/tests/`): unit tests for every parsing
  function plus `build_database()`'s determinism, run offline against saved
  real usbands.org pages. Runs in CI on every push/PR touching `scrape/` and
  again before each scheduled scrape, so a scraper regression fails loudly
  instead of quietly shipping a broken database.
- **"Last updated" indicator**: the footer shows the actual date the data
  last changed, not just a generic "refreshed weekly." `update.yml` writes
  `docs/data/last_updated.txt` only in the same commit as a real data change
  (so it reflects when the data changed, not merely when the job ran), and
  the page fetches it at load time -- missing or unreachable is handled
  silently, falling back to the generic text.
- **Failure notification**: a failed scheduled run (or one that trips the
  sanity check) files a GitHub issue and emails `mgaehring@gmail.com`
  instead of staying silent until someone checks the Actions tab; the issue
  auto-closes itself on the next success. See "Automation" above for the
  one-time secret setup the email path needs.
- **Install prompt**: a dismissible banner surfaces "Add to Home Screen"
  directly instead of leaving it buried in a browser menu. Uses Chrome/
  Edge's `beforeinstallprompt` where available (a real Install button), and
  falls back to brief Share-sheet instructions on iOS, which has no
  programmatic install API at all. Dismissing the banner is permanent
  (`localStorage`, same per-browser pattern as favorites/theming), but a
  small icon next to the theme controls stays as a permanent way back in --
  it renders only when installing is actually still possible (a captured
  install event, or iOS) and disappears once already installed, so there's
  never a dead button.
- **Accessibility pass** on the detail/compare overlays and theme picker
  popover: opening either overlay moves focus to its close button and traps
  Tab/Shift+Tab inside it (aria-modal alone doesn't enforce this for
  keyboard users), and closing it (Escape, the × button, or a backdrop
  click) restores focus to whatever triggered it -- the exact leaderboard
  row or Compare button, not just "somewhere on the page." The theme picker
  popover gets the same treatment (aria-expanded on its toggle, focus-follows-
  open/close) plus closes on focus-out, not just an outside click, so
  tabbing past it doesn't leave it visually open. A visually-hidden
  `aria-live` region announces the filtered band/group count on every
  re-render, instead of the whole results table being (silently, or overly
  verbosely) re-announced.
- **Offline support** (`docs/sw.js`): a service worker caches the app shell,
  the sql.js WASM bundle, and the database, so the installed (or just
  bookmarked) app keeps working with no network at all -- verified with the
  local dev server killed outright, not just simulated. The database and
  `last_updated.txt` use a cache-first-then-revalidate-in-the-background
  strategy: instant load from whatever was last fetched, refreshed quietly
  for next time. Diffing the tiny `last_updated.txt` (rather than the much
  larger database) is what triggers a live "New scores are available --
  Refresh" banner mid-session via the service worker messaging the open tab,
  not just on the next manual reload. A separate banner appears whenever
  `navigator.onLine` goes false. The first visit still has to be online to
  seed the caches -- there's no bootstrapping a PWA from nothing.
- **App-update notice**: the app shell (`app.js`/`index.html`/`style.css`)
  is cached the same stale-while-revalidate way as the database, which
  means a load always gets the *previous* cached version first, even when a
  newer one already exists -- combined with the service worker's own
  `skipWaiting()`/`clients.claim()` installing new versions silently, an
  already-open tab or an installed app reopened without a full relaunch
  could sit on old code indefinitely with no indication (this is exactly
  what caused a shipped feature to not show up on an installed PWA before
  this was added). Now a "New version available -- Reload" banner appears
  via `registration.addEventListener("updatefound", ...)` whenever a
  genuine update is detected (never on the very first install, since
  there's nothing to update *from* yet).
- **Open Graph / Twitter Card meta tags**: a link to the site now shows a
  title, description, and a branded 1200x630 preview image
  (`docs/og-image.png`, generated to match the app icon's green/gold look)
  when pasted into Slack, iMessage, Discord, or similar, instead of a bare
  link.
- **Sortable My Bands columns**: click Rank, Band, Group, Latest, Prior, or
  Δ to sort the favorited-bands table by that column (`aria-sort` kept in
  sync); clicking the active column again reverses direction. Score columns
  default to descending (highest first) on first click, text/rank columns
  to ascending, matching how each is naturally read. A band with no score
  yet always sorts last regardless of direction, rather than being buried
  arbitrarily by a `null` comparison. The choice persists per browser
  (`localStorage`), same pattern as favorites and theming.
- **PWA test suite** (`tests/pwa/`, Playwright): a real-browser suite
  covering the manifest/icons, service worker registration and caching, a
  genuinely offline reload, the install banner/icon across normal and
  simulated-iOS user agents, and the app-update-notice banner (writes a
  byte-different `sw.js` to disk mid-test, the same way a real deploy
  changes it, always restored afterward even on failure). See "Testing"
  above for why this runs in a real browser rather than a DOM simulation.
- **Lighthouse audit + two real fixes it surfaced**: Performance 75 /
  Accessibility 96 / Best Practices 100 / SEO 100 on the live site. Fixed
  (1) a genuine dark-mode contrast bug affecting five components (division
  headers, export buttons, sort headers, the segmented control's active
  state, and the install banner's dismiss hover) -- each had a color
  override for the *explicit* dark-mode toggle but was missing the
  equivalent for the `prefers-color-scheme: dark` media query, so anyone
  relying on system dark mode without ever touching the in-app toggle saw
  `--brand-green-700` text at a 3:1 contrast ratio where 4.5:1 is required;
  and (2) render-blocking `app.js`/sql.js script tags, now loaded with
  `defer`. The remaining finding (high Cumulative Layout Shift) is tracked
  above as a deliberate follow-up rather than a quick patch.
- **Full-season data export** (CSV and JSON): "Full Season CSV"/"Full
  Season JSON" buttons download every individual score for the selected
  season -- one row per (event, division, band), completely independent of
  the leaderboard's current filters. This is a genuinely different dataset
  from the existing filtered CSV export (a latest/prior snapshot): it's the
  band's full trajectory across every show, suitable for pivoting in a
  spreadsheet, which a snapshot can't provide.
- **Circuit Trends**: a new "Circuit Trends" panel (header button, same
  overlay pattern as Compare/the per-band detail view) with two views.
  **Division Averages** charts one group's average final-score-of-the-season
  across every backfilled year, defaulting to whichever group the main
  leaderboard is currently filtered to. **Most Improved** ranks every band
  by the change in their final score between two consecutive seasons, using
  each band's own trajectory regardless of division (a band that moved
  groups between seasons is still compared to itself, matching how the
  per-band cross-season chart already treats division changes) -- a band
  needs a score in both seasons being compared to appear at all.
- **Confirmed PWA icon caching, and found a real asymmetry with app.js**
  (`tests/pwa/icon-update.spec.js`): icons are precached and served through
  the same stale-while-revalidate path as the app shell, but a plain
  `page.reload()` issues *zero* network requests for `<link rel="icon">`-
  type resources -- confirmed empirically with a request listener across a
  reload. Browsers cache favicons far more aggressively than scripts or
  stylesheets, largely independent of normal per-navigation fetching, so
  the service worker's revalidation logic (proven correct once a fetch
  actually happens) often never gets the chance a simple reload gives
  app.js. Practical upshot documented in the test: if an icon's pixels ever
  need to change, ship it under a new filename rather than overwriting the
  existing one in place and hoping a revalidation happens to occur.
  Also bumped the Playwright config's test timeout to 60s and enabled a
  retry locally (not just in CI) -- as the suite grew, service-worker
  registration checks started timing out under this dev machine's
  contention from unrelated concurrent work, even though CI (a dedicated
  runner) had passed cleanly every time; the timeout/retry combination
  absorbs that local-only contention without masking a real regression,
  which would still fail both the attempt and the retry.
- **Reviewed the scraper's 20%-drop sanity-check threshold** (2026-09-30)
  against real commit history for the 2026 season's score count. Every
  observed transition so far has been flat or growing (149 -> 163 -> 272,
  then flat across three consecutive automated runs) -- the check only
  fires on a *drop*, and since a season's score count only grows as more
  shows get scored, no legitimate week-to-week transition has ever come
  close to tripping it. 20% remains a reasonable threshold: loose enough
  to never flag a normal week, tight enough to almost certainly catch a
  real scraper breakage (which would collapse the count, not trim it
  slightly). Worth another look once more real weekly production cycles
  (as opposed to this backfill's dev-time test runs) have accumulated.
- **Skeleton loader to fix Cumulative Layout Shift**: `#results` now starts
  with a static, animated placeholder (a couple of division-shaped skeleton
  sections) sized to roughly one viewport of real content, instead of
  sitting empty while the WASM database loads -- `render()`'s existing
  `results.innerHTML = ""` naturally clears it the moment real content is
  ready, no extra JS needed. Measured directly with Lighthouse rather than
  assumed: CLS went from 0.946 ("poor") to 0.077 ("good"), and the overall
  Performance score from 75 to 99. The skeleton's height is still a guess
  (it can't know a season's real row count in advance), but shrinking the
  gap between guess and reality turned out to matter far more than
  expected -- only the *difference* between skeleton and final height
  shifts anything below it, not the full height jump from empty to full.
