"""Builds the current slate's snapshot (fresh fits, injuries and weather forecasts) and
publishes it to the web app: web/public/snapshots/<id>.json + latest.json.

Run by .github/workflows/publish-snapshot.yml after fetch_nflverse.py; Vercel redeploys on the
resulting commit. Until snapshots move to Supabase Storage (§6), only the latest snapshot is
kept in web/public/snapshots (older versions stay in git history and in pipeline/data).

    python publish_web.py [--season 2026] [--week 9] [--no-weather]
"""

from __future__ import annotations

import argparse
import json
import shutil
from datetime import UTC, datetime, timedelta

from build_snapshot import kickoff_utc
from common.io import PIPELINE_DIR, SNAPSHOTS_DIR, read_raw
from run_slate import run_slate

WEB_SNAPSHOTS = PIPELINE_DIR.parent / "web" / "public" / "snapshots"
# A slate stays current until its last game should be over.
GAME_LENGTH = timedelta(hours=4)


def current_week(season: int, now: datetime) -> int:
    """The first week with a game that hasn't finished."""
    sched = read_raw("schedules", [season])
    for week, games in sched.sort_values("week").groupby("week"):
        last = max(
            kickoff_utc(d, t) for d, t in zip(games["gameday"], games["gametime"], strict=True)
        )
        if last + GAME_LENGTH > now:
            return int(week)
    raise ValueError(f"No unfinished week in {season}")


def next_web_version(season: int, week: int) -> int:
    """One above the published version for this slate, else 1."""
    latest = WEB_SNAPSHOTS / "latest.json"
    if latest.exists():
        snap_id = json.loads(latest.read_text())["id"]
        prefix = f"{season}-W{week:02d}-v"
        if snap_id.startswith(prefix):
            return int(snap_id[len(prefix) :]) + 1
    return 1


def publish(season: int, week: int, weather: bool) -> str:
    version = next_web_version(season, week)
    print(run_slate(season, week, version, weather=weather))
    snap_id = f"{season}-W{week:02d}-v{version}"
    src = SNAPSHOTS_DIR / f"{snap_id}.json"
    for old in WEB_SNAPSHOTS.glob("*-W*-v*.json"):
        old.unlink()
    shutil.copyfile(src, WEB_SNAPSHOTS / f"{snap_id}.json")
    (WEB_SNAPSHOTS / "latest.json").write_text(
        json.dumps({"id": snap_id, "path": f"/snapshots/{snap_id}.json"}) + "\n"
    )
    games = json.loads(src.read_text())["games"]
    with_weather = [g for g in games if g["weather"]]
    print(f"Published {snap_id}: {len(with_weather)}/{len(games)} games with weather")
    for g in games:
        w = g["weather"]
        desc = (
            "dome"
            if g["stadium"]["roof"] == "dome"
            else f"{w['source']}: {w['windMph']} mph, {w['tempF']}F, {w['precip']}"
            if w
            else "no forecast"
        )
        print(f"  {g['gameId']:<18} {desc}")
    return snap_id


def main() -> None:
    import nflreadpy as nfl

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--season", type=int, default=None)
    parser.add_argument("--week", type=int, default=None)
    parser.add_argument("--no-weather", action="store_true")
    args = parser.parse_args()
    season = args.season or nfl.get_current_season()
    week = args.week or current_week(season, datetime.now(UTC))
    publish(season, week, weather=not args.no_weather)


if __name__ == "__main__":
    main()
