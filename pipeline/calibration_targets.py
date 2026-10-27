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
Writes engine/test/fixtures/calibration/targets.json.
"""

import argparse

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
    }


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


def main() -> None:
    parser = argparse.ArgumentParser(description="Build calibration targets.")
    parser.add_argument("--seasons", type=int, nargs="+", required=True)
    parser.add_argument("--weeks", type=int, nargs="+", required=True)
    args = parser.parse_args()

    sched = read_raw("schedules", args.seasons)
    sched = sched[(sched["game_type"] == "REG") & sched["result"].notna()]
    pbp = read_raw("pbp", args.seasons, columns=[*PBP_COLUMNS, "touchdown"])
    pbp = pbp[pbp["season_type"] == "REG"]
    pbp["touchdown"] = pbp["touchdown"].fillna(0).astype(int)
    pbp = add_flags(pbp)
    events = event_targets(pbp)
    # Passing TDs only for the QB line.
    pbp["touchdown"] = np.where(pbp["is_complete"], pbp["touchdown"], 0)

    targets = {
        "seasons": args.seasons,
        "weeks": args.weeks,
        "game": game_targets(sched),
        "plays": play_targets(pbp),
        "starters": starter_targets(pbp),
        "events": events,
        "calibrationGames": calibration_games(sched, args.weeks),
    }
    write_json(OUT, targets)
    print(
        f"Wrote {OUT}: {targets['game']['games']} games, "
        f"{len(targets['calibrationGames'])} calibration games"
    )


if __name__ == "__main__":
    main()
