"""Builders for tiny synthetic play-by-play frames, so tests never need network data."""

import numpy as np
import pandas as pd
import pytest

from common.plays import PBP_COLUMNS


def make_play(**overrides) -> dict:
    """One pbp row with neutral defaults; override any PBP_COLUMNS field."""
    row = {col: np.nan for col in PBP_COLUMNS}
    row.update(
        {
            "game_id": "2026_01_AAA_BBB",
            "play_id": 1,
            "season": 2026,
            "week": 1,
            "season_type": "REG",
            "home_team": "BBB",
            "away_team": "AAA",
            "posteam": "AAA",
            "defteam": "BBB",
            "play_type": "run",
            "qtr": 1,
            "down": 1,
            "ydstogo": 10,
            "yardline_100": 75,
            "game_seconds_remaining": 3600,
            "wp": 0.5,
            "epa": 0.0,
            "success": 0.0,
            "yards_gained": 0.0,
            "fixed_drive": 1,
            "fixed_drive_result": "Punt",
        }
    )
    for flag in [
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
    ]:
        row[flag] = 0
    row.update(overrides)
    return row


def pass_play(**kw) -> dict:
    base = {"play_type": "pass", "qb_dropback": 1, "passer_id": "QB1", "receiver_player_id": "WR1"}
    return make_play(**{**base, **kw})


@pytest.fixture
def frame():
    """frame(rows) -> DataFrame with all PBP_COLUMNS."""

    def build(rows: list[dict]) -> pd.DataFrame:
        return pd.DataFrame(rows, columns=PBP_COLUMNS)

    return build
