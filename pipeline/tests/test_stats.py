import numpy as np
import pandas as pd
import pytest

from common.stats import histogram_mean, ridge_team_effects, shrink, solve_tilt, yard_histogram


def test_histogram_sums_to_one_and_clips_tails():
    h = yard_histogram(pd.Series([-50, 0, 1, 1, 200]), lo=-10, hi=99)
    assert h["min"] == -10
    assert len(h["probs"]) == 110
    assert sum(h["probs"]) == pytest.approx(1.0)
    assert h["probs"][0] == pytest.approx(0.2)  # -50 clipped to -10
    assert h["probs"][-1] == pytest.approx(0.2)  # 200 clipped to 99
    assert h["probs"][11] == pytest.approx(0.4)  # value 1


def test_histogram_rejects_empty_data():
    with pytest.raises(ValueError):
        yard_histogram(pd.Series([], dtype=float), 0, 10)


def test_tilt_zero_reproduces_league_mean_and_solves_targets():
    rng = np.random.default_rng(0)
    h = yard_histogram(pd.Series(rng.gamma(2.0, 5.0, 5000)), 0, 99)
    league = histogram_mean(h)
    assert solve_tilt(h, league) == pytest.approx(0.0, abs=1e-6)
    for target in [league - 2, league + 3]:
        t = solve_tilt(h, target)
        assert histogram_mean(h, t) == pytest.approx(target, abs=1e-6)
    assert solve_tilt(h, league + 1) > 0 > solve_tilt(h, league - 1)


def test_tilt_is_clamped():
    h = {"min": 0, "probs": [0.5, 0.5]}
    assert solve_tilt(h, 10.0) == 1.0
    assert solve_tilt(h, -10.0) == -1.0


def test_shrink():
    assert shrink(0.8, 0, 0.6, 50) == 0.6
    assert shrink(0.8, 50, 0.6, 50) == pytest.approx(0.7)
    assert shrink(float("nan"), 10, 0.6, 50) == 0.6


def test_ridge_recovers_team_effects_with_small_penalty():
    teams = ["A", "B", "C", "D"]
    true_off = {"A": 0.10, "B": 0.0, "C": -0.05, "D": -0.05}
    true_def = {"A": -0.04, "B": 0.06, "C": 0.0, "D": -0.02}
    rows = [
        {"off": o, "def": d, "rate": 0.5 + true_off[o] + true_def[d], "n": 30, "w": 1.0}
        for o in teams
        for d in teams
        if o != d
    ]
    mean, off, deff = ridge_team_effects(pd.DataFrame(rows), "rate", "n", "w", lam=1e-6)
    # Effects are identified up to a shift between intercept and effects; compare differences.
    for t in teams:
        assert off[t] - off["B"] == pytest.approx(true_off[t] - true_off["B"], abs=1e-4)
        assert deff[t] - deff["C"] == pytest.approx(true_def[t] - true_def["C"], abs=1e-4)
    assert mean + off["B"] + deff["C"] == pytest.approx(0.5, abs=1e-4)


def test_ridge_shrinks_toward_zero_with_large_penalty():
    rows = [
        {"off": "A", "def": "B", "rate": 1.0, "n": 10, "w": 1.0},
        {"off": "B", "def": "A", "rate": 0.0, "n": 10, "w": 1.0},
    ]
    _, off, _ = ridge_team_effects(pd.DataFrame(rows), "rate", "n", "w", lam=1e6)
    assert abs(off["A"]) < 1e-3
