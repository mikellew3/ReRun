"""Player parameters per history window: usage shares, efficiency, QB and kicker blocks.

- Shares (targets, air yards, carries, red-zone, goal-line) are the player's share of his
  team's volume in the games he played, recency-weighted. Not shrunk: they describe role.
- Efficiency (catch rate, yards per target/carry, QB rates, kicker accuracy) is shrunk toward
  the league average for the position: (n * observed + k * league) / (n + k), k in config.
- routeShare uses snap share as a proxy: free nflverse data has no route counts.

Writes data/fits/{season}-W{week}/players.json:
  {"params": {playerId: {window: PlayerParams}}, "aux": {playerId: {...}}}
"aux" holds numbers the snapshot builder needs but the engine does not (QB EPA/dropback).

Usage: python fit_player_params.py --season 2026 --week 8
"""

import argparse

import pandas as pd

from common.config import history_windows, model_config
from common.io import fits_dir, read_json, read_raw, write_json
from common.plays import before_slate, fg_make_prob, load_pbp
from common.stats import shrink
from common.weights import window_weights
from fit_team_params import tilt_for

SHARE_STATS = {
    # PlayerParams field: (player column, team column)
    "targetShare": ("targets", "team_targets"),
    "airYardsShare": ("air_yds", "team_air_yds"),
    "carryShare": ("carries", "team_carries"),
    "rzTargetShare": ("rz_targets", "team_rz_targets"),
    "rzCarryShare": ("rz_carries", "team_rz_carries"),
    "glCarryShare": ("gl_carries", "team_gl_carries"),
}

COUNT_COLUMNS = [
    "targets",
    "receptions",
    "rec_yds",
    "air_yds",
    "rz_targets",
    "carries",
    "rush_yds",
    "rz_carries",
    "gl_carries",
    "dropbacks",
    "pass_att",
    "completions",
    "pass_yds",
    "ints",
    "sacks",
    "scrambles",
    "qb_epa",
    "fg_att",
    "fg_made",
    "fg_expected",
    "xp_att",
    "xp_made",
]


# ---------------------------------------------------------------------------
# Per player-game table
# ---------------------------------------------------------------------------


def _count(df: pd.DataFrame, player_col: str, **aggs) -> pd.DataFrame:
    return (
        df[df[player_col].notna()]
        .groupby(["game_id", "posteam", player_col])
        .agg(**aggs)
        .reset_index()
        .rename(columns={player_col: "player_id", "posteam": "team"})
    )


def player_games(plays: pd.DataFrame) -> pd.DataFrame:
    """One row per (game, team, player) with counting stats and team volume."""
    p = plays.copy()
    p["air"] = p["air_yards"].fillna(0.0)
    p["rec_yds_play"] = p["yards_gained"].where(p["is_complete"], 0.0)

    tg = p[p["is_attempt"]]
    receiving = _count(
        tg,
        "receiver_player_id",
        targets=("is_attempt", "size"),
        receptions=("is_complete", "sum"),
        rec_yds=("rec_yds_play", "sum"),
        air_yds=("air", "sum"),
        rz_targets=("in_red_zone", "sum"),
    )
    runs = p[p["is_designed_run"]]
    rushing = _count(
        runs,
        "rusher_player_id",
        carries=("is_designed_run", "size"),
        rush_yds=("yards_gained", "sum"),
        rz_carries=("in_red_zone", "sum"),
        gl_carries=("at_goal_line", "sum"),
    )
    db = p[p["is_dropback"]].copy()
    db["comp_yds"] = db["yards_gained"].where(db["is_complete"], 0.0)
    passing = _count(
        db,
        "passer_id",
        dropbacks=("is_dropback", "size"),
        pass_att=("is_attempt", "sum"),
        completions=("is_complete", "sum"),
        pass_yds=("comp_yds", "sum"),
        ints=("is_int", "sum"),
        sacks=("is_sack", "sum"),
        scrambles=("is_scramble", "sum"),
        qb_epa=("epa", "sum"),
    )
    fg = p[p["field_goal_attempt"] & p["kick_distance"].notna()].copy()
    fg["made"] = fg["field_goal_result"] == "made"
    fg["expected"] = fg_make_prob(fg["kick_distance"])
    kicking = _count(
        fg,
        "kicker_player_id",
        fg_att=("made", "size"),
        fg_made=("made", "sum"),
        fg_expected=("expected", "sum"),
    )
    xp = p[p["extra_point_attempt"]].copy()
    xp["good"] = xp["extra_point_result"] == "good"
    extra = _count(xp, "kicker_player_id", xp_att=("good", "size"), xp_made=("good", "sum"))

    keys = ["game_id", "team", "player_id"]
    games = receiving
    for part in [rushing, passing, kicking, extra]:
        games = games.merge(part, on=keys, how="outer")
    games[COUNT_COLUMNS] = games[COUNT_COLUMNS].fillna(0.0)

    team = (
        p.groupby(["game_id", "posteam"])
        .agg(
            team_targets=("is_attempt", "sum"),
            team_carries=("is_designed_run", "sum"),
        )
        .join(
            tg.groupby(["game_id", "posteam"]).agg(
                team_air_yds=("air", "sum"), team_rz_targets=("in_red_zone", "sum")
            )
        )
        .join(
            runs.groupby(["game_id", "posteam"]).agg(
                team_rz_carries=("in_red_zone", "sum"), team_gl_carries=("at_goal_line", "sum")
            )
        )
        .fillna(0.0)
        .reset_index()
        .rename(columns={"posteam": "team"})
    )
    games = games.merge(team, on=["game_id", "team"], how="left")
    meta = p.drop_duplicates("game_id").set_index("game_id")[["season", "week"]]
    return games.join(meta, on="game_id")


def add_snaps(games: pd.DataFrame, season: int, week: int, rosters: pd.DataFrame) -> pd.DataFrame:
    """Adds offense snap share and adds rows for players who played snaps but had no touches."""
    snaps = before_slate(
        read_raw(
            "snap_counts",
            [season - 1, season],
            columns=[
                "game_id",
                "season",
                "week",
                "pfr_player_id",
                "team",
                "offense_snaps",
                "offense_pct",
            ],
        ),
        season,
        week,
    )
    pfr_to_gsis = (
        rosters.dropna(subset=["pfr_id", "gsis_id"])
        .drop_duplicates("pfr_id")
        .set_index("pfr_id")["gsis_id"]
    )
    snaps = snaps.assign(player_id=snaps["pfr_player_id"].map(pfr_to_gsis))
    snaps = snaps[snaps["player_id"].notna() & (snaps["offense_snaps"] > 0)]
    snaps = snaps[["game_id", "season", "week", "team", "player_id", "offense_pct"]]

    merged = games.merge(snaps, on=["game_id", "player_id"], how="outer", suffixes=("", "_snap"))
    for col in ["team", "season", "week"]:
        merged[col] = merged[col].fillna(merged[f"{col}_snap"])
    merged = merged.drop(columns=["team_snap", "season_snap", "week_snap"])
    merged[COUNT_COLUMNS] = merged[COUNT_COLUMNS].fillna(0.0)
    # Team volume for snap-only rows comes from any teammate's row in that game.
    team_cols = [c for c in merged.columns if c.startswith("team_")]
    merged[team_cols] = merged.groupby(["game_id", "team"])[team_cols].transform("max")
    merged[["season", "week"]] = merged[["season", "week"]].astype(int)
    return merged


# ---------------------------------------------------------------------------
# League priors for shrinkage
# ---------------------------------------------------------------------------


def league_priors(games: pd.DataFrame, positions: pd.Series) -> dict:
    g = games.assign(position=games["player_id"].map(positions))
    priors: dict = {"byPosition": {}}
    for pos, d in g.groupby("position"):
        t, r, c = d["targets"].sum(), d["receptions"].sum(), d["carries"].sum()
        priors["byPosition"][pos] = {
            "catchRate": r / t if t else None,
            "yardsPerTarget": d["rec_yds"].sum() / t if t else None,
            "yardsPerReception": d["rec_yds"].sum() / r if r else None,
            "yardsPerCarry": d["rush_yds"].sum() / c if c else None,
        }
    t, r, c = g["targets"].sum(), g["receptions"].sum(), g["carries"].sum()
    priors["all"] = {
        "catchRate": r / t,
        "yardsPerTarget": g["rec_yds"].sum() / t,
        "yardsPerReception": g["rec_yds"].sum() / r,
        "yardsPerCarry": g["rush_yds"].sum() / c,
    }
    qb = g[g["dropbacks"] > 0]
    att, db, comp = qb["pass_att"].sum(), qb["dropbacks"].sum(), qb["completions"].sum()
    priors["qb"] = {
        "completionRate": comp / att,
        "yardsPerAttempt": qb["pass_yds"].sum() / att,
        "yardsPerCompletion": qb["pass_yds"].sum() / comp,
        "sackRate": qb["sacks"].sum() / db,
        "intRate": qb["ints"].sum() / att,
        "scrambleRate": qb["scrambles"].sum() / db,
        "epaPerDropback": qb["qb_epa"].sum() / db,
    }
    return priors


def position_prior(priors: dict, position: str, stat: str) -> float:
    value = priors["byPosition"].get(position, {}).get(stat)
    return priors["all"][stat] if value is None else value


# ---------------------------------------------------------------------------
# Window aggregation
# ---------------------------------------------------------------------------


def window_sums(games: pd.DataFrame, season: int) -> pd.DataFrame:
    """Recency-weighted sums per (player, window), plus raw counts for shrinkage."""
    w = window_weights(games, "player_id", season)
    team_cols = [c for c in w.columns if c.startswith("team_")]
    value_cols = COUNT_COLUMNS + team_cols
    weighted = w[value_cols].mul(w["weight"], axis=0)
    weighted["snap_pct_w"] = w["offense_pct"].fillna(0.0) * w["weight"]
    weighted["snap_w"] = w["offense_pct"].notna() * w["weight"]
    weighted["weight"] = w["weight"]
    keys = [w["player_id"], w["window"]]
    sums = weighted.groupby(keys).sum()
    raw = w[COUNT_COLUMNS].groupby(keys).sum().add_prefix("n_")
    games_n = w.groupby(keys).size().rename("games")
    last_team = w.sort_values(["season", "week"]).groupby(keys)["team"].last()
    return sums.join(raw).join(games_n).join(last_team)


def ratio(num: float, den: float) -> float:
    return num / den if den > 0 else 0.0


def player_params(
    pid: str, window: str, r: pd.Series, position: str, priors: dict, hists: dict
) -> dict:
    k = model_config()["shrinkage"]
    pp = lambda stat: position_prior(priors, position, stat)  # noqa: E731

    catch = shrink(
        ratio(r["receptions"], r["targets"]), r["n_targets"], pp("catchRate"), k["receiverTargetsK"]
    )
    ypt = shrink(
        ratio(r["rec_yds"], r["targets"]),
        r["n_targets"],
        pp("yardsPerTarget"),
        k["receiverTargetsK"],
    )
    ypr = shrink(
        ratio(r["rec_yds"], r["receptions"]),
        r["n_receptions"],
        pp("yardsPerReception"),
        k["receiverTargetsK"],
    )
    ypc = shrink(
        ratio(r["rush_yds"], r["carries"]), r["n_carries"], pp("yardsPerCarry"), k["rusherCarriesK"]
    )
    snap_share = ratio(r["snap_pct_w"], r["snap_w"])

    out = {
        "playerId": pid,
        "window": window,
        "games": int(r["games"]),
        "snapShare": snap_share,
        "routeShare": snap_share,
        "catchRate": catch,
        "yardsPerTarget": ypt,
        "recYdsTilt": tilt_for(hists["completionYds"], ypr, priors["all"]["yardsPerReception"]),
        "yardsPerCarry": ypc,
        "rushYdsTilt": tilt_for(hists["runYds"], ypc, priors["all"]["yardsPerCarry"]),
    }
    for field, (num, den) in SHARE_STATS.items():
        out[field] = ratio(r[num], r[den])

    if r["n_dropbacks"] > 0:
        q, kq = priors["qb"], k["qbDropbacksK"]
        ypc_qb = shrink(
            ratio(r["pass_yds"], r["completions"]), r["n_completions"], q["yardsPerCompletion"], kq
        )
        out["qb"] = {
            "dropbacks": int(r["n_dropbacks"]),
            "completionRate": shrink(
                ratio(r["completions"], r["pass_att"]), r["n_pass_att"], q["completionRate"], kq
            ),
            "yardsPerAttempt": shrink(
                ratio(r["pass_yds"], r["pass_att"]), r["n_pass_att"], q["yardsPerAttempt"], kq
            ),
            "passYdsTilt": tilt_for(hists["completionYds"], ypc_qb, q["yardsPerCompletion"]),
            "sackRate": shrink(
                ratio(r["sacks"], r["dropbacks"]), r["n_dropbacks"], q["sackRate"], kq
            ),
            "intRate": shrink(ratio(r["ints"], r["pass_att"]), r["n_pass_att"], q["intRate"], kq),
            "scrambleRate": shrink(
                ratio(r["scrambles"], r["dropbacks"]), r["n_dropbacks"], q["scrambleRate"], kq
            ),
            "designedRunShare": ratio(r["carries"], r["team_carries"]),
        }

    if r["n_fg_att"] > 0 or r["n_xp_att"] > 0:
        kk = k["kickerAttemptsK"]
        xp_prior = model_config()["kicking"]["xpMakeRate"]
        out["kicker"] = {
            "fgAttempts": int(r["n_fg_att"]),
            "fgMakeOverExpected": shrink(
                ratio(r["fg_made"] - r["fg_expected"], r["fg_att"]), r["n_fg_att"], 0.0, kk
            ),
            "xpRate": shrink(ratio(r["xp_made"], r["xp_att"]), r["n_xp_att"], xp_prior, kk),
        }
    return out


def fit_players(season: int, week: int) -> dict:
    min_games = model_config()["fitting"]["minPlayerGamesPerWindow"]
    hists = read_json(fits_dir(season, week) / "league_base.json")["histograms"]
    rosters = read_raw(
        "rosters_weekly",
        [season - 1, season],
        columns=["season", "week", "gsis_id", "pfr_id", "position"],
    )
    positions = rosters.sort_values(["season", "week"]).drop_duplicates("gsis_id", keep="last")
    positions = positions.set_index("gsis_id")["position"]

    plays = load_pbp(season, week)
    games = add_snaps(player_games(plays), season, week, rosters)
    priors = league_priors(games, positions)
    sums = window_sums(games, season)

    params: dict = {}
    aux: dict = {}
    for (pid, window), r in sums.iterrows():
        if r["games"] < min_games or window not in history_windows():
            continue
        position = positions.get(pid, "UNK")
        params.setdefault(pid, {})[window] = player_params(pid, window, r, position, priors, hists)
        if r["n_dropbacks"] > 0:
            epa = shrink(
                ratio(r["qb_epa"], r["dropbacks"]),
                r["n_dropbacks"],
                priors["qb"]["epaPerDropback"],
                model_config()["shrinkage"]["qbDropbacksK"],
            )
            aux.setdefault(pid, {}).setdefault("qbEpaPerDropback", {})[window] = epa
    return {"season": season, "week": week, "priors": priors, "params": params, "aux": aux}


def main() -> None:
    parser = argparse.ArgumentParser(description="Fit player params for one slate.")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=int, required=True)
    args = parser.parse_args()
    result = fit_players(args.season, args.week)
    path = fits_dir(args.season, args.week) / "players.json"
    write_json(path, result)
    print(f"Wrote {path} ({len(result['params'])} players)")


if __name__ == "__main__":
    main()
