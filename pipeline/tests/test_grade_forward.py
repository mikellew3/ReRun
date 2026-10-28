import pandas as pd
import pytest

import grade_forward as gf

GAME = pd.Series(
    {
        "home": 24,
        "away": 20,
        "h1Home": 10,
        "h1Away": 10,
        "closeSpread": -3.5,
        "closeTotal": 45.5,
        "closeHomeMl": -170,
        "closeAwayMl": 150,
    }
)


def rec(**kw) -> pd.Series:
    base = {"kind": "line", "market": "spreads", "line": -3.0, "priceA": -110, "priceB": -110}
    return pd.Series({**base, **kw})


def test_side_a_values():
    assert gf.side_a_value(rec(market="spreads"), GAME) == 4
    assert gf.side_a_value(rec(market="totals_h1"), GAME) == 20
    assert gf.side_a_value(rec(market="team_totals_away"), GAME) == 20


def test_outcomes_and_pushes():
    assert gf.outcome(rec(market="spreads", line=-3.0), 4) == 1  # home -3 wins by 4
    assert gf.outcome(rec(market="spreads", line=-4.0), 4) is None  # push
    assert gf.outcome(rec(market="totals", line=44.5), 44) == 0  # under
    assert gf.outcome(rec(market="h2h_h1", line=None), 0) is None  # tied half pushes
    assert gf.outcome(rec(kind="prop", market="player_anytime_td", line=None), 1.0) == 1


def test_clv():
    # Home -3 when it closed -3.5: half a point better than the close.
    assert gf.clv(rec(market="spreads", line=-3.0), "A", GAME) == pytest.approx(0.5)
    assert gf.clv(rec(market="spreads", line=-3.0), "B", GAME) == pytest.approx(-0.5)
    # Over 44.5 when it closed 45.5: a point better.
    assert gf.clv(rec(market="totals", line=44.5), "A", GAME) == pytest.approx(1.0)
    ml = gf.clv(rec(market="h2h", line=None, priceA=-150, priceB=130), "A", GAME)
    assert ml > 0  # -150 beats a -170 close
