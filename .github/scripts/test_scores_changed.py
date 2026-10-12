import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from scores_changed import main, scores_changed  # noqa: E402


def make_db(path, scores, entries=()):
    conn = sqlite3.connect(path)
    conn.executescript(
        """CREATE TABLE scores (event_id INTEGER, unit_id INTEGER, division_id INTEGER, rank INTEGER, score REAL);
           CREATE TABLE event_entries (event_id INTEGER, unit_id INTEGER, division_id INTEGER);"""
    )
    conn.executemany("INSERT INTO scores (event_id, unit_id, division_id, score) VALUES (?,?,?,?)", scores)
    conn.executemany("INSERT INTO event_entries VALUES (?,?,?)", entries)
    conn.commit()
    conn.close()


class TestScoresChanged(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def db(self, name, scores, entries=()):
        path = os.path.join(self.dir, name)
        make_db(path, scores, entries)
        return path

    def test_identical_scores_are_unchanged(self):
        a = self.db("a.db", [(1, 7, 2, 80.0)])
        b = self.db("b.db", [(1, 7, 2, 80.0)])
        self.assertFalse(scores_changed(a, b))
        self.assertEqual(main(["x", a, b]), 1)

    def test_registration_only_changes_do_not_count(self):
        a = self.db("a.db", [(1, 7, 2, 80.0)], entries=[(9, 7, 2)])
        b = self.db("b.db", [(1, 7, 2, 80.0)], entries=[(9, 7, 2), (9, 8, 2), (10, 7, 2)])
        self.assertFalse(scores_changed(a, b))

    def test_a_new_score_counts(self):
        a = self.db("a.db", [(1, 7, 2, 80.0)])
        b = self.db("b.db", [(1, 7, 2, 80.0), (2, 7, 2, 81.5)])
        self.assertTrue(scores_changed(a, b))
        self.assertEqual(main(["x", a, b]), 0)

    def test_a_corrected_score_counts(self):
        a = self.db("a.db", [(1, 7, 2, 80.0)])
        b = self.db("b.db", [(1, 7, 2, 80.1)])
        self.assertTrue(scores_changed(a, b))

    def test_a_missing_database_is_treated_as_changed(self):
        a = self.db("a.db", [(1, 7, 2, 80.0)])
        self.assertEqual(main(["x", os.path.join(self.dir, "nope.db"), a]), 2)

    def test_an_unreadable_database_is_treated_as_changed(self):
        a = self.db("a.db", [(1, 7, 2, 80.0)])
        junk = os.path.join(self.dir, "junk.db")
        with open(junk, "wb") as f:
            f.write(b"not a database")
        self.assertEqual(main(["x", junk, a]), 2)


if __name__ == "__main__":
    unittest.main()
