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

## TODO

- **Failure notification** for the weekly scrape -- right now a failed run
  (or a tripped sanity check) is silent unless someone checks the Actions
  tab.
- **Accessibility pass** on the detail/compare overlays and theme picker
  popover -- keyboard nav, focus trapping, ARIA live regions -- none of
  which got a dedicated audit as they were built.
- **Open Graph meta tags** so a shared URL shows a title/description preview
  when pasted into a group chat or Slack.
- **Surface the "Add to Home Screen" install prompt** directly, since most
  mobile browsers bury it in a menu and the PWA manifest may otherwise go
  undiscovered.

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
