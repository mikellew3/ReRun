"""Builds the versioned slate snapshot the engine loads (SlateSnapshot in engine/src/types.ts).

Step-2 version: market lines, market-implied usage and weather are left empty (step 6).

Reads data/fits/{season}-W{week}/ (league_base.json, teams.json, players.json) plus raw
schedules, rosters, injuries and depth charts, and writes data/snapshots/{id}.json, e.g.
2026-W08-v1.json. Each run publishes a new version; old versions are kept.

Usage:
  python build_snapshot.py --season 2026 --week 8
  python build_snapshot.py --season 2026 --week 8 --as-of 2026-10-29T12:00:00Z

Without --as-of the snapshot represents now, or, for a slate already played, 90 minutes before
its first kickoff.
"""

import argparse
import gzip
import json
import math
import re
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd

from common.config import config_hash, history_windows, model_config
from common.io import (
    SNAPSHOTS_DIR,
    STADIUMS_CSV,
    fits_dir,
    read_json,
    read_manifest,
    read_raw,
    round_floats,
    write_json,
)

SKILL_POSITIONS = ["QB", "RB", "FB", "WR", "TE", "K", "P"]
DEPTH_POS_MAP = {"QB": "QB", "RB": "RB", "FB": "FB", "WR": "WR", "TE": "TE", "PK": "K", "P": "P"}
OL_POSITIONS = {"LT", "LG", "C", "RG", "RT"}
SECONDARY_POSITIONS = {"LCB", "RCB", "CB", "NB", "SS", "FS", "S"}
REPORT_STATUS = {"Out": "out", "Doubtful": "doubtful", "Questionable": "questionable"}
UNIT_FIELDS = [
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
]
DVP_BUCKETS = ["WR1", "WR2", "WR3", "TE", "RB"]
EASTERN = ZoneInfo("America/New_York")


# ---------------------------------------------------------------------------
# Stadiums and travel
# ---------------------------------------------------------------------------


class Stadiums:
    """Lookup over stadiums.csv. nflverse sometimes files an international game under the
    home team's stadium id, so a name/alias match wins over an id match."""

    def __init__(self) -> None:
        df = pd.read_csv(STADIUMS_CSV, dtype=str, keep_default_na=False)
        self.rows = df.to_dict("records")
        self.by_name: dict[str, dict] = {}
        self.by_id: dict[str, dict] = {}
        self.home_of: dict[str, dict] = {}
        for row in self.rows:
            for name in [row["name"], *row["aliases"].split("|")]:
                if name:
                    self.by_name.setdefault(name.lower(), row)
            self.by_id.setdefault(row["stadium_id"], row)
            for team in filter(None, row["teams"].split("|")):
                self.home_of[team] = row

    def find(self, name: str | None, stadium_id: str | None) -> dict:
        row = self.by_name.get((name or "").lower()) or self.by_id.get(stadium_id or "")
        if row is None:
            raise KeyError(f"Stadium not in stadiums.csv: {name!r} ({stadium_id}). Add a row.")
        return row

    @staticmethod
    def facts(row: dict) -> dict:
        return {
            "stadiumId": row["stadium_id"],
            "name": row["name"],
            "lat": float(row["lat"]),
            "lon": float(row["lon"]),
            "roof": row["roof"],
            "surface": row["surface"],
            "altitudeFt": int(row["altitude_ft"]),
            "tz": row["tz"],
        }


def haversine_miles(a: dict, b: dict) -> float:
    lat1, lon1, lat2, lon2 = map(
        math.radians, [float(a["lat"]), float(a["lon"]), float(b["lat"]), float(b["lon"])]
    )
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * 3958.8 * math.asin(math.sqrt(h))


def tz_shift_hours(from_tz: str, to_tz: str, at: datetime) -> float:
    """Hours the away team's body clock shifts: game-site UTC offset minus home UTC offset."""
    to_off = at.astimezone(ZoneInfo(to_tz)).utcoffset()
    from_off = at.astimezone(ZoneInfo(from_tz)).utcoffset()
    return (to_off - from_off).total_seconds() / 3600


def kickoff_utc(gameday: str, gametime: str) -> datetime:
    local = datetime.strptime(f"{gameday} {gametime}", "%Y-%m-%d %H:%M").replace(tzinfo=EASTERN)
    return local.astimezone(UTC)


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Rosters, injuries, depth charts
# ---------------------------------------------------------------------------


def slate_rosters(season: int, week: int, teams: set[str]) -> pd.DataFrame:
    """Latest weekly roster at or before the slate week, per team. All positions."""
    r = read_raw("rosters_weekly", [season])
    r = r[(r["week"] <= week) & r["team"].isin(teams)]
    latest = r.groupby("team")["week"].transform("max")
    return r[r["week"] == latest].drop_duplicates("gsis_id")


def injury_reports(season: int, week: int) -> dict[str, str]:
    try:
        inj = read_raw("injuries", [season])
    except FileNotFoundError:
        return {}
    inj = inj[(inj["week"] == week) & inj["report_status"].notna()]
    return dict(zip(inj["gsis_id"], inj["report_status"], strict=True))


def player_status(roster_status: str, report_status: str | None) -> str:
    if roster_status == "INA":
        return "inactive"
    if roster_status == "RES":
        return "ir"
    return REPORT_STATUS.get(report_status or "", "active")


def latest_depth_charts(season: int, as_of: datetime) -> pd.DataFrame | None:
    """Latest ESPN-format depth chart per team at or before as_of. None for old formats."""
    try:
        d = read_raw("depth_charts", [season])
    except FileNotFoundError:
        return None
    if "pos_abb" not in d.columns:
        return None
    d = d[d["dt"] <= iso(as_of)]
    if d.empty:
        return None
    latest = d.groupby("team")["dt"].transform("max")
    return d[d["dt"] == latest]


def depth_order(depth: pd.DataFrame | None, team: str, positions: set[str]) -> dict[str, list[str]]:
    """Ordered player ids per depth-chart position abbreviation, starter first."""
    if depth is None:
        return {}
    d = depth[(depth["team"] == team) & depth["pos_abb"].isin(positions) & depth["gsis_id"].notna()]
    d = d.sort_values(["pos_abb", "pos_rank", "pos_slot"])
    return {pos: list(dict.fromkeys(g["gsis_id"])) for pos, g in d.groupby("pos_abb")}


# ---------------------------------------------------------------------------
# Snapshot pieces
# ---------------------------------------------------------------------------


def league_block(base: dict, teams_fit: dict) -> dict:
    """LeagueParams per window: shared histograms/grid/special teams plus team averages."""
    out = {}
    all_teams = teams_fit["teams"].values()
    for window in history_windows():
        offs = [t["params"][window]["off"] for t in all_teams]
        rates = {f: sum(o[f] for o in offs) / len(offs) for f in UNIT_FIELDS}
        dvp = {}
        for b in DVP_BUCKETS:
            lines = [t["dvp"][window][b] for t in all_teams if t["dvp"].get(window)]
            tpg = sum(x["targetsPerGame"] for x in lines)
            dvp[b] = {
                "targetsPerGame": tpg / len(lines),
                "yardsPerTarget": sum(x["targetsPerGame"] * x["yardsPerTarget"] for x in lines)
                / tpg,
                "n": sum(x["n"] for x in lines),
            }
        out[window] = {
            **base["histograms"],
            "rates": rates,
            "passRateByDownDist": base["passRateByDownDist"],
            "dvp": dvp,
            "specialTeams": base["specialTeams"],
        }
    return out


def starters_out(
    depth: pd.DataFrame | None, team: str, positions: set[str], status_of: dict[str, str]
) -> int:
    """Depth-chart starters at these positions who are unlikely to play."""
    cfg = model_config()
    play_prob = cfg["injuries"]["playProbByStatus"]
    threshold = cfg["fitting"]["starterOutPlayProb"]
    starters = {ids[0] for ids in depth_order(depth, team, positions).values() if ids}
    return sum(play_prob[status_of.get(pid, "active")] < threshold for pid in starters)


def qb_replacement_deltas(qbs: list[str], qb_aux: dict, replacement_epa: float) -> dict[str, float]:
    """For each QB in depth order: his EPA/dropback minus the next QB's (season window).
    QBs without data, and the slot below the last QB, use the replacement-level prior."""

    def epa(pid: str) -> float:
        return qb_aux.get(pid, {}).get("qbEpaPerDropback", {}).get("season", replacement_epa)

    return {
        pid: epa(pid) - (epa(qbs[i + 1]) if i + 1 < len(qbs) else replacement_epa)
        for i, pid in enumerate(qbs)
    }


def season_value(params: dict, field: str) -> float:
    p = params.get("season") or next(iter(params.values()), {})
    return float(p.get(field, 0.0))


def build_players_and_teams(
    season: int,
    week: int,
    as_of: datetime,
    slate_teams: set[str],
    teams_fit: dict,
    players_fit: dict,
) -> tuple[dict, dict]:
    cfg = model_config()
    play_prob = cfg["injuries"]["playProbByStatus"]
    windows = history_windows()

    rosters = slate_rosters(season, week, slate_teams)
    reports = injury_reports(season, week)
    depth = latest_depth_charts(season, as_of)
    status_of = {
        pid: player_status(rs, reports.get(pid))
        for pid, rs in zip(rosters["gsis_id"], rosters["status"], strict=True)
    }

    skill = rosters[
        rosters["position"].isin(SKILL_POSITIONS) & rosters["status"].isin(["ACT", "INA"])
    ]
    params_all = players_fit["params"]
    league_qb_epa = players_fit["priors"]["qb"]["epaPerDropback"]
    replacement_qb_epa = league_qb_epa + cfg["injuries"]["qbReplacementEpaPerDropback"]

    players: dict = {}
    teams: dict = {}
    for team in sorted(slate_teams):
        roster = skill[skill["team"] == team]
        ids_by_pos: dict[str, list[str]] = {}
        for pos, g in roster.groupby("position"):
            ids_by_pos[pos] = list(g["gsis_id"])

        # Depth chart: ESPN order where available, then anyone left by snap share.
        espn = depth_order(depth, team, set(DEPTH_POS_MAP))
        depth_chart: dict[str, list[str]] = {}
        for pos in SKILL_POSITIONS:
            on_roster = ids_by_pos.get(pos, [])
            espn_ids = [
                pid for abb, ids in espn.items() if DEPTH_POS_MAP[abb] == pos for pid in ids
            ]
            ordered = [pid for pid in dict.fromkeys(espn_ids) if pid in on_roster]
            rest = sorted(
                (pid for pid in on_roster if pid not in ordered),
                key=lambda pid: -season_value(params_all.get(pid, {}), "snapShare"),
            )
            if ordered or rest:
                depth_chart[pos] = ordered + rest

        # Defense-vs-position bucket by target share.
        wrs = sorted(
            ids_by_pos.get("WR", []),
            key=lambda pid: -season_value(params_all.get(pid, {}), "targetShare"),
        )
        bucket = {
            pid: ("WR1" if i == 0 else "WR2" if i == 1 else "WR3") for i, pid in enumerate(wrs)
        }
        bucket.update({pid: "TE" for pid in ids_by_pos.get("TE", [])})
        bucket.update({pid: "RB" for pid in ids_by_pos.get("RB", []) + ids_by_pos.get("FB", [])})

        qb_deltas = qb_replacement_deltas(
            depth_chart.get("QB", []), players_fit["aux"], replacement_qb_epa
        )

        for _, row in roster.iterrows():
            pid, pos = row["gsis_id"], row["position"]
            status = status_of[pid]
            order = depth_chart.get(pos, [])
            players[pid] = {
                "playerId": pid,
                "name": row["full_name"],
                "team": team,
                "position": pos,
                "depth": order.index(pid) + 1 if pid in order else len(order) + 1,
                "dvpBucket": bucket.get(pid),
                "status": status,
                "playProb": play_prob[status],
                "params": {w: p for w, p in params_all.get(pid, {}).items() if w in windows},
                "replacementDelta": qb_deltas.get(pid),
            }

        fit = teams_fit["teams"][team]
        teams[team] = {
            "team": team,
            "params": fit["params"],
            "dvp": fit["dvp"],
            "depthChart": depth_chart,
            "olInjuryCount": starters_out(depth, team, OL_POSITIONS, status_of),
            "secondaryInjuryCount": starters_out(depth, team, SECONDARY_POSITIONS, status_of),
            "form": fit["form"],
        }
    return players, teams


def build_games(slate: pd.DataFrame, as_of: datetime, stadiums: Stadiums) -> list[dict]:
    games = []
    for _, g in slate.sort_values(["gameday", "gametime", "game_id"]).iterrows():
        kickoff = kickoff_utc(g["gameday"], g["gametime"])
        # Status is relative to as_of, so historical (backtest) snapshots don't leak results.
        if kickoff > as_of:
            status = "scheduled"
        elif pd.notna(g["result"]):
            status = "final"
        else:
            status = "in_progress"
        site = stadiums.find(g["stadium"], g["stadium_id"])
        away_home = stadiums.home_of.get(g["away_team"], site)
        games.append(
            {
                "gameId": g["game_id"],
                "kickoff": iso(kickoff),
                "home": g["home_team"],
                "away": g["away_team"],
                "status": status,
                "neutralSite": g["location"] == "Neutral",
                "stadium": Stadiums.facts(site),
                "weather": None,
                "context": {
                    "restDays": {"home": int(g["home_rest"]), "away": int(g["away_rest"])},
                    "awayTravelMiles": haversine_miles(away_home, site),
                    "awayTzShift": tz_shift_hours(away_home["tz"], site["tz"], kickoff),
                },
                "market": [],
                "marketUsage": {},
            }
        )
    return games


def next_version(season: int, week: int) -> int:
    pattern = re.compile(rf"^{season}-W{week:02d}-v(\d+)\.json$")
    found = [int(m.group(1)) for p in SNAPSHOTS_DIR.glob("*.json") if (m := pattern.match(p.name))]
    return max(found, default=0) + 1


def build_snapshot(season: int, week: int, as_of: datetime, version: int) -> dict:
    fdir = fits_dir(season, week)
    base = read_json(fdir / "league_base.json")
    teams_fit = read_json(fdir / "teams.json")
    players_fit = read_json(fdir / "players.json")

    schedules = read_raw("schedules", [season])
    slate = schedules[schedules["week"] == week]
    if slate.empty:
        raise ValueError(f"No games in {season} week {week}")
    slate_teams = set(slate["home_team"]) | set(slate["away_team"])

    players, teams = build_players_and_teams(
        season, week, as_of, slate_teams, teams_fit, players_fit
    )
    manifest = read_manifest()
    nflverse_as_of = manifest.get(f"pbp_{season}", iso(as_of))

    snapshot = {
        "schemaVersion": 1,
        "id": f"{season}-W{week:02d}-v{version}",
        "season": season,
        "week": week,
        "seasonType": "REG" if (slate["game_type"] == "REG").all() else "POST",
        "version": version,
        "createdAt": iso(as_of),
        "configHash": config_hash(),
        "dataAsOf": {
            "nflverse": nflverse_as_of,
            "injuries": manifest.get(f"injuries_{season}", nflverse_as_of),
            "odds": None,
            "weather": None,
        },
        "league": league_block(base, teams_fit),
        "teams": teams,
        "players": players,
        "games": build_games(slate, as_of, Stadiums()),
    }
    return round_floats(snapshot, model_config()["fitting"]["snapshotDecimals"])


def default_as_of(season: int, week: int) -> datetime:
    """Now, or for a past slate 90 minutes before its first kickoff (so no results leak in)."""
    slate = read_raw("schedules", [season])
    slate = slate[slate["week"] == week]
    first = min(kickoff_utc(d, t) for d, t in zip(slate["gameday"], slate["gametime"], strict=True))
    return min(datetime.now(UTC), first - timedelta(minutes=90))


def write_snapshot(snapshot: dict) -> str:
    """Writes the snapshot and returns a one-line summary."""
    path = SNAPSHOTS_DIR / f"{snapshot['id']}.json"
    write_json(path, snapshot, compact=True)
    raw = path.read_bytes()
    json.loads(raw)  # sanity: valid JSON
    gz = len(gzip.compress(raw, 9))
    return (
        f"Wrote {path}: {len(snapshot['games'])} games, {len(snapshot['teams'])} teams, "
        f"{len(snapshot['players'])} players, "
        f"{len(raw) / 1024:.0f} KB raw, {gz / 1024:.0f} KB gzipped"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a slate snapshot.")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=int, required=True)
    parser.add_argument(
        "--as-of", help="ISO time the snapshot represents (default: now, or pre-kickoff if past)"
    )
    parser.add_argument("--version", type=int, help="default: next unused version")
    args = parser.parse_args()

    as_of = (
        datetime.fromisoformat(args.as_of.replace("Z", "+00:00"))
        if args.as_of
        else default_as_of(args.season, args.week)
    )
    version = args.version or next_version(args.season, args.week)
    print(write_snapshot(build_snapshot(args.season, args.week, as_of, version)))


if __name__ == "__main__":
    main()
