"""Fits every parameter set and builds the snapshot for one or more slates.

Usage:
  python run_slate.py --season 2026 --week 8
  python run_slate.py --season 2024 --weeks 4 8 12 16 --version 1

For a slate already played, the snapshot represents 90 minutes before its first kickoff
(walk-forward: fits only ever see earlier games).
"""

import argparse

from build_snapshot import build_snapshot, default_as_of, next_version, write_snapshot
from common.io import fits_dir, write_json
from fit_league_params import fit_league
from fit_player_params import fit_players
from fit_team_params import fit_teams


def run_slate(season: int, week: int, version: int | None = None, weather: bool = True) -> str:
    out = fits_dir(season, week)
    write_json(out / "league_base.json", fit_league(season, week))
    write_json(out / "teams.json", fit_teams(season, week))
    write_json(out / "players.json", fit_players(season, week))
    as_of = default_as_of(season, week)
    snapshot = build_snapshot(
        season, week, as_of, version or next_version(season, week), weather=weather
    )
    return write_snapshot(snapshot)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--season", type=int, required=True)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--week", type=int)
    group.add_argument("--weeks", type=int, nargs="+")
    parser.add_argument("--version", type=int, help="default: next unused version")
    parser.add_argument(
        "--no-weather", action="store_true", help="skip live forecasts (offline builds)"
    )
    args = parser.parse_args()
    for week in args.weeks or [args.week]:
        print(run_slate(args.season, week, args.version, weather=not args.no_weather))


if __name__ == "__main__":
    main()
