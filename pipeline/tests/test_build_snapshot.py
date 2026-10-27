import json
from datetime import UTC, datetime

import pandas as pd
import pytest

from build_snapshot import (
    Stadiums,
    build_games,
    haversine_miles,
    kickoff_utc,
    player_status,
    qb_replacement_deltas,
    tz_shift_hours,
)
from common.io import SNAPSHOTS_DIR


def test_stadium_name_beats_id():
    s = Stadiums()
    # nflverse files some London games under the home team's id
    assert s.find("Tottenham Hotspur Stadium", "JAX00")["stadium_id"] == "LON02"
    assert s.find("Some Old Name", "KAN00")["name"] == "GEHA Field at Arrowhead Stadium"
    assert s.find("TIAA Bank Stadium", None)["stadium_id"] == "JAX00"
    with pytest.raises(KeyError):
        s.find("Nowhere", "XXX00")


def test_every_team_has_one_home_stadium():
    s = Stadiums()
    assert len(s.home_of) == 32


def test_stadium_rows_are_valid():
    for row in Stadiums().rows:
        assert row["roof"] in {"outdoors", "dome", "retractable"}, row["name"]
        assert row["surface"] in {"grass", "turf"}, row["name"]
        assert -90 <= float(row["lat"]) <= 90 and -180 <= float(row["lon"]) <= 180


def test_haversine_new_york_to_los_angeles():
    s = Stadiums()
    miles = haversine_miles(s.by_id["NYC01"], s.by_id["LAX01"])
    assert 2400 < miles < 2500


def test_kickoff_is_eastern_time_with_dst():
    assert kickoff_utc("2026-10-25", "13:00") == datetime(2026, 10, 25, 17, 0, tzinfo=UTC)
    assert kickoff_utc("2026-11-08", "13:00") == datetime(2026, 11, 8, 18, 0, tzinfo=UTC)


def test_tz_shift():
    at = datetime(2026, 11, 1, 18, 0, tzinfo=UTC)
    assert tz_shift_hours("America/Los_Angeles", "America/New_York", at) == 3
    assert tz_shift_hours("America/New_York", "Europe/London", at) == 5


def test_player_status_priority():
    assert player_status("INA", "Questionable") == "inactive"
    assert player_status("RES", None) == "ir"
    assert player_status("ACT", "Doubtful") == "doubtful"
    assert player_status("ACT", None) == "active"


def test_qb_replacement_deltas():
    aux = {
        "QB1": {"qbEpaPerDropback": {"season": 0.20}},
        "QB2": {"qbEpaPerDropback": {"season": 0.0}},
    }
    d = qb_replacement_deltas(["QB1", "QB2", "QB3"], aux, replacement_epa=-0.1)
    assert d["QB1"] == pytest.approx(0.20)
    assert d["QB2"] == pytest.approx(0.10)  # vs QB3, who has no data -> replacement
    assert d["QB3"] == pytest.approx(0.0)


def test_game_status_is_relative_to_as_of():
    slate = pd.DataFrame(
        [
            {
                "game_id": "2024_10_X_KC",
                "gameday": "2024-11-10",
                "gametime": "13:00",
                "home_team": "KC",
                "away_team": "DEN",
                "result": 2.0,
                "stadium": "GEHA Field at Arrowhead Stadium",
                "stadium_id": "KAN00",
                "location": "Home",
                "home_rest": 7,
                "away_rest": 7,
            }
        ]
    )
    before = build_games(slate, datetime(2024, 11, 9, tzinfo=UTC), Stadiums())
    after = build_games(slate, datetime(2024, 11, 11, tzinfo=UTC), Stadiums())
    assert before[0]["status"] == "scheduled"
    assert after[0]["status"] == "final"


# Field names of the TypeScript types in engine/src/types.ts. Keep in sync.
SNAPSHOT_KEYS = {
    "schemaVersion",
    "id",
    "season",
    "week",
    "seasonType",
    "version",
    "createdAt",
    "configHash",
    "dataAsOf",
    "league",
    "teams",
    "players",
    "games",
}
LEAGUE_KEYS = {
    "completionYds",
    "runYds",
    "scrambleYds",
    "sackYds",
    "puntNetYds",
    "kickoffStartYardline",
    "rates",
    "passRateByDownDist",
    "dvp",
    "specialTeams",
}
TEAM_KEYS = {"team", "params", "dvp", "depthChart", "olInjuryCount", "secondaryInjuryCount", "form"}
TEAM_PARAMS_KEYS = {
    "team",
    "window",
    "games",
    "off",
    "def",
    "proe",
    "neutralSecPerPlay",
    "noHuddleRate",
}
UNIT_KEYS = {
    "passEpa",
    "runEpa",
    "passSuccess",
    "runSuccess",
    "sackRate",
    "scrambleRate",
    "intRate",
    "completionRate",
    "passYdsTilt",
    "explosivePassRate",
    "runYdsTilt",
    "explosiveRunRate",
    "fumbleLostRate",
    "redZoneTdRate",
    "penaltyYdsPerPlay",
}
PLAYER_KEYS = {
    "playerId",
    "name",
    "team",
    "position",
    "depth",
    "dvpBucket",
    "status",
    "playProb",
    "params",
    "replacementDelta",
}
PLAYER_PARAMS_REQUIRED = {
    "playerId",
    "window",
    "games",
    "snapShare",
    "routeShare",
    "targetShare",
    "airYardsShare",
    "carryShare",
    "rzTargetShare",
    "rzCarryShare",
    "glCarryShare",
    "catchRate",
    "yardsPerTarget",
    "recYdsTilt",
    "yardsPerCarry",
    "rushYdsTilt",
}
GAME_KEYS = {
    "gameId",
    "kickoff",
    "home",
    "away",
    "status",
    "neutralSite",
    "stadium",
    "weather",
    "context",
    "market",
    "marketUsage",
}
WINDOWS = {"season", "L3", "L4", "L5", "L6", "L7", "L8"}


def latest_snapshot():
    files = sorted(SNAPSHOTS_DIR.glob("*.json")) if SNAPSHOTS_DIR.exists() else []
    if not files:
        pytest.skip("no snapshot built locally")
    return json.loads(files[-1].read_text())


def test_snapshot_matches_typescript_types():
    s = latest_snapshot()
    assert set(s) == SNAPSHOT_KEYS
    assert set(s["league"]) == WINDOWS
    for league in s["league"].values():
        assert set(league) == LEAGUE_KEYS
        assert set(league["rates"]) == UNIT_KEYS
    for team in s["teams"].values():
        assert set(team) == TEAM_KEYS
        assert set(team["params"]) == WINDOWS
        for p in team["params"].values():
            assert set(p) == TEAM_PARAMS_KEYS
            assert set(p["off"]) == UNIT_KEYS and set(p["def"]) == UNIT_KEYS
    for player in s["players"].values():
        assert set(player) == PLAYER_KEYS
        for p in player["params"].values():
            assert PLAYER_PARAMS_REQUIRED <= set(p) <= PLAYER_PARAMS_REQUIRED | {"qb", "kicker"}
    for game in s["games"]:
        assert set(game) == GAME_KEYS
        assert game["home"] in s["teams"] and game["away"] in s["teams"]
