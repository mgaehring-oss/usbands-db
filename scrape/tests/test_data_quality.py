"""Unit tests for scrape/data_quality.py -- the plausibility checks that run
on freshly scraped data before it can replace the committed database."""
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import data_quality as dq  # noqa: E402

TODAY = date(2026, 10, 12)


def ev(eid, d, name="Show", city="Allentown", season=2026):
    return {"id": eid, "season_year": season, "name": name, "event_date": d, "city": city, "state": "PA", "event_kind": "regular"}


def merged(events, scores):
    return {"events": {e["id"]: e for e in events}, "scores": scores}


class TestErrors(unittest.TestCase):
    def test_clean_data_has_no_findings(self):
        m = merged([ev(1, "2026-10-03"), ev(2, "2026-10-10", "Other")],
                   [(1, 7, "A - Group I", 78.2), (2, 7, "A - Group I", 80.1)])
        self.assertEqual(dq.check(m, 2026, TODAY), ([], []))

    def test_score_above_100_is_an_error(self):
        m = merged([ev(1, "2026-10-03")], [(1, 7, "A - Group I", 780.0)])
        errors, _ = dq.check(m, 2026, TODAY)
        self.assertEqual(len(errors), 1)
        self.assertIn("outside", errors[0])

    def test_negative_and_nan_scores_are_errors(self):
        m = merged([ev(1, "2026-10-03")], [(1, 7, "A - Group I", -1.0), (1, 8, "A - Group I", float("nan"))])
        errors, _ = dq.check(m, 2026, TODAY)
        self.assertIn("2 score(s)", errors[0])

    def test_a_score_for_an_unknown_event_is_an_error(self):
        errors, _ = dq.check(merged([ev(1, "2026-10-03")], [(99, 7, "A - Group I", 70.0)]), 2026, TODAY)
        self.assertTrue(any("wasn't kept" in e for e in errors))

    def test_a_few_real_zeros_are_fine(self):
        scores = [(1, u, "A - Group I", 70.0 + u / 10) for u in range(100)] + [(1, 500, "A - Group I", 0.0)]
        errors, warnings = dq.check(merged([ev(1, "2026-10-03")], scores), 2026, TODAY)
        self.assertEqual(errors, [])

    def test_mostly_zeros_means_the_score_column_broke(self):
        scores = [(1, u, "A - Group I", 0.0) for u in range(30)] + [(1, 99, "A - Group I", 70.0)]
        errors, _ = dq.check(merged([ev(1, "2026-10-03")], scores), 2026, TODAY)
        self.assertTrue(any("exactly 0.0" in e for e in errors))

    def test_zero_check_ignores_tiny_samples(self):
        scores = [(1, u, "A - Group I", 0.0) for u in range(5)]
        errors, _ = dq.check(merged([ev(1, "2026-10-03")], scores), 2026, TODAY)
        self.assertEqual(errors, [])


class TestWarnings(unittest.TestCase):
    def test_big_swing_between_consecutive_shows(self):
        m = merged([ev(1, "2026-10-03"), ev(2, "2026-10-10", "B")],
                   [(1, 7, "A - Group I", 55.0), (2, 7, "A - Group I", 83.0)])
        errors, warnings = dq.check(m, 2026, TODAY)
        self.assertEqual(errors, [])
        self.assertTrue(any("28.0-point swing" in w for w in warnings))

    def test_a_forfeit_zero_is_not_reported_as_a_swing(self):
        m = merged([ev(1, "2026-10-03"), ev(2, "2026-10-10", "B")],
                   [(1, 7, "A - Group I", 80.0), (2, 7, "A - Group I", 0.0)])
        self.assertEqual(dq.check(m, 2026, TODAY)[1], [])

    def test_swings_in_closed_seasons_are_not_reported(self):
        m = merged([ev(1, "2024-10-03", season=2024), ev(2, "2024-10-10", "B", season=2024)],
                   [(1, 7, "A - Group I", 40.0), (2, 7, "A - Group I", 80.0)])
        self.assertEqual(dq.check(m, 2026, TODAY)[1], [])

    def test_scored_event_dated_in_the_future(self):
        m = merged([ev(1, "2026-11-07")], [(1, 7, "A - Group I", 80.0)])
        self.assertTrue(any("in the future" in w for w in dq.check(m, 2026, TODAY)[1]))

    def test_unscored_future_event_is_normal(self):
        self.assertEqual(dq.check(merged([ev(1, "2026-11-07")], []), 2026, TODAY), ([], []))

    def test_duplicate_listing(self):
        m = merged([ev(1, "2026-10-03"), ev(2, "2026-10-03")], [])
        self.assertTrue(any("share the same date" in w for w in dq.check(m, 2026, TODAY)[1]))

    def test_event_dated_outside_its_season(self):
        m = merged([ev(1, "2025-10-03")], [])
        self.assertTrue(any("outside season 2026" in w for w in dq.check(m, 2026, TODAY)[1]))

    def test_january_after_the_season_year_is_allowed(self):
        self.assertEqual(dq.check(merged([ev(1, "2027-01-17")], []), 2026, TODAY)[1], [])


if __name__ == "__main__":
    unittest.main()
