import os
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
from freshness import evaluate  # noqa: E402


def run(created, conclusion="success", status="completed", url="https://example/run"):
    return {"createdAt": created, "conclusion": conclusion, "status": status, "url": url}


def at(day, hour=15, month=10):
    return datetime(2026, month, day, hour, 0, tzinfo=timezone.utc)


# The real timeline that motivated this: last success Sept 29, then the
# Oct 5 scheduled run GitHub cancelled before any step ran.
SEPT29_SUCCESS = run("2026-09-29T21:23:49Z")
OCT5_CANCELLED = run("2026-10-05T19:49:47Z", "cancelled", url="https://example/oct5")


class TestEvaluate(unittest.TestCase):
    def test_healthy_after_recent_success(self):
        r = evaluate([SEPT29_SUCCESS], at(2))
        self.assertFalse(r["stale"])
        self.assertFalse(r["retry"])

    def test_healthy_when_weekly_run_is_just_a_few_hours_late(self):
        # Monday cron not yet fired at 15:00 -- 7.1 days since last success.
        r = evaluate([run("2026-10-05T12:00:00Z")], at(12, 15))
        self.assertFalse(r["stale"])
        self.assertFalse(r["retry"])

    def test_cancelled_run_is_not_retried_too_soon(self):
        r = evaluate([SEPT29_SUCCESS, OCT5_CANCELLED], at(6, 15))  # ~19h later
        self.assertFalse(r["retry"])
        self.assertFalse(r["stale"])

    def test_cancelled_run_is_retried_after_two_days(self):
        r = evaluate([SEPT29_SUCCESS, OCT5_CANCELLED], at(7, 15))  # ~43h later
        self.assertTrue(r["retry"])
        self.assertFalse(r["stale"])
        self.assertEqual(r["run_url"], "https://example/oct5")

    def test_no_retry_while_a_run_is_in_progress(self):
        inflight = run("2026-10-07T15:00:00Z", conclusion="", status="in_progress")
        r = evaluate([SEPT29_SUCCESS, OCT5_CANCELLED, inflight], at(7, 15))
        self.assertFalse(r["retry"])

    def test_retries_continue_every_two_days_without_alerting_early(self):
        runs = [
            SEPT29_SUCCESS,
            OCT5_CANCELLED,
            run("2026-10-07T15:00:00Z", "failure"),
        ]
        r = evaluate(runs, at(9, 15))  # 48h after the newest failure, 4 days into the streak
        self.assertTrue(r["retry"])
        self.assertFalse(r["stale"])

    def test_alert_fires_only_after_eight_days_of_failing(self):
        runs = [
            SEPT29_SUCCESS,
            OCT5_CANCELLED,
            run("2026-10-07T15:00:00Z", "failure"),
            run("2026-10-09T15:00:00Z", "failure"),
            run("2026-10-11T15:00:00Z", "failure"),
        ]
        self.assertFalse(evaluate(runs, at(13, 15))["stale"])  # 7.8 days since Oct 5 19:49
        self.assertTrue(evaluate(runs, at(13, 21))["stale"])   # past 8 days

    def test_a_successful_retry_clears_everything(self):
        runs = [SEPT29_SUCCESS, OCT5_CANCELLED, run("2026-10-07T15:00:00Z", "success")]
        r = evaluate(runs, at(8, 15))
        self.assertFalse(r["stale"])
        self.assertFalse(r["retry"])

    def test_cron_that_never_fired_alerts_from_last_success(self):
        # No failure was ever recorded -- the schedule simply didn't run.
        r = evaluate([SEPT29_SUCCESS], at(8, 0))  # 8.1 days
        self.assertTrue(r["stale"])
        self.assertFalse(r["retry"])

    def test_no_runs_at_all_is_stale(self):
        self.assertTrue(evaluate([], at(8))["stale"])


if __name__ == "__main__":
    unittest.main()
