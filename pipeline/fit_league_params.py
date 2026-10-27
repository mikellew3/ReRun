"""League-wide baselines for one slate: yardage histograms, expected pass-rate grid and
special-teams rates. Pooled over the prior season and this season before the slate.

Writes data/fits/{season}-W{week}/league_base.json. League-average rates and defense-vs-position
are averaged from team params in build_snapshot.py.

Usage: python fit_league_params.py --season 2026 --week 8
"""

import argparse

import numpy as np
import pandas as pd

from common.config import model_config
from common.io import fits_dir, write_json
from common.plays import load_pbp
from common.stats import yard_histogram


def distance_bucket(ydstogo: pd.Series, bounds: list[int]) -> pd.Series:
    """Index of the first bucket whose upper bound is >= ydstogo; last bucket = longer."""
    return pd.Series(np.searchsorted(bounds, ydstogo.to_numpy(), side="left"), index=ydstogo.index)


def pass_rate_grid(plays: pd.DataFrame) -> list[list[float]]:
    """Expected pass rate [down - 1][distance bucket] in neutral game states."""
    bounds = model_config()["fitting"]["passRateDistanceBuckets"]
    df = plays[plays["is_play"] & plays["is_neutral"] & plays["down"].between(1, 4)].copy()
    df["bucket"] = distance_bucket(df["ydstogo"], bounds)
    overall = df["is_dropback"].mean()
    rates = df.groupby([df["down"].astype(int), "bucket"])["is_dropback"].mean()
    return [
        [float(rates.get((down, b), overall)) for b in range(len(bounds) + 1)]
        for down in range(1, 5)
    ]


def histograms(plays: pd.DataFrame) -> dict:
    ranges = model_config()["fitting"]["histograms"]
    fitting = model_config()["fitting"]

    def hist(name: str, values: pd.Series) -> dict:
        lo, hi = ranges[name]
        return yard_histogram(values, lo, hi)

    punts = plays[
        (plays["play_type"] == "punt")
        & ~plays["punt_blocked"]
        & ~plays["return_touchdown"]
        & (plays["yardline_100"] >= fitting["puntHistogramMinYardline"])
    ]
    punt_net = np.where(
        punts["touchback"],
        punts["yardline_100"] - model_config()["rules"]["puntTouchbackYardline"],
        punts["kick_distance"].fillna(0) - punts["return_yards"].fillna(0),
    )

    kicks = returned_kickoffs(plays)
    kick_start = (
        100 - kicks["yardline_100"] - kicks["kick_distance"] + kicks["return_yards"].fillna(0)
    )

    return {
        "completionYds": hist("completionYds", plays.loc[plays["is_complete"], "yards_gained"]),
        "runYds": hist("runYds", plays.loc[plays["is_designed_run"], "yards_gained"]),
        "scrambleYds": hist("scrambleYds", plays.loc[plays["is_scramble"], "yards_gained"]),
        "sackYds": hist("sackYds", plays.loc[plays["is_sack"], "yards_gained"]),
        "puntNetYds": hist("puntNetYds", pd.Series(punt_net)),
        "kickoffStartYardline": hist("kickoffStartYardline", kick_start),
    }


def real_kickoffs(plays: pd.DataFrame) -> pd.DataFrame:
    """Kickoffs that were not onside or squib attempts."""
    min_dist = model_config()["fitting"]["kickoffMinDistance"]
    return plays[(plays["play_type"] == "kickoff") & (plays["kick_distance"] >= min_dist)]


def returned_kickoffs(plays: pd.DataFrame) -> pd.DataFrame:
    k = real_kickoffs(plays)
    return k[~k["touchback"] & ~k["return_touchdown"] & ~k["kickoff_out_of_bounds"]]


def special_teams(plays: pd.DataFrame) -> dict:
    kicks = real_kickoffs(plays)
    punts = plays[plays["play_type"] == "punt"]
    fgs = plays[plays["field_goal_attempt"]]
    return {
        "kickoffTouchbackRate": float(kicks["touchback"].mean()),
        "kickoffReturnTdRate": float(kicks["return_touchdown"].mean()),
        "puntReturnTdRate": float(punts["return_touchdown"].mean()),
        "puntTouchbackRate": float(punts["touchback"].mean()),
        "fgBlockRate": float((fgs["field_goal_result"] == "blocked").mean()),
    }


def fit_league(season: int, week: int) -> dict:
    plays = load_pbp(season, week)
    return {
        "season": season,
        "week": week,
        "plays": int(plays["is_play"].sum()),
        "histograms": histograms(plays),
        "passRateByDownDist": pass_rate_grid(plays),
        "specialTeams": special_teams(plays),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Fit league baselines for one slate.")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=int, required=True)
    args = parser.parse_args()
    result = fit_league(args.season, args.week)
    path = fits_dir(args.season, args.week) / "league_base.json"
    write_json(path, result)
    print(f"Wrote {path} ({result['plays']:,} plays)")


if __name__ == "__main__":
    main()
