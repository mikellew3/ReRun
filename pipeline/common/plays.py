"""Loads play-by-play for a slate and adds the play flags every fitter uses.

Walk-forward rule: only games played BEFORE the slate are returned
(prior season, or this season with week < slate week).
"""

import numpy as np
import pandas as pd

from common.config import model_config
from common.io import read_raw

PBP_COLUMNS = [
    "game_id",
    "play_id",
    "season",
    "week",
    "season_type",
    "home_team",
    "away_team",
    "posteam",
    "defteam",
    "play_type",
    "qtr",
    "down",
    "ydstogo",
    "yardline_100",
    "game_seconds_remaining",
    "wp",
    "epa",
    "success",
    "yards_gained",
    "qb_dropback",
    "sack",
    "qb_scramble",
    "qb_kneel",
    "qb_spike",
    "complete_pass",
    "incomplete_pass",
    "interception",
    "two_point_attempt",
    "fumble_lost",
    "penalty",
    "penalty_team",
    "penalty_yards",
    "no_huddle",
    "pass_oe",
    "fixed_drive",
    "fixed_drive_result",
    "out_of_bounds",
    "timeout",
    "passer_id",
    "receiver_player_id",
    "rusher_player_id",
    "air_yards",
    "kicker_player_id",
    "kick_distance",
    "field_goal_attempt",
    "field_goal_result",
    "extra_point_attempt",
    "extra_point_result",
    "touchback",
    "return_yards",
    "return_touchdown",
    "punt_blocked",
    "kickoff_out_of_bounds",
]

FLAG_COLUMNS = [
    "qb_dropback",
    "sack",
    "qb_scramble",
    "qb_kneel",
    "qb_spike",
    "complete_pass",
    "incomplete_pass",
    "interception",
    "two_point_attempt",
    "fumble_lost",
    "penalty",
    "no_huddle",
    "out_of_bounds",
    "timeout",
    "field_goal_attempt",
    "extra_point_attempt",
    "touchback",
    "return_touchdown",
    "punt_blocked",
    "kickoff_out_of_bounds",
]


def before_slate(df: pd.DataFrame, season: int, week: int) -> pd.DataFrame:
    return df[(df["season"] < season) | ((df["season"] == season) & (df["week"] < week))]


def load_pbp(season: int, week: int) -> pd.DataFrame:
    """Raw pbp rows for the prior and current season, before the slate."""
    pbp = read_raw("pbp", [season - 1, season], columns=PBP_COLUMNS)
    return add_flags(before_slate(pbp, season, week))


def add_flags(pbp: pd.DataFrame) -> pd.DataFrame:
    """Adds boolean play-type flags. Works on any frame with PBP_COLUMNS."""
    cfg = model_config()["fitting"]
    df = pbp.copy()
    for col in FLAG_COLUMNS:
        df[col] = df[col].fillna(0).astype(int) == 1

    is_scrimmage = df["play_type"].isin(["pass", "run"]) & ~df["two_point_attempt"]
    df["is_dropback"] = is_scrimmage & df["qb_dropback"] & ~df["qb_spike"]
    df["is_sack"] = df["is_dropback"] & df["sack"]
    df["is_scramble"] = df["is_dropback"] & df["qb_scramble"]
    df["is_attempt"] = (
        df["is_dropback"]
        & ~df["is_sack"]
        & ~df["is_scramble"]
        & (df["complete_pass"] | df["incomplete_pass"] | df["interception"])
    )
    df["is_complete"] = df["is_attempt"] & df["complete_pass"]
    df["is_int"] = df["is_attempt"] & df["interception"]
    df["is_designed_run"] = (
        is_scrimmage & (df["play_type"] == "run") & ~df["qb_scramble"] & ~df["qb_kneel"]
    )
    df["is_play"] = df["is_dropback"] | df["is_designed_run"]
    df["is_explosive_pass"] = df["is_complete"] & (df["yards_gained"] >= cfg["explosivePassYds"])
    df["is_explosive_run"] = df["is_designed_run"] & (df["yards_gained"] >= cfg["explosiveRunYds"])
    df["in_red_zone"] = df["yardline_100"] <= cfg["redZoneYardline"]
    df["at_goal_line"] = df["yardline_100"] <= cfg["goalLineYardline"]

    neutral = cfg["neutral"]
    df["is_neutral"] = df["wp"].between(neutral["wpMin"], neutral["wpMax"]) & (
        df["qtr"] <= neutral["maxQuarter"]
    )
    # Snaps for penalty rates: scrimmage plays plus pre-snap/no-play penalties.
    df["is_snap"] = (
        df["play_type"].isin(["pass", "run", "no_play"])
        & ~df["two_point_attempt"]
        & df["posteam"].notna()
    )
    df["epa"] = df["epa"].fillna(0.0)
    df["success"] = df["success"].fillna(0.0)
    df["yards_gained"] = df["yards_gained"].fillna(0.0)
    return df


def add_pace(df: pd.DataFrame) -> pd.DataFrame:
    """Adds `pace_gap`: seconds from the previous snap on the same drive, when the clock ran
    between them and the game state is neutral. NaN otherwise."""
    max_gap = model_config()["fitting"]["paceMaxGapSec"]
    plays = df[df["is_play"]].sort_values(["game_id", "play_id"])
    grp = plays.groupby(["game_id", "fixed_drive"], sort=False)
    prev_time = grp["game_seconds_remaining"].shift(1)
    prev_stopped = (
        grp["incomplete_pass"].shift(1, fill_value=True)
        | grp["out_of_bounds"].shift(1, fill_value=True)
        | grp["timeout"].shift(1, fill_value=True)
        | grp["penalty"].shift(1, fill_value=True)
    )
    prev_qtr = grp["qtr"].shift(1)
    gap = prev_time - plays["game_seconds_remaining"]
    ok = (
        ~prev_stopped.astype(bool)
        & (prev_qtr == plays["qtr"])
        & plays["is_neutral"]
        & (gap > 0)
        & (gap <= max_gap)
    )
    out = df.copy()
    out["pace_gap"] = np.nan
    out.loc[plays.index[ok.to_numpy()], "pace_gap"] = gap[ok]
    return out


def red_zone_drives(df: pd.DataFrame) -> pd.DataFrame:
    """One row per offensive drive that reached the red zone: game_id, posteam, td (bool)."""
    plays = df[df["is_play"]]
    drives = plays.groupby(["game_id", "posteam", "fixed_drive"]).agg(
        reached=("in_red_zone", "any"), result=("fixed_drive_result", "first")
    )
    drives = drives[drives["reached"]].reset_index()
    drives["td"] = drives["result"] == "Touchdown"
    return drives[["game_id", "posteam", "td"]]


def fg_make_prob(distance: pd.Series) -> pd.Series:
    """Config FG curve: logistic(intercept + slope * distance)."""
    curve = model_config()["kicking"]["fgCurve"]
    z = curve["intercept"] + curve["slopePerYard"] * distance
    return 1.0 / (1.0 + np.exp(-z))
