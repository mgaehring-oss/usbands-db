"""Unit tests for scrape/update_scores.py's parsing/build logic.

Runs entirely offline against saved HTML fixtures in tests/fixtures/ (real
usbands.org pages, captured once) plus a couple of small hand-written
snippets for edge cases a real page wouldn't conveniently exhibit. The goal
is to catch a scraper regression -- a code change that breaks parsing, or a
future usbands.org markup change reflected in a refreshed fixture -- in CI,
before it ships a broken database.

Run with:
    python -m unittest discover -s scrape/tests
"""
import hashlib
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import update_scores as scraper  # noqa: E402

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def load_fixture(name):
    with open(os.path.join(FIXTURES, name), "r", encoding="utf-8") as f:
        return f.read()


class TestListEvents(unittest.TestCase):
    def test_2022_season_events(self):
        events = scraper.list_events(load_fixture("events_list_2022.html"))
        self.assertEqual(len(events), 108)
        by_id = {e["id"]: e for e in events}
        self.assertEqual(
            by_id[521],
            {"id": 521, "ts": 1664002800, "title": "USBands Baytown Showcase", "city": "Baytown", "state": "TX"},
        )
        self.assertEqual(by_id[539]["title"], "Pennsylvania State Championships")
        self.assertEqual(by_id[539]["state"], "PA")

    def test_2026_season_finals_event(self):
        events = scraper.list_events(load_fixture("events_list_2026.html"))
        by_id = {e["id"]: e for e in events}
        self.assertEqual(by_id[1450]["title"], "USBands Championships - Regional A, II A, III A, I Open")
        self.assertEqual(by_id[1450]["state"], "PA")

    def test_no_duplicate_ids(self):
        events = scraper.list_events(load_fixture("events_list_2022.html"))
        ids = [e["id"] for e in events]
        self.assertEqual(len(ids), len(set(ids)))


class TestParseScores(unittest.TestCase):
    def test_regular_event_divisions_and_scores(self):
        scores = scraper.parse_scores(load_fixture("event_regular_521.html"))
        self.assertEqual(
            sorted(scores),
            ["Open - Group I", "Open - Group II", "Open - Group III", "Open - Group IV", "Open - Group V"],
        )
        self.assertEqual(scores["Open - Group I"][2570], ("Wharton High School", 66.7))
        self.assertEqual(scores["Open - Group V"][1839], ("Dickinson High School", 87.9))
        total = sum(len(v) for v in scores.values())
        self.assertEqual(total, 22)

    def test_only_usbands_vocabulary_divisions_kept(self):
        scores = scraper.parse_scores(load_fixture("event_state_championship_539.html"))
        for label in scores:
            self.assertRegex(label, scraper.DIVISION_RE)

    def test_missing_scores_tab_returns_empty(self):
        self.assertEqual(scraper.parse_scores("<html><body>no tabs here</body></html>"), {})


class TestParsePerformingGroups(unittest.TestCase):
    def test_finals_event_registration_rosters(self):
        groups = scraper.parse_performing_groups(load_fixture("event_finals_1450.html"))
        self.assertEqual(sorted(groups), ["A - Group II", "A - Group III", "Open - Group I"])
        self.assertEqual(groups["A - Group II"][6876], "Audubon Jr./Sr. High School")
        self.assertEqual(len(groups["A - Group III"]), 15)

    def test_missing_tab_returns_empty(self):
        self.assertEqual(scraper.parse_performing_groups("<html><body>no tabs here</body></html>"), {})


class TestClassifyEvent(unittest.TestCase):
    def test_regular_event(self):
        self.assertEqual(scraper.classify_event("USBands Baytown Showcase"), ("regular", None))

    def test_state_championship(self):
        self.assertEqual(
            scraper.classify_event("Pennsylvania State Championships"),
            ("state_championship", "Pennsylvania State Championships"),
        )

    def test_state_championship_with_trailing_detail(self):
        # The (...) suffix and everything after "Championships" must be
        # dropped from the extracted group name, not just the raw title.
        self.assertEqual(
            scraper.classify_event("New Jersey State Championships (I A, II A, IV O)"),
            ("state_championship", "New Jersey State Championships"),
        )

    def test_canceled_prefix_still_matches(self):
        self.assertEqual(
            scraper.classify_event("CANCELED - USBands Southern States Championships"),
            ("state_championship", "CANCELED - USBands Southern States Championships"),
        )

    def test_usbands_championships_is_finals(self):
        self.assertEqual(
            scraper.classify_event("USBands Championships - Regional A, II A, III A, I Open"),
            ("usbands_championship", "USBands Championships"),
        )

    def test_other_circuits_excluded_by_naming(self):
        # STATS/Southwestern/etc events share usbands.org's booking platform
        # but don't use "State(s) Championships" -- this is the mechanism
        # that keeps them out of the state_championship bucket. If a future
        # STATS-branded event ever gets misclassified, it's because
        # usbands.org changed how these titles are worded.
        self.assertEqual(scraper.classify_event("Mississippi STATS Championships"), ("regular", None))
        self.assertEqual(scraper.classify_event("STATS Grand Championships"), ("regular", None))
        self.assertEqual(
            scraper.classify_event("Southwestern Championships - Groups I, II, & IV"), ("regular", None)
        )


class TestDivisionClassAndNumber(unittest.TestCase):
    def test_ra(self):
        self.assertEqual(scraper.division_class_and_number("RA"), ("RA", None))

    def test_a_group(self):
        self.assertEqual(scraper.division_class_and_number("A - Group III"), ("A", 3))

    def test_open_group(self):
        self.assertEqual(scraper.division_class_and_number("Open - Group V"), ("Open", 5))


class TestFetchHomeLocation(unittest.TestCase):
    def test_real_profile_page(self):
        with mock.patch.object(scraper, "fetch", return_value=load_fixture("band_profile_6379.html")):
            self.assertEqual(scraper.fetch_home_location(6379), ("Camp Hill", "PA"))

    def test_no_city_state_div(self):
        with mock.patch.object(scraper, "fetch", return_value="<html><body>nothing here</body></html>"):
            self.assertEqual(scraper.fetch_home_location(1), (None, None))

    def test_malformed_city_state_without_comma(self):
        html = '<html><div class="cityState">JustOneField</div></html>'
        with mock.patch.object(scraper, "fetch", return_value=html):
            self.assertEqual(scraper.fetch_home_location(1), (None, None))

    def test_fetch_failure_propagates(self):
        # resolve_band_locations() depends on this raising rather than
        # returning (None, None), so a transient failure never gets cached
        # as a confirmed "no home state" -- see the class below.
        with mock.patch.object(scraper, "fetch", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                scraper.fetch_home_location(1)


class TestResolveBandLocations(unittest.TestCase):
    """Regression test for a real bug: a transient per-band fetch failure
    was once caught and cached as (None, None), permanently recording a
    band as having no home state. resolve_band_locations() must skip (not
    cache) a failure so it's retried on the next run."""

    def test_failed_band_is_not_cached_and_is_retried(self):
        calls = []

        def fake_fetch_home_location(uid):
            calls.append(uid)
            if uid == 2:
                raise OSError("transient network failure")
            return (f"City{uid}", "ST")

        with tempfile.TemporaryDirectory() as cache_dir:
            with mock.patch.object(scraper, "fetch_home_location", side_effect=fake_fetch_home_location):
                result = scraper.resolve_band_locations({1: "Band One", 2: "Band Two"}, cache_dir, log=lambda *a: None)
                self.assertEqual(result, {1: ("City1", "ST")})
                self.assertNotIn(2, result)

                on_disk = scraper.load_band_locations(cache_dir)
                self.assertEqual(on_disk, {1: ("City1", "ST")})

                # A second run should skip the already-cached band 1 but
                # retry band 2, since its failure was never persisted.
                calls.clear()
                result2 = scraper.resolve_band_locations({1: "Band One", 2: "Band Two"}, cache_dir, log=lambda *a: None)
                self.assertEqual(calls, [2])
                self.assertEqual(result2, {1: ("City1", "ST")})


class TestAssignGroupIds(unittest.TestCase):
    def _merged(self, champ_events):
        return {
            "champ_events": champ_events,
            "band_season_state": set(),
            "band_season_final": set(),
        }

    def test_ids_are_deterministic_regardless_of_input_order(self):
        events_a = {(2022, "state", "New Jersey", 1), (2022, "state", "Pennsylvania", 2), (2022, "final", "USBands Championships", 3)}
        events_b = {(2022, "final", "USBands Championships", 3), (2022, "state", "Pennsylvania", 2), (2022, "state", "New Jersey", 1)}
        ids_a = scraper.assign_group_ids(self._merged(events_a))
        ids_b = scraper.assign_group_ids(self._merged(events_b))
        self.assertEqual(ids_a, ids_b)

    def test_ids_assigned_in_sorted_order(self):
        events = {(2023, "state", "Zeta", 1), (2022, "state", "Alpha", 2)}
        ids = scraper.assign_group_ids(self._merged(events))
        # 2022 sorts before 2023 regardless of dict/set insertion order.
        self.assertEqual(ids[(2022, "state", "Alpha")], 1)
        self.assertEqual(ids[(2023, "state", "Zeta")], 2)


class TestBuildDatabase(unittest.TestCase):
    def _sample_merged(self):
        return {
            "start_year": 2022,
            "end_year": 2022,
            "bands": {101: "Alpha High School", 102: "Beta High School"},
            "events": {
                1: {
                    "id": 1, "season_year": 2022, "name": "Sample Show", "event_date": "2022-10-01",
                    "city": "Springfield", "state": "IL", "event_kind": "regular",
                },
            },
            "champ_events": set(),
            "scores": [(1, 101, "A - Group I", 80.0), (1, 102, "A - Group I", 75.0)],
            "band_season_division": {(101, 2022, "A - Group I"), (102, 2022, "A - Group I")},
            "band_season_state": set(),
            "band_season_final": set(),
        }

    def test_rebuild_is_byte_identical(self):
        merged = self._sample_merged()
        with tempfile.TemporaryDirectory() as tmp:
            path_a = os.path.join(tmp, "a.db")
            path_b = os.path.join(tmp, "b.db")
            scraper.build_database(merged, path_a)
            scraper.build_database(merged, path_b)
            with open(path_a, "rb") as f:
                hash_a = hashlib.md5(f.read()).hexdigest()
            with open(path_b, "rb") as f:
                hash_b = hashlib.md5(f.read()).hexdigest()
            self.assertEqual(hash_a, hash_b)

    def test_rank_computed_correctly(self):
        merged = self._sample_merged()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "test.db")
            scraper.build_database(merged, path)
            conn = sqlite3.connect(path)
            rows = dict(conn.execute("SELECT unit_id, rank FROM scores").fetchall())
            conn.close()
            self.assertEqual(rows, {101: 1, 102: 2})

    def test_bands_table_includes_locations_when_given(self):
        merged = self._sample_merged()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "test.db")
            scraper.build_database(merged, path, locations={101: ("Springfield", "IL")})
            conn = sqlite3.connect(path)
            row = conn.execute("SELECT home_city, home_state FROM bands WHERE unit_id = 101").fetchone()
            other = conn.execute("SELECT home_city, home_state FROM bands WHERE unit_id = 102").fetchone()
            conn.close()
            self.assertEqual(row, ("Springfield", "IL"))
            self.assertEqual(other, (None, None))


if __name__ == "__main__":
    unittest.main()
