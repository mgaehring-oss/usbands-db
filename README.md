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

## Automation

`.github/workflows/update.yml` reruns the scraper every Sunday morning ET and
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

- **Cross-season trend view.** The per-band detail chart currently only
  shows the selected season's history. Since `unit_id` is stable across
  years (verified), a band's detail panel could add a toggle to show its
  score trajectory across every backfilled season, not just the current one.
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
