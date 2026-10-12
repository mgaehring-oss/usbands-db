import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(__file__))
from season_gate import current_season_year, decide, read_season_events  # noqa: E402

# Shaped like the real seasons: a regular season Sept-Nov, ending on a
# finals day with several events (see the README / season-shape notes).
FINALS_DAY = "2025-11-08"


def season(final_scores=(21, 33, 28), extra=()):
    events = [("2025-09-06", 10), ("2025-10-11", 14), ("2025-11-01", 12)]
    events += [(FINALS_DAY, n) for n in final_scores]
    events += list(extra)
    return events


class TestCurrentSeasonYear(unittest.TestCase):
    def test_august_onward_is_this_years_season(self):
        self.assertEqual(current_season_year(date(2026, 8, 1)), 2026)
        self.assertEqual(current_season_year(date(2026, 12, 31)), 2026)

    def test_january_through_july_is_still_last_years_season(self):
        self.assertEqual(current_season_year(date(2027, 1, 1)), 2026)
        self.assertEqual(current_season_year(date(2027, 7, 31)), 2026)


class TestDecide(unittest.TestCase):
    def test_runs_mid_season(self):
        run, reason = decide(date(2025, 10, 12), season())
        self.assertTrue(run)
        self.assertIn("in progress", reason)

    def test_runs_when_finals_are_still_in_the_future(self):
        run, reason = decide(date(2025, 10, 12), season(final_scores=(0, 0, 0)))
        self.assertTrue(run)
        self.assertIn("away", reason)

    def test_keeps_running_through_the_two_week_grace_period(self):
        # Late corrections and slow result posting right after finals.
        self.assertTrue(decide(date(2025, 11, 21), season())[0])   # 13 days after

    def test_pauses_once_finals_are_scored_and_grace_has_passed(self):
        run, reason = decide(date(2025, 11, 22), season())         # 14 days after
        self.assertFalse(run)
        self.assertIn("season complete", reason)

    def test_does_not_pause_while_a_final_day_event_is_unscored(self):
        run, reason = decide(date(2025, 11, 25), season(final_scores=(21, 0, 28)))
        self.assertTrue(run)
        self.assertIn("aren't all in yet", reason)

    def test_gives_up_on_a_never_scored_final_day_event(self):
        # A cancelled show or another circuit's listing shouldn't keep
        # winter scrapes going indefinitely.
        run, reason = decide(date(2025, 12, 24), season(final_scores=(21, 0, 28)))  # 46 days
        self.assertFalse(run)
        self.assertIn("giving up", reason)

    def test_stays_paused_all_winter_and_spring(self):
        for d in (date(2026, 1, 15), date(2026, 3, 1), date(2026, 7, 31)):
            self.assertFalse(decide(d, season())[0], d)

    def test_resumes_when_the_new_season_has_no_events_yet(self):
        # Aug 1 2026: current_season_year flips to 2026, which has no events.
        run, reason = decide(date(2026, 8, 1), [])
        self.assertTrue(run)
        self.assertIn("no events on record", reason)

    def test_only_the_last_date_gates_the_pause(self):
        # An earlier unscored event (e.g. cancelled mid-season) is irrelevant.
        run, _ = decide(date(2025, 11, 25), season(extra=[("2025-09-20", 0)]))
        self.assertFalse(run)


class TestReadSeasonEvents(unittest.TestCase):
    def _db(self):
        path = os.path.join(tempfile.mkdtemp(), "t.db")
        conn = sqlite3.connect(path)
        conn.executescript(
            """CREATE TABLE events (id INTEGER PRIMARY KEY, season_year INTEGER, event_date TEXT, name TEXT);
               CREATE TABLE scores (event_id INTEGER, unit_id INTEGER, division_id INTEGER, score REAL);
               INSERT INTO events VALUES (1, 2025, '2025-11-08', 'Finals'), (2, 2025, '2025-09-06', 'Opener'), (3, 2024, '2024-11-02', 'Old');
               INSERT INTO scores VALUES (1, 1, 1, 80.0), (1, 2, 1, 75.0);"""
        )
        conn.commit()
        conn.close()
        return path

    def test_counts_scores_per_event_for_the_requested_season_only(self):
        rows = dict(read_season_events(self._db(), 2025))
        self.assertEqual(rows, {"2025-11-08": 2, "2025-09-06": 0})

    def test_cancelled_and_postponed_events_are_ignored(self):
        path = self._db()
        conn = sqlite3.connect(path)
        conn.execute("INSERT INTO events VALUES (9, 2025, '2025-11-15', 'CANCELED - Late Show')")
        conn.execute("INSERT INTO events VALUES (10, 2025, '2025-11-16', 'POSTPONED - Another')")
        conn.commit()
        conn.close()
        # Without this the unscored cancelled shows would be the "last date",
        # holding the season open until the 45-day timeout.
        rows = dict(read_season_events(path, 2025))
        self.assertEqual(rows, {"2025-11-08": 2, "2025-09-06": 0})

    def test_missing_database_means_no_events(self):
        self.assertEqual(read_season_events(os.path.join(tempfile.mkdtemp(), "nope.db"), 2025), [])

    def test_database_without_schema_means_no_events(self):
        path = os.path.join(tempfile.mkdtemp(), "empty.db")
        sqlite3.connect(path).close()
        self.assertEqual(read_season_events(path, 2025), [])


if __name__ == "__main__":
    unittest.main()
