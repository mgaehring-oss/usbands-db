"""
Builds a full-circuit SQLite database of USBands score data across seasons.

Scrapes usbands.org's events list and every event detail page, keeping only
divisions in the USBands vocabulary (RA, A/Open x Group I-V) -- this is what
already excludes the other circuits usbands.org's calendar also lists (STATS,
DeMoulin, Southwestern, Southeastern, Ark-La-Tex, Quad States, etc), since
those circuits don't use this exact label scheme.

Only the CURRENT season (the end of the given year range) is ever scraped
live on a given run -- every earlier season is cached to disk as JSON on
first fetch and never re-scraped again, since a closed season's results
never change. This keeps weekly runtime constant (~one season's worth of
HTTP requests) no matter how many years of history have been backfilled.
The database itself is still fully deleted and rebuilt from scratch every
run (see build_database) -- the cache makes that cheap, rather than trying
to surgically patch an existing db file in place.

Each band's home city/state (scraped from its own usbands.org profile page,
not guessed from event locations or which state championship it attends)
is cached forever by unit_id in data/cache/bands.json, same reasoning as
the season cache -- a school's home location never changes, so only
genuinely new bands ever trigger a fetch.

Stdlib only (urllib + re + sqlite3) -- no external dependencies, so this runs
unmodified in a bare CI/cloud sandbox with just Python.

Usage:
    python update_scores.py <start_year> <end_year> <output_db_path> [cache_dir]

<end_year> is treated as the current/live season (always scraped fresh);
every year from <start_year> up to but not including <end_year> is cached.
"""
import json
import os
import re
import sqlite3
import sys
import time
import urllib.request
from datetime import datetime, timezone

import data_quality

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; USBandsDB/1.0)"}

ROMAN_TO_INT = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5}
DIVISION_RE = re.compile(r"^(RA|(A|Open) - Group (I|II|III|IV|V))$")

# Fixed vocabulary/IDs (not "first encountered" order) -- assigning IDs by
# encounter order made them depend on Python's per-process string-hash
# randomization (via set iteration order), breaking reproducible rebuilds.
DIVISION_LABELS = ["RA"] + [
    f"{cls} - Group {roman}" for cls in ("A", "Open") for roman in ("I", "II", "III", "IV", "V")
]
DIVISION_ID = {label: i + 1 for i, label in enumerate(DIVISION_LABELS)}


def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def fetch_with_retry(url, attempts=3, delay=2.0, sleep=time.sleep):
    """fetch(), retried a couple of times. A dropped connection on one event
    page used to silently remove that event from the whole build (it was
    logged as skipped), so give transient failures a chance to clear first."""
    for attempt in range(1, attempts + 1):
        try:
            return fetch(url)
        except Exception:
            if attempt == attempts:
                raise
            sleep(delay * attempt)


def _segment_by_marker(html, marker_pattern, window=None):
    """Splits html into [(label, segment_text), ...] using marker_pattern as
    section boundaries. Each segment runs from the end of one marker to the
    start of the next (or end of html / window)."""
    marks = [(m.start(), m.end(), m.group(1).strip()) for m in re.finditer(marker_pattern, html)]
    out = []
    for i, (s, e, label) in enumerate(marks):
        seg_end = marks[i + 1][0] if i + 1 < len(marks) else (window if window else len(html))
        out.append((label, html[e:seg_end]))
    return out


def list_events(html):
    """Returns [{id, ts, title, city, state}, ...] for every card on the events page."""
    events = []
    seen = set()
    marks = [(m.start(), m.end(), int(m.group(1)), int(m.group(2)))
             for m in re.finditer(r'id="event-(\d+)"\s+data-time="(\d+)"', html)]
    for i, (s, e, eid, ts) in enumerate(marks):
        if eid in seen:
            continue
        seen.add(eid)
        seg_end = marks[i + 1][0] if i + 1 < len(marks) else len(html)
        segment = html[e:seg_end]
        title_m = re.search(r'class="eventtitle"[^>]*>\s*([^<]+?)\s*</a>', segment)
        loc_m = re.search(r'<div class="location">\s*([^<]+?)\s*</div>', segment)
        title = re.sub(r"\s+", " ", title_m.group(1)).strip() if title_m else ""
        city, state = "", ""
        if loc_m:
            loc = re.sub(r"\s+", " ", loc_m.group(1)).strip()
            if "," in loc:
                city, state = [p.strip() for p in loc.rsplit(",", 1)]
            else:
                city = loc
        events.append({"id": eid, "ts": ts, "title": title, "city": city, "state": state})
    return events


def parse_scores(html):
    """Returns {division_label: {unit_id: (band_name, score)}} for every
    USBands-vocabulary division on the Scores tab."""
    idx = html.find('id="tab-scores"')
    if idx == -1:
        return {}
    tab_html = html[idx: idx + 200000]
    result = {}
    row_re = re.compile(
        r'data-unit-id="(\d+)"[^>]*>\s*([^<]+?)\s*</a>\s*</div>\s*'
        r'<div class="scores-cell scores-score">\s*([^<]+?)\s*</div>',
        re.S,
    )
    for label, segment in _segment_by_marker(tab_html, r'<div class="scores-division__name">([^<]+)</div>'):
        if not DIVISION_RE.match(label):
            continue
        division = {}
        for bm in row_re.finditer(segment):
            uid = int(bm.group(1))
            name = re.sub(r"\s+", " ", bm.group(2)).strip()
            try:
                score = float(bm.group(3).strip())
            except ValueError:
                continue
            division[uid] = (name, score)
        if division:
            result[label] = division
    return result


def parse_performing_groups(html):
    """Returns {division_label: {unit_id: band_name}} for every USBands-vocabulary
    class/division pair on the Performing Groups tab."""
    idx = html.find('id="tab-performing-groups"')
    if idx == -1:
        return {}
    tab_html = html[idx: idx + 300000]
    result = {}
    item_re = re.compile(r'data-unit-id="(\d+)"[^>]*>\s*([^<]+?)\s*</a>', re.S)
    for cls_label, cls_segment in _segment_by_marker(tab_html, r'<h3 class="performing-groups-class">([^<]+)</h3>'):
        for div_label, div_segment in _segment_by_marker(cls_segment, r'<h4 class="performing-groups-division">([^<]+)</h4>'):
            label = "RA" if cls_label.strip() == "RA" else f"{div_label.strip()} - Group {cls_label.strip()}"
            if not DIVISION_RE.match(label):
                continue
            division = result.setdefault(label, {})
            for bm in item_re.finditer(div_segment):
                uid = int(bm.group(1))
                name = re.sub(r"\s+", " ", bm.group(2)).strip()
                division[uid] = name
    return result


# usbands.org's events LIST groups several days into one bucket and stamps
# every card in it with the bucket's timestamp (e.g. shows on Oct 8, 10 and 11
# all carry "Oct 6"), so the list's data-time can't be used as the event's
# date. The event's own page states the real one.
EVENT_DATE_RE = re.compile(r'alt="Calendar"[^>]*>\s*([A-Z][a-z]+ \d{1,2}, \d{4})')


def parse_event_date(html):
    """Returns the event's real date (YYYY-MM-DD) from its detail page, or
    None if the page doesn't state one in the expected place."""
    m = EVENT_DATE_RE.search(html)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%B %d, %Y").date().isoformat()
    except ValueError:
        return None


# Upcoming regular shows have no "Performing Groups" tab -- their entries are
# on the Schedule tab, labelled "<group> <class>" ("III A", "II Open",
# "I Regional A") rather than the "A - Group III" form. Anything that isn't one
# of those (STATS "(2) White STATS", "Exhibition", "College/University", or a
# bare "Group III" with no class) is not a USBands-vocabulary division.
SCHEDULE_DIVISION_RE = re.compile(r"^(I|II|III|IV|V) (A|Open|Regional A)$")
SCHEDULE_ROW_RE = re.compile(
    r'data-unit-id="(\d+)"[^>]*>\s*([^<]+?)\s*</a>.*?'
    r'<div class="schedule-cell classification">\s*([^<]*?)\s*</div>',
    re.S,
)


def schedule_label(text):
    """'III A' -> 'A - Group III'; 'II Open' -> 'Open - Group II'; any
    'N Regional A' -> 'RA'; None for anything outside the vocabulary."""
    m = SCHEDULE_DIVISION_RE.match(re.sub(r"\s+", " ", text).strip())
    if not m:
        return None
    roman, cls = m.groups()
    if cls == "Regional A":
        return "RA"
    return f"{cls} - Group {roman}"


def parse_schedule_entries(html):
    """Returns {division_label: {unit_id: band_name}} from the Schedule tab
    (the registered performers of an event that hasn't happened yet)."""
    idx = html.find('id="tab-schedule"')
    if idx == -1:
        return {}
    tab_html = html[idx: idx + 400000]
    end = tab_html.find('id="tab-', 20)
    if end != -1:
        tab_html = tab_html[:end]
    result = {}
    for chunk in tab_html.split('<div class="schedule-row">')[1:]:
        m = SCHEDULE_ROW_RE.search(chunk)
        if not m:
            continue
        label = schedule_label(m.group(3))
        if label is None:
            continue
        name = re.sub(r"\s+", " ", m.group(2)).strip()
        result.setdefault(label, {})[int(m.group(1))] = name
    return result


CANCELLED_RE = re.compile(r"^\W*(cancel+ed|postponed)\b", re.I)
# Other circuits that share usbands.org's calendar. Only consulted for
# cancelled/postponed events that list no divisions at all (so there's nothing
# else to tell the circuits apart by).
OTHER_CIRCUIT_RE = re.compile(r"\b(STATS|Ark-La-Tex|Quad States|Southwestern|Southeastern|Showstyle|Traditional)\b", re.I)


def is_cancelled_or_postponed(title):
    return bool(CANCELLED_RE.match(title))


def keep_without_divisions(title):
    """A cancelled/postponed event with no division info is still kept (so the
    site can say a show people expected is off) -- unless it's another
    circuit's. Everything else without divisions is dropped, as before."""
    return is_cancelled_or_postponed(title) and not OTHER_CIRCUIT_RE.search(title)


def keep_unlisted_upcoming(title, event_date, state, known_states, today):
    """An upcoming show whose entries aren't posted yet (no schedule, no
    performing groups) has nothing to prove it's a USBands show, so it used to
    be dropped -- which hid real shows for weeks. Keep it when it's plainly an
    ordinary school show in the USBands footprint: in the future, not another
    circuit's, not a "...Championships" listing (those are other circuits'
    finals), and in a state where this season's kept events already are.
    Another circuit's school show in the same states would slip through; it
    shows up marked "entries not posted yet" and drops off once its page lists
    non-USBands divisions."""
    return (
        event_date >= today
        and not is_cancelled_or_postponed(title)
        and not OTHER_CIRCUIT_RE.search(title)
        and not re.search(r"championship", title, re.I)
        and state in known_states
    )


def classify_event(title):
    """Returns (event_kind, championship_group_name_or_None)."""
    if title.startswith("USBands Championships"):
        return "usbands_championship", "USBands Championships"
    m = re.match(r"^(.+?States?\s+Championships)", title)
    if m:
        return "state_championship", m.group(1).strip()
    return "regular", None


CITY_STATE_RE = re.compile(r'<div class="cityState">([^<]+)</div>')


def fetch_home_location(unit_id):
    """Scrapes a band's own profile page (not an event page) for its actual
    home city/state -- e.g. "Audubon Jr./Sr. High School, Audubon, NJ".
    Deliberately not derived from event locations or which state
    championship a band attends, since neither reliably matches a school's
    real home state (a band can travel, or a border-area school can attend
    a neighboring state's championship).

    Returns (city, state), or (None, None) if the page loaded but had no
    cityState div. Raises on a fetch failure (network/timeout) -- the
    caller must NOT cache that as a confirmed empty result, or a transient
    hiccup would permanently poison that band's home state forever."""
    html = fetch(f"https://usbands.org/units/details.php?ID={unit_id}")
    m = CITY_STATE_RE.search(html)
    if not m:
        return None, None
    parts = [p.strip() for p in m.group(1).split(",")]
    if len(parts) < 2:
        return None, None
    return parts[-2], parts[-1]  # city, state


def _band_locations_path(cache_dir):
    return os.path.join(cache_dir, "bands.json")


def load_band_locations(cache_dir):
    path = _band_locations_path(cache_dir)
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return {int(k): tuple(v) for k, v in json.load(f).items()}


def save_band_locations(cache_dir, locations):
    os.makedirs(cache_dir, exist_ok=True)
    with open(_band_locations_path(cache_dir), "w", encoding="utf-8") as f:
        json.dump({str(k): list(v) for k, v in locations.items()}, f, indent=1, sort_keys=True)


def resolve_band_locations(bands, cache_dir, log=print):
    """bands: {unit_id: name}. Returns {unit_id: (city, state)}. A band's
    home location is permanent (schools don't relocate), so it's cached
    forever across every run, same spirit as the per-season JSON cache --
    only genuinely new unit_ids ever get fetched, keeping this a one-time
    cost rather than a recurring one. A fetch failure is skipped, not
    cached, so it's automatically retried next run rather than permanently
    recorded as "no data" -- this matters because it's plain to hit a
    transient network hiccup across ~700 sequential requests."""
    locations = load_band_locations(cache_dir)
    new_count = 0
    failed = []
    for uid in sorted(bands):
        if uid in locations:
            continue
        try:
            locations[uid] = fetch_home_location(uid)
            new_count += 1
        except Exception as exc:
            log(f"    unit {uid}: fetch failed ({exc}), will retry next run")
            failed.append(uid)
        if new_count and new_count % 50 == 0:
            log(f"    ...resolved {new_count} new band locations so far")
    if new_count:
        note = f" ({len(failed)} failed, will retry next run)" if failed else ""
        log(f"Fetched home location for {new_count} new band(s); {len(locations)} cached total{note}.")
        save_band_locations(cache_dir, locations)
    elif failed:
        log(f"{len(failed)} band location fetch(es) failed; will retry next run. {len(locations)} cached total.")
    else:
        log(f"All {len(locations)} bands' home locations already cached.")
    return locations


def crawl_season(season_year, log=print):
    """Scrapes ONE season live. Returns raw per-season data with no numeric
    IDs invented for championship groups -- those are only meaningful (and
    only safe to assign) once every season being merged is known, see
    assign_group_ids(). Championship-group identity here is just its
    natural (season_year, kind, name) key."""
    events_html = fetch(f"https://usbands.org/events/?year={season_year}")
    events = list_events(events_html)
    log(f"Found {len(events)} events for season {season_year}")

    divisions_seen = set()   # labels actually encountered this season (reporting only)
    bands = {}               # unit_id -> name
    event_rows = {}          # eid -> event dict (only for events we keep)
    champ_events = set()     # (season_year, kind, name, eid)
    scores = []              # (eid, uid, division_label, score)
    entries = set()          # (eid, uid, division_label): registered for the event, scored or not
    band_season_division = set()   # (uid, season_year, division_label)
    band_season_state = set()      # (uid, season_year, championship_name)
    band_season_final = set()      # (uid, season_year, championship_name)

    skipped = []
    deferred = []            # divisionless upcoming shows awaiting the state check
    today_iso = datetime.now(timezone.utc).date().isoformat()

    for i, ev in enumerate(events, 1):
        eid, ts, title = ev["id"], ev["ts"], ev["title"]
        try:
            detail_html = fetch_with_retry(f"https://usbands.org/events/details.php?ID={eid}")
        except Exception as exc:
            log(f"  [{i}/{len(events)}] event {eid} ({title}): fetch failed ({exc}), skipping")
            skipped.append((eid, title, f"fetch failed: {exc}"))
            continue

        scores_by_div = parse_scores(detail_html)
        performing_by_div = parse_performing_groups(detail_html)
        # Upcoming regular shows list their entries on the Schedule tab only.
        # Another circuit's schedule can use the same "I A" style class names
        # (Quad States does), so those pages don't get this fallback.
        if not performing_by_div and not OTHER_CIRCUIT_RE.search(title):
            performing_by_div = parse_schedule_entries(detail_html)
        all_divs = set(scores_by_div) | set(performing_by_div)

        event_kind, champ_name = classify_event(title)
        date_str = parse_event_date(detail_html) or datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()

        if not all_divs:
            if keep_without_divisions(title):
                pass
            elif date_str >= today_iso and not is_cancelled_or_postponed(title):
                # Decided after the loop, once we know which states this
                # season's real events are in (see keep_unlisted_upcoming).
                deferred.append((eid, title, date_str, ev["state"], ev, event_kind))
                continue
            else:
                skipped.append((eid, title, "no USBands-vocabulary divisions found"))
                continue
        event_rows[eid] = {
            "id": eid, "season_year": season_year, "name": title,
            "event_date": date_str, "city": ev["city"], "state": ev["state"],
            "event_kind": event_kind,
        }

        if champ_name:
            kind = "final" if event_kind == "usbands_championship" else "state"
            champ_events.add((season_year, kind, champ_name, eid))

        for label in all_divs:
            divisions_seen.add(label)
            uid_scores = scores_by_div.get(label, {})
            uid_names = performing_by_div.get(label, {})
            all_uids = set(uid_scores) | set(uid_names)
            for uid in all_uids:
                name = uid_scores.get(uid, (None, None))[0] or uid_names.get(uid)
                bands.setdefault(uid, name)
                band_season_division.add((uid, season_year, label))
                entries.add((eid, uid, label))
                if champ_name:
                    if event_kind == "usbands_championship":
                        band_season_final.add((uid, season_year, champ_name))
                    else:
                        band_season_state.add((uid, season_year, champ_name))
                if uid in uid_scores:
                    _, score = uid_scores[uid]
                    scores.append((eid, uid, label, score))

        log(f"  [{i}/{len(events)}] event {eid} ({date_str}) '{title}': "
            f"{len(all_divs)} USBands divisions, {sum(len(v) for v in scores_by_div.values())} scores")

    known_states = {e["state"] for e in event_rows.values() if e["state"]}
    for eid, title, date_str, state, ev, event_kind in deferred:
        if keep_unlisted_upcoming(title, date_str, state, known_states, today_iso):
            event_rows[eid] = {
                "id": eid, "season_year": season_year, "name": title,
                "event_date": date_str, "city": ev["city"], "state": ev["state"],
                "event_kind": event_kind,
            }
            log(f"  event {eid} ({date_str}) '{title}': kept as upcoming, entries not posted yet")
        else:
            skipped.append((eid, title, "no USBands-vocabulary divisions found"))

    log(f"Season {season_year}: skipped {len(skipped)} events (non-USBands or unscored):")
    for eid, title, reason in skipped:
        log(f"    {eid} '{title}': {reason}")

    return {
        "season_year": season_year,
        "divisions_seen": divisions_seen,
        "bands": bands,
        "events": event_rows,
        "champ_events": champ_events,
        "scores": scores,
        "entries": entries,
        "band_season_division": band_season_division,
        "band_season_state": band_season_state,
        "band_season_final": band_season_final,
        "skipped": skipped,
    }


def _season_data_to_json(data):
    """Converts crawl_season()'s return value (sets, int-keyed dicts, tuples)
    into something json.dump can write."""
    return {
        "season_year": data["season_year"],
        "divisions_seen": sorted(data["divisions_seen"]),
        "bands": {str(uid): name for uid, name in data["bands"].items()},
        "events": {str(eid): ev for eid, ev in data["events"].items()},
        "champ_events": sorted(list(t) for t in data["champ_events"]),
        "scores": sorted(list(t) for t in data["scores"]),
        "entries": sorted(list(t) for t in data["entries"]),
        "band_season_division": sorted(list(t) for t in data["band_season_division"]),
        "band_season_state": sorted(list(t) for t in data["band_season_state"]),
        "band_season_final": sorted(list(t) for t in data["band_season_final"]),
        "skipped": data["skipped"],
    }


def _season_data_from_json(obj):
    return {
        "season_year": obj["season_year"],
        "divisions_seen": set(obj["divisions_seen"]),
        "bands": {int(uid): name for uid, name in obj["bands"].items()},
        "events": {int(eid): ev for eid, ev in obj["events"].items()},
        "champ_events": {tuple(t) for t in obj["champ_events"]},
        "scores": [tuple(t) for t in obj["scores"]],
        # Caches written before entries were tracked have none. That is fine:
        # entries only matter for upcoming shows, which only the live
        # (never-cached) season has.
        "entries": {tuple(t) for t in obj.get("entries", [])},
        "band_season_division": {tuple(t) for t in obj["band_season_division"]},
        "band_season_state": {tuple(t) for t in obj["band_season_state"]},
        "band_season_final": {tuple(t) for t in obj["band_season_final"]},
        "skipped": [tuple(t) for t in obj["skipped"]],
    }


def get_season_data(year, current_year, cache_dir, log=print):
    """A closed season is scraped once and cached forever (its results never
    change); the current season is always scraped fresh and never cached."""
    if year == current_year:
        log(f"Season {year} is the current season -- scraping fresh (not cached).")
        return crawl_season(year, log=log)

    cache_file = os.path.join(cache_dir, f"{year}.json")
    if os.path.exists(cache_file):
        log(f"Season {year}: loaded from cache ({cache_file}), no HTTP requests made.")
        with open(cache_file, "r", encoding="utf-8") as f:
            return _season_data_from_json(json.load(f))

    log(f"Season {year}: no cache found -- scraping once to build it.")
    data = crawl_season(year, log=log)
    os.makedirs(cache_dir, exist_ok=True)
    with open(cache_file, "w", encoding="utf-8") as f:
        json.dump(_season_data_to_json(data), f, indent=1, sort_keys=True)
    log(f"Season {year}: cached to {cache_file} for future runs.")
    return data


def crawl_seasons(start_year, end_year, cache_dir, log=print):
    """end_year is treated as the current/live season. Merges every season
    in [start_year, end_year] into one combined (still per-season-tagged)
    structure, ready for assign_group_ids() + build_database()."""
    merged = {
        "bands": {}, "events": {}, "champ_events": set(), "scores": [], "entries": set(),
        "band_season_division": set(), "band_season_state": set(), "band_season_final": set(),
        "divisions_seen": set(), "skipped": [],
    }
    per_season_summary = []
    for year in range(start_year, end_year + 1):
        data = get_season_data(year, end_year, cache_dir, log)
        merged["bands"].update(data["bands"])
        merged["events"].update(data["events"])
        merged["champ_events"] |= data["champ_events"]
        merged["scores"].extend(data["scores"])
        merged["entries"] |= data["entries"]
        merged["band_season_division"] |= data["band_season_division"]
        merged["band_season_state"] |= data["band_season_state"]
        merged["band_season_final"] |= data["band_season_final"]
        merged["divisions_seen"] |= data["divisions_seen"]
        merged["skipped"].extend(data["skipped"])
        per_season_summary.append({
            "year": year,
            "events_kept": len(data["events"]),
            "events_skipped": len(data["skipped"]),
            "bands": len(data["bands"]),
            "scores": len(data["scores"]),
        })
    merged["start_year"] = start_year
    merged["end_year"] = end_year
    merged["per_season_summary"] = per_season_summary
    return merged


def assign_group_ids(merged):
    """Global, deterministic IDs for championship groups across every season
    being built -- sorted by (season_year, kind, name), not discovery order,
    same fixed-vocabulary-over-encounter-order fix already applied to
    divisions (encounter order depends on Python's per-process set/dict
    iteration for string keys, which isn't stable run to run)."""
    triples = {(sy, kind, name) for (sy, kind, name, _eid) in merged["champ_events"]}
    triples |= {(sy, "state", name) for (_uid, sy, name) in merged["band_season_state"]}
    triples |= {(sy, "final", name) for (_uid, sy, name) in merged["band_season_final"]}
    return {t: i + 1 for i, t in enumerate(sorted(triples))}


SCHEMA = """
CREATE TABLE IF NOT EXISTS seasons (year INTEGER PRIMARY KEY);

CREATE TABLE IF NOT EXISTS divisions (
  id INTEGER PRIMARY KEY,
  class TEXT NOT NULL,
  group_number INTEGER,
  label TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS bands (
  unit_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  home_city TEXT,
  home_state TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  season_year INTEGER NOT NULL,
  name TEXT NOT NULL,
  event_date TEXT NOT NULL,
  city TEXT, state TEXT,
  event_kind TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS championship_groups (
  id INTEGER PRIMARY KEY,
  season_year INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE(season_year, name)
);

CREATE TABLE IF NOT EXISTS championship_group_events (
  championship_group_id INTEGER REFERENCES championship_groups(id),
  event_id INTEGER REFERENCES events(id),
  PRIMARY KEY (championship_group_id, event_id)
);

CREATE TABLE IF NOT EXISTS scores (
  event_id INTEGER REFERENCES events(id),
  unit_id INTEGER REFERENCES bands(unit_id),
  division_id INTEGER REFERENCES divisions(id),
  rank INTEGER,
  score REAL,
  PRIMARY KEY (event_id, unit_id, division_id)
);

-- Who is registered for each event (scored or not), so the site can list a
-- band's upcoming shows. Only populated for seasons crawled live; closed
-- seasons restored from an older cache simply have none.
CREATE TABLE IF NOT EXISTS event_entries (
  event_id INTEGER REFERENCES events(id),
  unit_id INTEGER REFERENCES bands(unit_id),
  division_id INTEGER REFERENCES divisions(id),
  PRIMARY KEY (event_id, unit_id, division_id)
);

CREATE TABLE IF NOT EXISTS band_season_division (
  unit_id INTEGER, season_year INTEGER, division_id INTEGER,
  PRIMARY KEY (unit_id, season_year, division_id)
);

CREATE TABLE IF NOT EXISTS band_season_state_championship (
  unit_id INTEGER, season_year INTEGER, championship_group_id INTEGER,
  PRIMARY KEY (unit_id, season_year, championship_group_id)
);

CREATE TABLE IF NOT EXISTS band_season_final (
  unit_id INTEGER, season_year INTEGER, championship_group_id INTEGER,
  PRIMARY KEY (unit_id, season_year, championship_group_id)
);
"""


def division_class_and_number(label):
    if label == "RA":
        return "RA", None
    m = re.match(r"^(A|Open) - Group (I|II|III|IV|V)$", label)
    return m.group(1), ROMAN_TO_INT[m.group(2)]


def build_database(merged, path, locations=None):
    """Always rebuilds `path` from scratch (deletes it first) and inserts
    rows in a fixed sort order, so re-running against unchanged source data
    produces a byte-identical file -- otherwise every scheduled run would
    show a spurious diff (SQLite's on-disk layout isn't guaranteed stable
    across differently-ordered inserts, and Python's default per-process
    string-hash randomization means set-of-tuple iteration order otherwise
    varies run to run). This holds regardless of how many seasons are being
    merged in, or whether a given season's data came from a fresh scrape or
    the JSON cache -- both are normalized into the same shape before this.
    """
    if os.path.exists(path):
        os.remove(path)
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    cur = conn.cursor()

    for year in range(merged["start_year"], merged["end_year"] + 1):
        cur.execute("INSERT OR IGNORE INTO seasons (year) VALUES (?)", (year,))

    # Insert the full fixed vocabulary (not just labels seen so far) -- it's
    # a reference/lookup table, not season data, so it shouldn't vary run to
    # run based on what's been scored.
    for label in DIVISION_LABELS:
        cls, num = division_class_and_number(label)
        cur.execute(
            "INSERT OR IGNORE INTO divisions (id, class, group_number, label) VALUES (?,?,?,?)",
            (DIVISION_ID[label], cls, num, label),
        )

    locations = locations or {}
    for uid, name in sorted(merged["bands"].items()):
        city, state = locations.get(uid, (None, None))
        cur.execute(
            "INSERT OR IGNORE INTO bands (unit_id, name, home_city, home_state) VALUES (?,?,?,?)",
            (uid, name, city, state),
        )

    for eid, ev in sorted(merged["events"].items()):
        cur.execute(
            "INSERT OR IGNORE INTO events (id, season_year, name, event_date, city, state, event_kind) "
            "VALUES (?,?,?,?,?,?,?)",
            (ev["id"], ev["season_year"], ev["name"], ev["event_date"], ev["city"], ev["state"], ev["event_kind"]),
        )

    group_id = assign_group_ids(merged)

    for (sy, kind, name), gid in sorted(group_id.items(), key=lambda kv: kv[1]):
        cur.execute(
            "INSERT OR IGNORE INTO championship_groups (id, season_year, kind, name) VALUES (?,?,?,?)",
            (gid, sy, kind, name),
        )

    for sy, kind, name, eid in sorted(merged["champ_events"]):
        cur.execute(
            "INSERT OR IGNORE INTO championship_group_events (championship_group_id, event_id) VALUES (?,?)",
            (group_id[(sy, kind, name)], eid),
        )

    scored_rows = sorted(
        (eid, uid, DIVISION_ID[label], score) for eid, uid, label, score in merged["scores"]
    )
    for eid, uid, div_id, score in scored_rows:
        cur.execute(
            "INSERT OR IGNORE INTO scores (event_id, unit_id, division_id, score) VALUES (?,?,?,?)",
            (eid, uid, div_id, score),
        )

    entry_rows = sorted(
        (eid, uid, DIVISION_ID[label]) for eid, uid, label in merged.get("entries", ())
    )
    for eid, uid, div_id in entry_rows:
        cur.execute(
            "INSERT OR IGNORE INTO event_entries (event_id, unit_id, division_id) VALUES (?,?,?)",
            (eid, uid, div_id),
        )

    division_tag_rows = sorted(
        (uid, sy, DIVISION_ID[label]) for uid, sy, label in merged["band_season_division"]
    )
    for uid, sy, div_id in division_tag_rows:
        cur.execute(
            "INSERT OR IGNORE INTO band_season_division (unit_id, season_year, division_id) VALUES (?,?,?)",
            (uid, sy, div_id),
        )

    state_tag_rows = sorted(
        (uid, sy, group_id[(sy, "state", name)]) for uid, sy, name in merged["band_season_state"]
    )
    for uid, sy, gid in state_tag_rows:
        cur.execute(
            "INSERT OR IGNORE INTO band_season_state_championship (unit_id, season_year, championship_group_id) VALUES (?,?,?)",
            (uid, sy, gid),
        )

    final_tag_rows = sorted(
        (uid, sy, group_id[(sy, "final", name)]) for uid, sy, name in merged["band_season_final"]
    )
    for uid, sy, gid in final_tag_rows:
        cur.execute(
            "INSERT OR IGNORE INTO band_season_final (unit_id, season_year, championship_group_id) VALUES (?,?,?)",
            (uid, sy, gid),
        )

    # Rank each band within each (event, division) by score, descending.
    cur.execute("""
        UPDATE scores SET rank = (
            SELECT COUNT(*) + 1 FROM scores AS s2
            WHERE s2.event_id = scores.event_id
              AND s2.division_id = scores.division_id
              AND s2.score > scores.score
        )
    """)

    conn.commit()
    conn.close()


def read_current_season_score_count(path, season_year):
    """Reads the current season's score count from the existing db file
    before it gets deleted and rebuilt -- the "before" side of main()'s
    sanity check. Returns None if there's no existing file (first-ever run)
    or it doesn't have the expected schema yet, in which case the check is
    skipped rather than false-triggering."""
    if not os.path.exists(path):
        return None
    conn = sqlite3.connect(path)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT COUNT(*) FROM scores s JOIN events e ON e.id = s.event_id WHERE e.season_year = ?",
            (season_year,),
        )
        return cur.fetchone()[0]
    except sqlite3.OperationalError:
        return None
    finally:
        conn.close()


def write_job_summary(errors, warnings):
    """Surfaces data-quality findings on the GitHub Actions run page (a no-op
    outside Actions). Quiet when there's nothing to report."""
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path or not (errors or warnings):
        return
    lines = ["### Scrape data-quality findings", ""]
    lines += [f"- :x: **error** -- {e}" for e in errors]
    lines += [f"- :warning: {w}" for w in warnings]
    with open(path, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def main():
    if len(sys.argv) < 4:
        print("Usage: python update_scores.py <start_year> <end_year> <output_db_path> [cache_dir]", file=sys.stderr)
        sys.exit(1)

    start_year = int(sys.argv[1])
    end_year = int(sys.argv[2])
    out_path = sys.argv[3]
    cache_dir = sys.argv[4] if len(sys.argv) > 4 else "data/cache"

    # Read the "before" count while the previous run's file still exists --
    # build_database() deletes and rebuilds it from scratch.
    previous_count = read_current_season_score_count(out_path, end_year)

    merged = crawl_seasons(start_year, end_year, cache_dir)

    # Plausibility checks run BEFORE anything is written, so a broken scrape
    # never replaces the last good database (see data_quality.py).
    quality_errors, quality_warnings = data_quality.check(merged, end_year)
    write_job_summary(quality_errors, quality_warnings)
    for w in quality_warnings:
        print(f"WARNING: {w}")
    if quality_errors:
        for e in quality_errors:
            print(f"ERROR: {e}", file=sys.stderr)
        print("Refusing to commit this build: the scraped data failed its plausibility checks.", file=sys.stderr)
        sys.exit(1)

    locations = resolve_band_locations(merged["bands"], cache_dir)
    build_database(merged, out_path, locations)

    current_season = next((s for s in merged["per_season_summary"] if s["year"] == end_year), None)
    new_count = current_season["scores"] if current_season else 0

    summary = {
        "seasons": merged["per_season_summary"],
        "total_bands": len(merged["bands"]),
        "total_events": len(merged["events"]),
        "total_scores": len(merged["scores"]),
        "output": out_path,
    }
    print(json.dumps(summary, indent=2))

    # Sanity check: a live season is a full rescan every run, so its score
    # count should only ever grow or hold steady week to week. A sharp drop
    # almost always means usbands.org changed its HTML and the scraper
    # silently stopped matching it, not a legitimate data correction --
    # fail loudly (non-zero exit, which fails the CI step and skips the
    # commit) instead of quietly shipping a regressed database. The
    # `previous_count > 5` guard skips the check when there's no meaningful
    # baseline yet (first-ever run, or the first week of a newly-bumped
    # CURRENT_SEASON_YEAR, when the "previous" count for that new year is 0).
    print(f"Season {end_year} sanity check: previous={previous_count}, new={new_count}")
    if previous_count is not None and previous_count > 5 and new_count < previous_count * 0.8:
        print(
            f"ERROR: season {end_year} score count dropped from {previous_count} to {new_count} "
            "(more than 20%) -- this looks like a scraper breakage (e.g. usbands.org changed its "
            "HTML), not a real data change. Refusing to commit this build.",
            file=sys.stderr,
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
