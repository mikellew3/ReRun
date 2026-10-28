from datetime import UTC, datetime, timedelta

import pytest

import fetch_lines as fl
import market_lines as ml

KICKOFF = "2026-10-30T00:15Z"


def sharp_row(book: str, side: str, line: float | None, price: int, **kw) -> dict:
    """A SharpAPI odds row in the shape the probe returned."""
    return {
        "sportsbook": book,
        "event_id": "nfl_packers_panthers_2026-10-29_b3",
        "home_team": "Green Bay Packers",
        "away_team": "Carolina Panthers",
        "selection_type": side,
        "selection": side,
        "odds_american": price,
        "line": line,
        "event_start_time": KICKOFF,
        "is_live": False,
        "is_active": True,
        "timestamp": "2026-10-28T14:13:53.342654915Z",
        "is_main_line": kw.get("main", True),
        "is_stale_pregame_price": False,
        "is_player_prop": False,
        "home": {"name": "Green Bay Packers", "abbreviation": "GB"},
        "away": {"name": "Carolina Panthers", "abbreviation": "CAR"},
    }


def test_sharpapi_rows_pair_into_one_quote_per_book():
    rows = [
        sharp_row("draftkings", "home", -3.5, -110),
        sharp_row("draftkings", "away", 3.5, -110),
        sharp_row("draftkings", "away", 8.5, -222, main=False),  # alternate line: ignored
        sharp_row("fanduel", "home", -3.0, -120),
        sharp_row("fanduel", "away", 3.0, 100),
    ]
    quotes = {q["book"]: q for q in fl.sharpapi_rows_to_quotes(rows, "spreads")}
    assert set(quotes) == {"draftkings", "fanduel"}
    dk = quotes["draftkings"]
    assert (dk["home"], dk["away"], dk["line"], dk["a"], dk["b"]) == ("GB", "CAR", -3.5, -110, -110)
    assert dk["game"] == "2026-10-30_CAR_GB"
    assert dk["kickoff"] == "2026-10-30T00:15:00Z"


def test_sharpapi_totals_use_over_under():
    rows = [
        sharp_row("draftkings", "over", 41.5, -105),
        sharp_row("draftkings", "under", 41.5, -115),
    ]
    (q,) = fl.sharpapi_rows_to_quotes(rows, "totals")
    assert (q["line"], q["a"], q["b"]) == (41.5, -105, -115)


def test_odds_api_pinnacle_parse():
    events = [
        {
            "home_team": "Green Bay Packers",
            "away_team": "Carolina Panthers",
            "commence_time": "2026-10-30T00:15:00Z",
            "bookmakers": [
                {
                    "key": "pinnacle",
                    "markets": [
                        {
                            "key": "spreads",
                            "last_update": "2026-10-28T14:18:07Z",
                            "outcomes": [
                                {"name": "Carolina Panthers", "price": -113, "point": 4.0},
                                {"name": "Green Bay Packers", "price": 101, "point": -4.0},
                            ],
                        }
                    ],
                }
            ],
        }
    ]
    (q,) = fl.odds_api_events_to_quotes(events, "pinnacle")
    assert (q["game"], q["line"], q["a"], q["b"]) == ("2026-10-30_CAR_GB", -4.0, 101, -113)


def quote(book: str, line: float, a: int, b: int, t: str) -> dict:
    return {
        "game": "2026-10-30_CAR_GB",
        "home": "GB",
        "away": "CAR",
        "kickoff": "2026-10-30T00:15:00Z",
        "book": book,
        "market": "spreads",
        "line": line,
        "a": a,
        "b": b,
        "t": t,
    }


def test_merge_keeps_only_changes_and_drops_old_games():
    now = datetime(2026, 10, 28, 15, tzinfo=UTC)
    h = {
        "games": {
            "2026-10-01_A_B": {
                "home": "B",
                "away": "A",
                "kickoff": "2026-10-01T17:00:00Z",
                "series": {},
            }
        }
    }
    assert fl.merge(h, [quote("draftkings", -3.5, -110, -110, "t1")], now) == 1
    assert fl.merge(h, [quote("draftkings", -3.5, -110, -110, "t2")], now) == 0
    assert fl.merge(h, [quote("draftkings", -4.0, -110, -110, "t3")], now) == 1
    ticks = h["games"]["2026-10-30_CAR_GB"]["series"]["draftkings|spreads"]
    assert [t["line"] for t in ticks] == [-3.5, -4.0]
    assert "2026-10-01_A_B" not in h["games"]


def test_pinnacle_due_only_at_configured_hours_and_not_twice():
    hour = fl.model_config()["oddsApi"]["sharpPullHoursUtc"][0]
    at = datetime(2026, 10, 28, hour, 5, tzinfo=UTC)
    assert fl.pinnacle_due({}, at)
    assert not fl.pinnacle_due({"oddsApi": {"calledAt": fl.iso(at - timedelta(minutes=30))}}, at)
    assert not fl.pinnacle_due({}, at.replace(hour=(hour + 1) % 24))


def test_no_vig():
    pa, pb = ml.no_vig(-110, -110)
    assert pa == pytest.approx(0.5)
    pa, pb = ml.no_vig(-150, 130)
    assert pa + pb == pytest.approx(1)
    assert pa > 0.5


def entry(series: dict) -> dict:
    return {"home": "GB", "away": "CAR", "kickoff": "2026-10-30T00:15:00Z", "series": series}


def test_market_lines_prefer_pinnacle_line_and_no_vig():
    e = entry(
        {
            "draftkings|spreads": [{"t": "1", "line": -3.5, "a": -110, "b": -110}],
            "fanduel|spreads": [{"t": "1", "line": -4.0, "a": -105, "b": -115}],
            "pinnacle|spreads": [{"t": "1", "line": -4.0, "a": 101, "b": -113}],
        }
    )
    lines = {(m["market"], m["selection"]): m for m in ml.market_lines(e)}
    home = lines[("spreads", "home")]
    assert home["line"] == -4.0
    assert lines[("spreads", "away")]["line"] == 4.0
    assert {p["book"] for p in home["prices"]} == {"fanduel", "pinnacle"}
    assert home["noVigSource"] == "pinnacle"
    assert home["best"]["book"] == "pinnacle"  # +101 beats -105
    assert home["noVigProb"] + lines[("spreads", "away")]["noVigProb"] == pytest.approx(1, abs=1e-3)


def test_market_lines_consensus_without_pinnacle():
    e = entry(
        {
            "draftkings|totals": [{"t": "1", "line": 41.5, "a": -110, "b": -110}],
            "fanduel|totals": [{"t": "1", "line": 41.5, "a": -105, "b": -115}],
        }
    )
    over = next(m for m in ml.market_lines(e) if m["selection"] == "over")
    assert over["noVigSource"] == "consensus"
    assert over["line"] == 41.5


def test_attach_lines_matches_by_teams_and_kickoff():
    games = [{"home": "GB", "away": "CAR", "kickoff": "2026-10-30T00:15:00Z", "market": []}]
    history = {
        "games": {"x": entry({"draftkings|h2h": [{"t": "1", "line": None, "a": -200, "b": 170}]})}
    }
    assert ml.attach_lines(games, history) == 1
    assert games[0]["lineHistory"][0]["book"] == "draftkings"
    assert {m["selection"] for m in games[0]["market"]} == {"home", "away"}
