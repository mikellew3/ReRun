"""Downloads nflverse data to pipeline/data/raw/ as parquet, one file per dataset and season.

Usage:
  python fetch_nflverse.py                 # current season and the one before
  python fetch_nflverse.py --season 2026   # 2026 and 2025
  python fetch_nflverse.py --seasons 2022 2023 2024 2025   # explicit list (backtests)

The fitters only read these files; they never call nflverse themselves.
"""

import argparse
from collections.abc import Callable
from datetime import UTC, datetime

import nflreadpy as nfl
import polars as pl

from common.io import MANIFEST_PATH, RAW_DIR, raw_path, read_manifest, write_json

DATASETS: dict[str, Callable[[list[int]], pl.DataFrame]] = {
    "pbp": nfl.load_pbp,
    "schedules": nfl.load_schedules,
    "rosters_weekly": nfl.load_rosters_weekly,
    "depth_charts": nfl.load_depth_charts,
    "injuries": nfl.load_injuries,
    "snap_counts": nfl.load_snap_counts,
}


def fetch(seasons: list[int], datasets: list[str]) -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    manifest = read_manifest()
    for name in datasets:
        loader = DATASETS[name]
        for season in seasons:
            try:
                df = loader([season])
            except Exception as exc:  # nflverse returns errors for seasons not yet published
                print(f"  {name} {season}: not available ({type(exc).__name__}: {exc})")
                continue
            df.write_parquet(raw_path(name, season))
            manifest[f"{name}_{season}"] = datetime.now(UTC).isoformat(timespec="seconds")
            print(f"  {name} {season}: {df.height:,} rows")
    write_json(MANIFEST_PATH, manifest)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--season", type=int, help="fetch this season and the one before")
    group.add_argument("--seasons", type=int, nargs="+", help="explicit seasons")
    parser.add_argument("--datasets", nargs="+", choices=sorted(DATASETS), default=list(DATASETS))
    args = parser.parse_args()

    if args.seasons:
        seasons = args.seasons
    else:
        season = args.season or nfl.get_current_season()
        seasons = [season - 1, season]
    print(f"Fetching {', '.join(args.datasets)} for {seasons}")
    fetch(seasons, args.datasets)


if __name__ == "__main__":
    main()
