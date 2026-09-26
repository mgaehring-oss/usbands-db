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

Stdlib only, no dependencies:

```bash
python scrape/update_scores.py 2026 docs/data/usbands.db
```

Re-running does a full rebuild (idempotent), not an incremental update —
simplest way to stay correct as usbands.org's own data corrects itself
during the season.

## Automation

`.github/workflows/update.yml` reruns the scraper every Sunday morning ET
and commits `docs/data/usbands.db` if it changed. No cloud routine or Drive
upload dance needed — the database is just a normal versioned file in this
repo, so `git log` on `docs/data/usbands.db` is the history.

**Update each season:** the season year is hardcoded in the workflow
(`SEASON_YEAR` env var) — bump it once usbands.org posts the next season.

## TODO

- **Backfill prior seasons.** usbands.org supports `?year=<n>`; once this
  season's build is verified solid, re-run the scraper per past year and
  merge into the same database (the schema is already season-scoped, so
  this shouldn't need schema changes — just multiple `crawl_season()` calls
  written into the same file across seasons instead of always starting
  fresh).
- **User-selectable theming.** Let a viewer pick their own school's colors
  instead of the built-in green/gold, likely a small color-picker control
  that overrides the theme's CSS custom properties (`docs/style.css`) and
  persists the choice in `localStorage`, the same per-browser pattern
  already used for dark mode and favorites.

## Done

- **Web UI**: a static site (`docs/index.html`, `app.js`, `style.css`) using
  `sql.js` (WASM SQLite) to query `docs/data/usbands.db` directly in the
  browser, deployed on GitHub Pages with no backend — leaderboards scoped by
  division/state/finals, score history charts, and favoriting.
