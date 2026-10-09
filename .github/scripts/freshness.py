"""Decides whether the weekly update job needs a retry and/or an alert.

Reads `gh run list --workflow=update.yml --json status,conclusion,createdAt,url`
output on stdin and prints key=value lines (also appended to $GITHUB_OUTPUT
when set). Kept as a pure function (evaluate) so the Oct 5 scenario -- a run
GitHub cancelled before any step ran -- can be unit-tested offline instead of
waiting for a real outage.

Two separate clocks, on purpose:

* Retry: if the update job has failed (or been cancelled) since its last
  success, retry it once the newest failure is >= retry_hours old (default
  40h, so a daily check lands a retry every 2 days, not every 3).
* Alert: once the job has been failing for >= max_days (default 8) with no
  success in between -- measured from the FIRST failure of the streak, so
  retries get the full window to work before anyone is emailed. If there's no
  failure at all (the cron simply never fired), measured from the last
  success instead.

Last-success time is the signal, not docs/data/last_updated.txt: that file
only changes when scores do, so a quiet week would look stale while healthy.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

FAILURE = {"failure", "cancelled", "timed_out", "startup_failure"}
ACTIVE = {"queued", "in_progress", "waiting", "pending", "requested"}


def parse_ts(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def evaluate(runs, now, max_days=8, retry_hours=40):
    runs = sorted(runs, key=lambda r: r["createdAt"], reverse=True)  # newest first
    active = any(r.get("status") in ACTIVE for r in runs)
    last_success = next((r for r in runs if r.get("conclusion") == "success"), None)
    cutoff = parse_ts(last_success["createdAt"]) if last_success else None
    streak = [
        r for r in runs
        if r.get("conclusion") in FAILURE and (cutoff is None or parse_ts(r["createdAt"]) > cutoff)
    ]

    result = {"stale": False, "retry": False, "message": "", "run_url": ""}

    if streak:
        newest, oldest = streak[0], streak[-1]
        result["run_url"] = newest.get("url", "")
        failing_hours = (now - parse_ts(oldest["createdAt"])).total_seconds() / 3600
        since_newest_hours = (now - parse_ts(newest["createdAt"])).total_seconds() / 3600
        result["stale"] = failing_hours >= max_days * 24
        result["retry"] = (not active) and since_newest_hours >= retry_hours
        result["message"] = (
            f"The update job has been failing since {oldest['createdAt']} "
            f"({failing_hours / 24:.1f} days, {len(streak)} failed run(s); alert threshold is {max_days} days)."
        )
    elif last_success:
        age_hours = (now - cutoff).total_seconds() / 3600
        result["stale"] = age_hours >= max_days * 24
        result["message"] = (
            f"The last successful update run was {last_success['createdAt']} "
            f"({age_hours / 24:.1f} days ago; alert threshold is {max_days} days)."
        )
    else:
        result["stale"] = True
        result["message"] = "update.yml has no runs on record."

    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-days", type=float, default=8)
    parser.add_argument("--retry-hours", type=float, default=40)
    parser.add_argument("--simulate-stale", action="store_true")
    args = parser.parse_args()

    runs = json.load(sys.stdin)
    result = evaluate(runs, datetime.now(timezone.utc), args.max_days, args.retry_hours)
    if args.simulate_stale:
        result["stale"] = True
        result["message"] = "SIMULATED: " + result["message"]

    lines = [f"{k}={str(v).lower() if isinstance(v, bool) else v}" for k, v in result.items()]
    print("\n".join(lines))
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
