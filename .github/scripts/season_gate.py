"""Decides whether a scheduled update should scrape at all.

The cron fires year-round, but once a season is over there's nothing new to
fetch until the next one starts -- so the job asks this first and, when the
answer is "no", exits successfully in seconds instead of scraping. (It stays a
*successful* run on purpose: freshness-check.yml's retry/alert logic keys off
run history, so a season-long pause must still look healthy to it.)

Which season is "current" is derived from the calendar rather than a
hand-bumped constant: seasons run roughly Sept-Nov, so from August on it's
this year's season, and Jan-Jul it's still last year's (finished) one. That
also means the next season resumes on its own -- on Aug 1 the new year has no
events on record, which counts as "run".

"Season complete" is read from the committed database, not guessed from a
fixed date, and is based on the LAST event date rather than on a finals
event type: finals were titled "National Championships" in 2022-24 and
"USBands Championships" in 2026, so the name can't be relied on, but the last
date on the calendar is always a finals day.

  * Stop once the last event date is >= GRACE_DAYS in the past AND every event
    on that date has scores (i.e. the finals results are actually in).
  * If a final-day event never gets scored (cancelled, or another circuit's
    show that's listed but unscored), stop anyway after SCORES_TIMEOUT_DAYS
    rather than scraping all winter waiting on it.
  * Pausing is safe: when the next season starts, the finished one is crawled
    fresh once and cached (see get_season_data), which picks up any late
    additions that appeared while updates were paused.
"""
import argparse
import os
import re
import sqlite3
import sys
from datetime import date

GRACE_DAYS = 14
SCORES_TIMEOUT_DAYS = 45
SEASON_START_MONTH = 8  # August: first possible shows are early September

# A cancelled or postponed show never gets scores, so it must not count as an
# "unscored final-day event" that holds the season open (or as the last date).
CANCELLED_RE = re.compile(r"^\W*(cancel+ed|postponed)\b", re.I)


def current_season_year(today):
    return today.year if today.month >= SEASON_START_MONTH else today.year - 1


def decide(today, events):
    """events: [(event_date_iso, score_count), ...] for the current season.
    Returns (should_run, reason)."""
    if not events:
        return True, "no events on record for this season yet -- scraping to discover it"

    last = max(d for d, _ in events)
    days_since = (today - date.fromisoformat(last)).days
    final_day_scores = [n for d, n in events if d == last]
    all_scored = all(n > 0 for n in final_day_scores)

    if days_since < GRACE_DAYS:
        when = f"{-days_since} day(s) away" if days_since < 0 else f"{days_since} day(s) ago"
        return True, f"season in progress (last event {last}, {when})"
    if all_scored:
        return False, f"season complete: final-day results are in and the last event ({last}) was {days_since} days ago"
    if days_since >= SCORES_TIMEOUT_DAYS:
        return False, (
            f"giving up waiting on final-day scores {days_since} days after the last event ({last}) "
            "-- an unscored event (cancelled, or another circuit's) shouldn't keep winter scrapes going"
        )
    return True, f"last event ({last}) was {days_since} days ago but its scores aren't all in yet"


def read_season_events(db_path, season_year):
    if not os.path.exists(db_path):
        return []
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            """SELECT e.event_date, (SELECT COUNT(*) FROM scores s WHERE s.event_id = e.id), e.name
               FROM events e WHERE e.season_year = ?""",
            (season_year,),
        ).fetchall()
        return [(d, n) for d, n, name in rows if not CANCELLED_RE.match(name)]
    except sqlite3.OperationalError:
        return []  # no schema yet (first-ever run)
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("db_path")
    parser.add_argument("--force", action="store_true", help="run regardless (a person asked for this run)")
    parser.add_argument("--today", help="override today's date, YYYY-MM-DD (testing)")
    args = parser.parse_args()

    today = date.fromisoformat(args.today) if args.today else date.today()
    year = current_season_year(today)
    should_run, reason = decide(today, read_season_events(args.db_path, year))
    if args.force and not should_run:
        should_run, reason = True, f"forced run (otherwise: {reason})"

    lines = [f"run={str(should_run).lower()}", f"season_year={year}", f"reason={reason}"]
    print("\n".join(lines))
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
