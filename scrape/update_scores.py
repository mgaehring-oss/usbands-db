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
import urllib.request
from datetime import datetime, timezone

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


def classify_event(title):
    """Returns (event_kind, championship_group_name_or_None)."""
    if title.startswith("USBands Championships"):
        return "usbands_championship", "USBands Championships"
    m = re.match(r"^(.+?States?\s+Championships)", title)
    if m:
        return "state_championship", m.group(1).strip()
    return "regular", None


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
    band_season_division = set()   # (uid, season_year, division_label)
    band_season_state = set()      # (uid, season_year, championship_name)
    band_season_final = set()      # (uid, season_year, championship_name)

    skipped = []

    for i, ev in enumerate(events, 1):
        eid, ts, title = ev["id"], ev["ts"], ev["title"]
        try:
            detail_html = fetch(f"https://usbands.org/events/details.php?ID={eid}")
        except Exception as exc:
            log(f"  [{i}/{len(events)}] event {eid} ({title}): fetch failed ({exc}), skipping")
            skipped.append((eid, title, f"fetch failed: {exc}"))
            continue

        scores_by_div = parse_scores(detail_html)
        performing_by_div = parse_performing_groups(detail_html)
        all_divs = set(scores_by_div) | set(performing_by_div)

        if not all_divs:
            skipped.append((eid, title, "no USBands-vocabulary divisions found"))
            continue

        event_kind, champ_name = classify_event(title)
        date_str = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
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
        "bands": {}, "events": {}, "champ_events": set(), "scores": [],
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
  name TEXT NOT NULL
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


def build_database(merged, path):
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

    for uid, name in sorted(merged["bands"].items()):
        cur.execute("INSERT OR IGNORE INTO bands (unit_id, name) VALUES (?,?)", (uid, name))

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
    build_database(merged, out_path)

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
