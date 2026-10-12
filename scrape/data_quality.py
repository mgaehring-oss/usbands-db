"""Plausibility checks on a freshly scraped dataset.

update_scores.py already refuses to ship a build whose score count collapses
(a changed usbands.org layout that silently stops matching). These checks
catch the subtler failure: markup that still matches but is mis-read -- a
column shifted so rank lands in the score field, a date parsed wrong, an event
listed twice. They run on the merged in-memory data, before the database is
written, and are split into:

  * errors   -- almost certainly a broken scrape, so the build is refused
                (non-zero exit, same path as the score-count check: the
                failure issue + email, and nothing is committed).
  * warnings -- odd but plausibly real (an 80-point swing is nearly always a
                forfeited 0.0, a back-to-back duplicate title is nearly always
                a double listing). Printed, and added to the job summary, but
                never blocking.

Stdlib only; pure functions over the same `merged` dict build_database()
takes, so they're unit-tested without any network or database.
"""
from collections import Counter, defaultdict
from datetime import date
import math

SCORE_MIN, SCORE_MAX = 0.0, 100.0
# A real zero (forfeit / disqualification) happens a handful of times a
# season -- ~0.3% of scores historically. Many zeros means the score column
# was mis-parsed, not that the whole circuit forfeited.
MAX_ZERO_FRACTION = 0.05
MIN_SCORES_FOR_ZERO_CHECK = 20
BIG_JUMP = 25.0   # points between one band's consecutive scores in a season


def check(merged, season_year, today=None):
    """Returns (errors, warnings), each a list of human-readable strings."""
    today = today or date.today()
    errors, warnings = [], []
    events = merged["events"]

    # --- errors ----------------------------------------------------------
    bad = [(eid, uid, s) for eid, uid, _label, s in merged["scores"]
           if not isinstance(s, (int, float)) or math.isnan(s) or not (SCORE_MIN <= s <= SCORE_MAX)]
    if bad:
        errors.append(
            f"{len(bad)} score(s) outside {SCORE_MIN:g}-{SCORE_MAX:g} (e.g. event {bad[0][0]}, "
            f"band {bad[0][1]}, score {bad[0][2]!r}) -- looks like a mis-parsed column"
        )

    orphans = [eid for eid, *_ in merged["scores"] if eid not in events]
    if orphans:
        errors.append(f"{len(orphans)} score(s) reference an event that wasn't kept (e.g. {orphans[0]})")

    current = [s for eid, _u, _l, s in merged["scores"]
               if eid in events and events[eid]["season_year"] == season_year]
    if len(current) >= MIN_SCORES_FOR_ZERO_CHECK:
        zeros = sum(1 for s in current if s == 0)
        if zeros / len(current) > MAX_ZERO_FRACTION:
            errors.append(
                f"{zeros} of {len(current)} season-{season_year} scores are exactly 0.0 "
                f"(>{MAX_ZERO_FRACTION:.0%}) -- looks like the score column stopped parsing"
            )

    # --- warnings --------------------------------------------------------
    for eid, ev in sorted(events.items()):
        y = int(ev["event_date"][:4])
        if y != ev["season_year"] and not (y == ev["season_year"] + 1 and ev["event_date"][5:7] in ("01", "02")):
            warnings.append(f"event {eid} '{ev['name']}' is dated {ev['event_date']}, outside season {ev['season_year']}")

    scored_events = {eid for eid, *_ in merged["scores"]}
    future = [eid for eid in scored_events
              if eid in events and date.fromisoformat(events[eid]["event_date"]) > today]
    for eid in sorted(future):
        warnings.append(f"event {eid} '{events[eid]['name']}' has scores but is dated in the future ({events[eid]['event_date']})")

    dupes = Counter((ev["event_date"], ev["name"], ev["city"]) for ev in events.values())
    for (d, name, city), n in sorted(dupes.items()):
        if n > 1:
            warnings.append(f"{n} events share the same date/title/city: {d} '{name}' ({city})")

    series = defaultdict(list)   # (uid, label, season) -> [(date, score)]
    for eid, uid, label, s in merged["scores"]:
        ev = events.get(eid)
        if ev and ev["season_year"] == season_year:
            series[(uid, label, ev["season_year"])].append((ev["event_date"], s))
    for (uid, label, _sy), pts in sorted(series.items()):
        pts.sort()
        for (d0, s0), (d1, s1) in zip(pts, pts[1:]):
            if s0 > 0 and s1 > 0 and abs(s1 - s0) >= BIG_JUMP:
                warnings.append(
                    f"band {uid} ({label}): {s0:g} on {d0} -> {s1:g} on {d1} "
                    f"({abs(s1 - s0):.1f}-point swing)"
                )
    return errors, warnings
