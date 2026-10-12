"""Did the SCORES change between two builds of the database?

update.yml stamps docs/data/last_updated.txt only when this says yes. That
stamp drives two user-facing things -- the footer's "last updated" date and the
"New scores are available" banner -- so it must not move for changes that
aren't scores. Event registrations (the event_entries table behind the
Upcoming shows view) shift almost daily during the season as bands sign up;
without this check each of those would announce "new scores" to everyone with
the site open. The database file still gets committed either way, so the next
load picks the new registrations up quietly.

Exit codes: 0 = scores changed, 1 = unchanged, 2 = couldn't compare (callers
should treat that as changed, the safe side: at worst one spurious banner).
"""
import os
import sqlite3
import sys

QUERY = "SELECT event_id, unit_id, division_id, score FROM scores ORDER BY 1, 2, 3"


def read_scores(path):
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return conn.execute(QUERY).fetchall()
    finally:
        conn.close()


def scores_changed(old_path, new_path):
    return read_scores(old_path) != read_scores(new_path)


def main(argv):
    if len(argv) != 3:
        print("usage: scores_changed.py <old_db> <new_db>", file=sys.stderr)
        return 2
    old, new = argv[1], argv[2]
    if not (os.path.exists(old) and os.path.exists(new)):
        print("a database is missing -- treating as changed")
        return 2
    try:
        changed = scores_changed(old, new)
    except sqlite3.Error as exc:
        print(f"couldn't compare ({exc}) -- treating as changed")
        return 2
    print("scores changed" if changed else "scores unchanged")
    return 0 if changed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
