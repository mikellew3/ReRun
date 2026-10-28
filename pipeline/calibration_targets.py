"""Real-NFL calibration targets for engine/test/calibration.test.ts (CLAUDE.md §10.2).

Computed from regular-season games, with every stat defined the way the engine counts it:
- plays: dropbacks (attempts, sacks, scrambles) + designed runs + kneels + spikes
- attempt share: (attempts + spikes) / (attempts + spikes + designed runs + scrambles + kneels)
- yards per play: yards gained on those plays / plays
- starters per team-game: QB = most pass attempts, RB1 = most rush attempts among non-QBs,
  top target = most targets

Also lists the games in the calibration weeks with their closing lines, so the test can check
the sim's margins and totals against the market.

Usage:
  python calibration_targets.py --seasons 2023 2024 2025 --weeks 4 8 12 16
Writes engine/test/fixtures/calibration/targets.json and player_games.json.gz (actual player lines
in the calibration games).
"""

import argparse
import gzip
import json

import numpy as np
import pandas as pd

from common.io import PIPELINE_DIR, read_raw, write_json
from common.plays import PBP_COLUMNS, add_flags

OUT = PIPELINE_DIR.parent / "engine" / "test" / "fixtures" / "calibration" / "targets.json"


def summary(x: pd.Series) -> dict:
    x = x.astype(float)
    return {"mean": float(x.mean()), "sd": float(x.std()), "n": int(len(x))}


def game_targets(sched: pd.DataFrame) -> dict:
    margin = sched["result"].abs().astype(int)
    total = sched["total"].astype(float)
    return {
        "games": int(len(sched)),
        "absMarginShare": {str(k): float((margin == k).mean()) for k in range(0, 36)},
        "total": summary(total),
        "totalQuantiles": {str(q): float(total.quantile(q / 100)) for q in [10, 25, 50, 75, 90]},
        "homeMargin": summary(sched["result"]),
        "overtimeRate": float(sched["overtime"].mean()),
        "tieRate": float((sched["result"] == 0).mean()),
        "teamPoints": summary(pd.concat([sched["home_score"], sched["away_score"]])),
        # Real total minus closing total over all games: closing totals ran under real
        # scoring in 2023-2025, so a sim that matches real scoring sits above the line.
        "totalMinusLine": summary(total - sched["total_line"].astype(float)),
    }


def play_targets(pbp: pd.DataFrame) -> dict:
    p = pbp.copy()
    p["is_kneel"] = (p["play_type"] == "qb_kneel") | (p["qb_kneel"] & (p["play_type"] == "run"))
    p["is_spike"] = (p["play_type"] == "qb_spike") | p["qb_spike"]
    p["is_snap"] = p["is_dropback"] | p["is_designed_run"] | p["is_kneel"] | p["is_spike"]
    p["pass_like"] = p["is_attempt"] | p["is_spike"]
    p["rush_like"] = p["is_designed_run"] | p["is_scramble"] | p["is_kneel"]
    p["turnover"] = (p["is_int"] | (p["fumble_lost"] & p["is_snap"])).astype(int)
    snaps = p[p["is_snap"] & p["posteam"].notna()]

    team = snaps.groupby(["game_id", "posteam"]).agg(
        plays=("is_snap", "size"),
        passLike=("pass_like", "sum"),
        rushLike=("rush_like", "sum"),
        yards=("yards_gained", "sum"),
        turnovers=("turnover", "sum"),
        completions=("is_complete", "sum"),
        attempts=("is_attempt", "sum"),
        sacks=("is_sack", "sum"),
    )
    game = snaps.groupby("game_id").agg(plays=("is_snap", "size"), yards=("yards_gained", "sum"))
    return {
        "playsPerGame": summary(game["plays"]),
        "yardsPerPlay": float(game["yards"].sum() / game["plays"].sum()),
        "attemptShare": float(team["passLike"].sum() / (team["passLike"] + team["rushLike"]).sum()),
        "completionRate": float(team["completions"].sum() / team["attempts"].sum()),
        "turnoversPerTeamGame": float(team["turnovers"].mean()),
        "teamYards": summary(team["yards"]),
    }


def starter_targets(pbp: pd.DataFrame) -> dict:
    p = pbp.copy()
    keys = ["game_id", "posteam"]
    att = p[p["is_attempt"]]
    passing = att.groupby(keys + ["passer_id"]).agg(
        passAtt=("is_attempt", "size"),
        passYds=("yards_gained", lambda s: s[att.loc[s.index, "is_complete"]].sum()),
        passTd=("touchdown", "sum"),
    )
    qb = passing.sort_values("passAtt", ascending=False).groupby(level=[0, 1]).head(1)

    rush_rows = p[p["is_designed_run"] | p["is_scramble"]].copy()
    rush_rows["rusher"] = rush_rows["rusher_player_id"].fillna(rush_rows["passer_id"])
    rushing = rush_rows.groupby(keys + ["rusher"]).agg(
        rushAtt=("rusher", "size"), rushYds=("yards_gained", "sum")
    )
    qb_ids = set(qb.index.get_level_values(2))
    rb = rushing[~rushing.index.get_level_values(2).isin(qb_ids)]
    rb1 = rb.sort_values("rushAtt", ascending=False).groupby(level=[0, 1]).head(1)

    tg = att[att["receiver_player_id"].notna()].copy()
    tg["recYds"] = tg["yards_gained"].where(tg["is_complete"], 0.0)
    receiving = tg.groupby(keys + ["receiver_player_id"]).agg(
        targets=("is_attempt", "size"), rec=("is_complete", "sum"), recYds=("recYds", "sum")
    )
    top = (
        receiving.sort_values(["targets", "recYds"], ascending=False).groupby(level=[0, 1]).head(1)
    )
    return {
        "qb": {k: summary(qb[k]) for k in ["passAtt", "passYds", "passTd"]},
        "rb1": {k: summary(rb1[k]) for k in ["rushAtt", "rushYds"]},
        "topTarget": {k: summary(top[k]) for k in ["targets", "rec", "recYds"]},
    }


def event_targets(pbp: pd.DataFrame) -> dict:
    """Per-game event rates that pin down the decision tables."""
    p = pbp
    games = p["game_id"].nunique()
    fg = p[p["field_goal_attempt"]]
    fourth = p[(p["down"] == 4) & p["play_type"].isin(["pass", "run", "punt", "field_goal"])]
    third = p[(p["down"] == 3) & (p["is_dropback"] | p["is_designed_run"])]
    return {
        "touchdownsPerGame": float((p["touchdown"] == 1).sum() / games),
        "fieldGoalAttemptsPerGame": float(len(fg) / games),
        "fieldGoalRate": float((fg["field_goal_result"] == "made").mean()),
        "puntsPerGame": float((p["play_type"] == "punt").sum() / games),
        "twoPointTriesPerGame": float(p["two_point_attempt"].sum() / games),
        "fourthDownGoRate": float(fourth["play_type"].isin(["pass", "run"]).mean()),
        "thirdDownDistance": float(third["ydstogo"].mean()),
        "offensePenaltiesPerGame": float(penalties_on(p, "posteam") / games),
        "defensePenaltiesPerGame": float(penalties_on(p, "defteam") / games),
    }


def penalties_on(p: pd.DataFrame, side: str) -> int:
    """Accepted penalties with yardage on scrimmage snaps, committed by `side`."""
    pen = p[p["penalty"] & p["is_snap"] & (p["penalty_yards"].fillna(0) > 0)]
    return int((pen["penalty_team"] == pen[side]).sum())


LATE_BUCKETS = [
    (-99, -17, "trail17+"),
    (-16, -9, "trail9-16"),
    (-8, -1, "trail1-8"),
    (0, 0, "tied"),
    (1, 8, "lead1-8"),
    (9, 99, "lead9+"),
]


def late_drive_targets(pbp: pd.DataFrame) -> dict:
    """Points per drive for drives starting in the last 7 minutes of the 4th, by score state."""
    p = pbp[
        pbp["posteam"].notna() & (pbp["is_play"] | pbp["play_type"].isin(["punt", "field_goal"]))
    ]
    first = p.groupby(["game_id", "fixed_drive"]).first().reset_index()
    late = first[(first["qtr"] == 4) & (first["quarter_seconds_remaining"] <= 420)]
    pts = late["fixed_drive_result"].map({"Touchdown": 7, "Field goal": 3}).fillna(0)
    out = {}
    for lo, hi, name in LATE_BUCKETS:
        m = late["score_differential"].between(lo, hi)
        out[name] = {"mean": float(pts[m].mean()), "sd": float(pts[m].std()), "n": int(m.sum())}
    return out


def calibration_games(sched: pd.DataFrame, weeks: list[int]) -> list[dict]:
    g = sched[sched["week"].isin(weeks)]
    return [
        {
            "gameId": r.game_id,
            "spreadLine": float(r.spread_line),
            "totalLine": float(r.total_line),
            "result": float(r.result),
            "total": float(r.total),
        }
        for r in g.itertuples()
        if pd.notna(r.spread_line) and pd.notna(r.total_line)
    ]


SKILL = ["QB", "RB", "FB", "WR", "TE"]
BOX_FIELDS = [
    "passAtt", "passCmp", "passYds", "passTd", "passInt",
    "carries", "rushYds", "rushTd", "targets", "rec", "recYds", "recTd",
]  # fmt: skip


def player_games(pbp: pd.DataFrame, sched: pd.DataFrame, seasons: list[int]) -> dict:
    """Box scores for the calibration games, for player-level and prop checks
    (jobs/checkAdjustments.ts, jobs/checkProps.ts). Counted the way official box scores (and
    prop markets) count them, which is also how the engine counts them: rushing includes
    scrambles and kneels; passing yards exclude sacks. Every active skill player (weekly
    roster status ACT) is listed, with zeros if he recorded nothing, so "played but did
    nothing" is not confused with "did not play"."""
    games = sched.set_index("game_id")
    p = pbp[pbp["game_id"].isin(games.index) & ~pbp["two_point_attempt"]]
    att = p[p["is_attempt"]]
    runs = p[p["play_type"].isin(["run", "qb_kneel"]) & p["rusher_player_id"].notna()]
    comp = att[att["is_complete"]]
    parts = {
        "passAtt": att.groupby(["game_id", "passer_id"]).size(),
        "passCmp": comp.groupby(["game_id", "passer_id"]).size(),
        "passYds": comp.groupby(["game_id", "passer_id"])["yards_gained"].sum(),
        "passTd": comp[comp["offense_td"]].groupby(["game_id", "passer_id"]).size(),
        "passInt": att[att["is_int"]].groupby(["game_id", "passer_id"]).size(),
        "carries": runs.groupby(["game_id", "rusher_player_id"]).size(),
        "rushYds": runs.groupby(["game_id", "rusher_player_id"])["yards_gained"].sum(),
        "rushTd": runs[runs["offense_td"]].groupby(["game_id", "rusher_player_id"]).size(),
        "targets": att[att["receiver_player_id"].notna()]
        .groupby(["game_id", "receiver_player_id"])
        .size(),
        "rec": comp.groupby(["game_id", "receiver_player_id"]).size(),
        "recYds": comp.groupby(["game_id", "receiver_player_id"])["yards_gained"].sum(),
        "recTd": comp[comp["offense_td"]].groupby(["game_id", "receiver_player_id"]).size(),
    }
    for v in parts.values():
        v.index.names = ["game_id", "player_id"]
    box = pd.DataFrame(parts).fillna(0)

    rost = read_raw(
        "rosters_weekly",
        seasons,
        columns=["season", "week", "team", "gsis_id", "position", "status"],
    )
    rost = rost[(rost["status"] == "ACT") & rost["position"].isin(SKILL) & rost["gsis_id"].notna()]
    out: dict = {}
    for gid, g in games.iterrows():
        active = rost[
            (rost["season"] == g["season"])
            & (rost["week"] == g["week"])
            & rost["team"].isin([g["home_team"], g["away_team"]])
        ]["gsis_id"]
        ids = set(active) | set(box.loc[gid].index if gid in box.index.get_level_values(0) else [])
        lines = {}
        for pid in sorted(ids):
            row = box.loc[(gid, pid)] if (gid, pid) in box.index else None
            lines[pid] = {
                k: (round(float(row[k]), 1) if row is not None else 0.0) for k in BOX_FIELDS
            }
        out[gid] = lines
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Build calibration targets.")
    parser.add_argument("--seasons", type=int, nargs="+", required=True)
    parser.add_argument("--weeks", type=int, nargs="+", required=True)
    args = parser.parse_args()

    sched = read_raw("schedules", args.seasons)
    sched = sched[(sched["game_type"] == "REG") & sched["result"].notna()]
    extra = ["touchdown", "td_team", "score_differential", "quarter_seconds_remaining"]
    pbp = read_raw("pbp", args.seasons, columns=[*PBP_COLUMNS, *extra])
    pbp = pbp[pbp["season_type"] == "REG"]
    pbp["touchdown"] = pbp["touchdown"].fillna(0).astype(int)
    # Touchdowns scored by the offense (not fumble/interception returns), for box scores.
    pbp["offense_td"] = (pbp["touchdown"] == 1) & (pbp["td_team"] == pbp["posteam"])
    pbp = add_flags(pbp)
    events = event_targets(pbp)
    late_drives = late_drive_targets(pbp)
    # Passing TDs only for the QB line.
    pbp["touchdown"] = np.where(pbp["is_complete"], pbp["touchdown"], 0)

    targets = {
        "seasons": args.seasons,
        "weeks": args.weeks,
        "game": game_targets(sched),
        "plays": play_targets(pbp),
        "starters": starter_targets(pbp),
        "events": events,
        "lateDrivePoints": late_drives,
        "calibrationGames": calibration_games(sched, args.weeks),
    }
    write_json(OUT, targets)
    games = {g["gameId"] for g in targets["calibrationGames"]}
    in_set = sched[sched["game_id"].isin(games)]
    raw = json.dumps(player_games(pbp, in_set, args.seasons), separators=(",", ":")).encode()
    OUT.with_name("player_games.json.gz").write_bytes(gzip.compress(raw, 9, mtime=0))
    print(
        f"Wrote {OUT}: {targets['game']['games']} games, "
        f"{len(targets['calibrationGames'])} calibration games"
    )


if __name__ == "__main__":
    main()
