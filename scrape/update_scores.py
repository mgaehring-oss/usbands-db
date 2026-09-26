"""
Builds a full-circuit SQLite database of USBands score data for one season.

Scrapes usbands.org's events list and every event detail page, keeping only
divisions in the USBands vocabulary (RA, A/Open x Group I-V) -- this is what
already excludes the other circuits usbands.org's calendar also lists (STATS,
DeMoulin, Southwestern, Southeastern, Ark-La-Tex, Quad States, etc), since
those circuits don't use this exact label scheme.

Stdlib only (urllib + re + sqlite3) -- no external dependencies, so this runs
unmodified in a bare CI/cloud sandbox with just Python.

Usage:
    python update_scores.py <season_year> <output_db_path>
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
    events_html = fetch(f"https://usbands.org/events/?year={season_year}")
    events = list_events(events_html)
    log(f"Found {len(events)} events for season {season_year}")

    divisions = {}          # label -> id (assigned on first sight)
    bands = {}               # unit_id -> name
    event_rows = {}          # eid -> event dict (only for events we keep)
    championship_groups = {}  # (kind, name) -> id
    championship_group_events = set()  # (group_id, eid)
    scores = []               # (eid, uid, division_label, rank, score)
    band_season_division = set()       # (uid, division_label)
    band_season_state = set()          # (uid, group_id)
    band_season_final = set()          # (uid, group_id)

    skipped = []
    next_group_id = 1

    def get_group_id(kind, name):
        nonlocal next_group_id
        key = (kind, name)
        if key not in championship_groups:
            championship_groups[key] = next_group_id
            next_group_id += 1
        return championship_groups[key]

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

        group_id = None
        if champ_name:
            kind = "final" if event_kind == "usbands_championship" else "state"
            group_id = get_group_id(kind, champ_name)
            championship_group_events.add((group_id, eid))

        for label in all_divs:
            divisions.setdefault(label, len(divisions) + 1)
            uid_scores = scores_by_div.get(label, {})
            uid_names = performing_by_div.get(label, {})
            all_uids = set(uid_scores) | set(uid_names)
            for uid in all_uids:
                name = uid_scores.get(uid, (None, None))[0] or uid_names.get(uid)
                bands.setdefault(uid, name)
                band_season_division.add((uid, label))
                if group_id is not None:
                    if event_kind == "usbands_championship":
                        band_season_final.add((uid, group_id))
                    else:
                        band_season_state.add((uid, group_id))
                if uid in uid_scores:
                    _, score = uid_scores[uid]
                    scores.append((eid, uid, label, score))

        log(f"  [{i}/{len(events)}] event {eid} ({date_str}) '{title}': "
            f"{len(all_divs)} USBands divisions, {sum(len(v) for v in scores_by_div.values())} scores")

    log(f"Skipped {len(skipped)} events (non-USBands or unscored):")
    for eid, title, reason in skipped:
        log(f"    {eid} '{title}': {reason}")

    return {
        "season_year": season_year,
        "divisions": divisions,
        "bands": bands,
        "events": event_rows,
        "championship_groups": championship_groups,
        "championship_group_events": championship_group_events,
        "scores": scores,
        "band_season_division": band_season_division,
        "band_season_state": band_season_state,
        "band_season_final": band_season_final,
        "skipped": skipped,
    }


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


def build_database(data, path):
    """Always rebuilds `path` from scratch (deletes it first) and inserts
    rows in a fixed sort order, so re-running against unchanged source data
    produces a byte-identical file -- otherwise every scheduled run would
    show a spurious diff (SQLite's on-disk layout isn't guaranteed stable
    across differently-ordered inserts, and Python's default per-process
    string-hash randomization means set-of-tuple iteration order otherwise
    varies run to run)."""
    if os.path.exists(path):
        os.remove(path)
    season_year = data["season_year"]
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    cur = conn.cursor()

    cur.execute("INSERT OR IGNORE INTO seasons (year) VALUES (?)", (season_year,))

    for label, div_id in sorted(data["divisions"].items(), key=lambda kv: kv[1]):
        cls, num = division_class_and_number(label)
        cur.execute(
            "INSERT OR IGNORE INTO divisions (id, class, group_number, label) VALUES (?,?,?,?)",
            (div_id, cls, num, label),
        )

    for uid, name in sorted(data["bands"].items()):
        cur.execute("INSERT OR IGNORE INTO bands (unit_id, name) VALUES (?,?)", (uid, name))

    for eid, ev in sorted(data["events"].items()):
        cur.execute(
            "INSERT OR IGNORE INTO events (id, season_year, name, event_date, city, state, event_kind) "
            "VALUES (?,?,?,?,?,?,?)",
            (ev["id"], ev["season_year"], ev["name"], ev["event_date"], ev["city"], ev["state"], ev["event_kind"]),
        )

    for (kind, name), gid in sorted(data["championship_groups"].items(), key=lambda kv: kv[1]):
        cur.execute(
            "INSERT OR IGNORE INTO championship_groups (id, season_year, kind, name) VALUES (?,?,?,?)",
            (gid, season_year, kind, name),
        )

    for gid, eid in sorted(data["championship_group_events"]):
        cur.execute(
            "INSERT OR IGNORE INTO championship_group_events (championship_group_id, event_id) VALUES (?,?)",
            (gid, eid),
        )

    scored_rows = sorted(
        (eid, uid, data["divisions"][label], score) for eid, uid, label, score in data["scores"]
    )
    for eid, uid, div_id, score in scored_rows:
        cur.execute(
            "INSERT OR IGNORE INTO scores (event_id, unit_id, division_id, score) VALUES (?,?,?,?)",
            (eid, uid, div_id, score),
        )

    division_tag_rows = sorted(
        (uid, data["divisions"][label]) for uid, label in data["band_season_division"]
    )
    for uid, div_id in division_tag_rows:
        cur.execute(
            "INSERT OR IGNORE INTO band_season_division (unit_id, season_year, division_id) VALUES (?,?,?)",
            (uid, season_year, div_id),
        )

    for uid, gid in sorted(data["band_season_state"]):
        cur.execute(
            "INSERT OR IGNORE INTO band_season_state_championship (unit_id, season_year, championship_group_id) VALUES (?,?,?)",
            (uid, season_year, gid),
        )

    for uid, gid in sorted(data["band_season_final"]):
        cur.execute(
            "INSERT OR IGNORE INTO band_season_final (unit_id, season_year, championship_group_id) VALUES (?,?,?)",
            (uid, season_year, gid),
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


def main():
    season_year = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
    out_path = sys.argv[2] if len(sys.argv) > 2 else "usbands.db"

    data = crawl_season(season_year)
    build_database(data, out_path)

    summary = {
        "season_year": season_year,
        "events_kept": len(data["events"]),
        "events_skipped": len(data["skipped"]),
        "divisions": len(data["divisions"]),
        "bands": len(data["bands"]),
        "championship_groups": len(data["championship_groups"]),
        "scores": len(data["scores"]),
        "output": out_path,
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
