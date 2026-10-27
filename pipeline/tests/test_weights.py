import pandas as pd
import pytest

from common.config import model_config
from common.weights import window_weights

HALF_LIFE = model_config()["fitting"]["recencyHalfLifeGames"]
CARRYOVER = model_config()["fitting"]["priorSeasonCarryoverGames"]


def games(team: str, season: int, weeks: list[int]) -> list[dict]:
    return [{"team": team, "season": season, "week": w} for w in weeks]


def weights_for(rows: list[dict], season: int = 2026) -> pd.DataFrame:
    return window_weights(pd.DataFrame(rows), "team", season)


def test_season_window_halves_every_half_life_games():
    w = weights_for(games("A", 2026, list(range(1, 11))))
    s = w[w["window"] == "season"].set_index("week")["weight"]
    assert s[10] == pytest.approx(1.0)
    assert s[10 - HALF_LIFE] == pytest.approx(0.5)


def test_prior_season_total_weight_fades_as_season_fills_in():
    prior = games("A", 2025, list(range(1, 18)))
    for played in [0, 4, 8]:
        rows = prior + games("A", 2026, list(range(1, played + 1)))
        w = weights_for(rows)
        total_prior = w[(w["window"] == "season") & (w["season"] == 2025)]["weight"].sum()
        assert total_prior == pytest.approx(CARRYOVER * CARRYOVER / (CARRYOVER + played))


def test_older_seasons_are_ignored():
    w = weights_for(games("A", 2024, [1, 2]) + games("A", 2026, [1]))
    assert set(w["season"]) == {2026}


def test_last_n_windows_cross_into_prior_season_with_equal_weight():
    w = weights_for(games("A", 2025, [16, 17]) + games("A", 2026, [1, 2]))
    l3 = w[w["window"] == "L3"]
    assert sorted(zip(l3["season"], l3["week"], strict=True)) == [(2025, 17), (2026, 1), (2026, 2)]
    assert (l3["weight"] == 1.0).all()


def test_weights_are_per_entity():
    w = weights_for(games("A", 2026, [1, 2, 3]) + games("B", 2026, [2, 3]))
    l1 = w[w["window"] == "L3"].groupby("team").size()
    assert l1["A"] == 3 and l1["B"] == 2


def test_several_rows_per_game_share_the_game_weight():
    # e.g. defense-vs-position: one row per bucket per game
    rows = [{**g, "bucket": b} for g in games("A", 2026, [1, 2, 3, 4]) for b in ["WR1", "TE"]]
    w = weights_for(rows)
    l3 = w[w["window"] == "L3"]
    assert sorted(set(l3["week"])) == [2, 3, 4]
    assert len(l3) == 6
    season = w[w["window"] == "season"]
    per_game = season.groupby("week")["weight"].nunique()
    assert (per_game == 1).all()
