"""Team parameters per history window: offense and defense units, PROE, pace,
defense vs position and form.

Method (opponent adjustment):
1. Build one row per (game, offense team) with per-game counts.
2. For each rate, fit a weighted ridge regression over the season window:
   rate ~ league mean + offense effect + defense effect (fit_ridge in common/stats.py).
3. Adjust each game: an offense's rate minus its opponent's defense effect, and a defense's
   allowed rate minus its opponent's offense effect.
4. Average adjusted games over each history window, weighted by recency and play count.

Yardage tilts move the league's open-field histogram by the team's adjusted gap to the league
average (tilt_for).
PROE, pace and no-huddle rate are style numbers and are not opponent-adjusted.

Writes data/fits/{season}-W{week}/teams.json.
Usage: python fit_team_params.py --season 2026 --week 8
"""

import argparse

import pandas as pd

from common.config import history_windows, model_config
from common.io import fits_dir, read_json, read_raw, write_json
from common.plays import add_pace, before_slate, load_pbp, red_zone_drives
from common.stats import histogram_mean, ridge_team_effects, solve_tilt
from common.weights import window_weights

# Opponent-adjusted unit rates: name -> (numerator column, denominator column).
ADJUSTED_RATES = {
    "passEpa": ("pass_epa", "dropbacks"),
    "runEpa": ("run_epa", "runs"),
    "passSuccess": ("pass_success", "dropbacks"),
    "runSuccess": ("run_success", "runs"),
    "sackRate": ("sacks", "dropbacks"),
    "scrambleRate": ("scrambles", "dropbacks"),
    "intRate": ("ints", "attempts"),
    "completionRate": ("completions", "attempts"),
    "explosivePassRate": ("explosive_pass", "attempts"),
    "explosiveRunRate": ("explosive_runs", "runs"),
    "fumbleLostRate": ("fumbles_lost", "plays"),
    "redZoneTdRate": ("rz_tds", "rz_trips"),
    # Means used to solve the yardage tilts; not published directly.
    "compYds": ("comp_yds", "completions"),
    "runYds": ("run_yds", "runs"),
}

DVP_BUCKETS = ["WR1", "WR2", "WR3", "TE", "RB"]


# ---------------------------------------------------------------------------
# Per-game table
# ---------------------------------------------------------------------------


def team_games(plays: pd.DataFrame) -> pd.DataFrame:
    """One row per (game, offense team) with the counts every rate needs."""
    p = plays.copy()
    p["pass_epa"] = p["epa"].where(p["is_dropback"], 0.0)
    p["run_epa"] = p["epa"].where(p["is_designed_run"], 0.0)
    p["pass_success"] = p["success"].where(p["is_dropback"], 0.0)
    p["run_success"] = p["success"].where(p["is_designed_run"], 0.0)
    p["comp_yds"] = p["yards_gained"].where(p["is_complete"], 0.0)
    p["run_yds"] = p["yards_gained"].where(p["is_designed_run"], 0.0)
    p["fumbles_lost"] = p["fumble_lost"] & p["is_play"]
    p["pen_yds_off"] = (
        p["penalty_yards"]
        .fillna(0)
        .where(p["penalty"] & (p["penalty_team"] == p["posteam"]) & p["is_snap"], 0.0)
    )
    p["pen_yds_def"] = (
        p["penalty_yards"]
        .fillna(0)
        .where(p["penalty"] & (p["penalty_team"] == p["defteam"]) & p["is_snap"], 0.0)
    )
    neutral_play = p["is_play"] & p["is_neutral"] & p["pass_oe"].notna()
    p["proe_sum"] = (p["pass_oe"] / 100).where(neutral_play, 0.0)
    p["proe_n"] = neutral_play
    p["pace_sum"] = p["pace_gap"].fillna(0.0)
    p["pace_n"] = p["pace_gap"].notna()
    p["nohuddle_sum"] = p["no_huddle"] & p["is_play"]

    keys = ["game_id", "season", "week", "posteam", "defteam"]
    games = (
        p[p["posteam"].notna() & p["defteam"].notna()]
        .groupby(keys)
        .agg(
            dropbacks=("is_dropback", "sum"),
            sacks=("is_sack", "sum"),
            scrambles=("is_scramble", "sum"),
            attempts=("is_attempt", "sum"),
            completions=("is_complete", "sum"),
            ints=("is_int", "sum"),
            explosive_pass=("is_explosive_pass", "sum"),
            runs=("is_designed_run", "sum"),
            explosive_runs=("is_explosive_run", "sum"),
            plays=("is_play", "sum"),
            snaps=("is_snap", "sum"),
            pass_epa=("pass_epa", "sum"),
            run_epa=("run_epa", "sum"),
            pass_success=("pass_success", "sum"),
            run_success=("run_success", "sum"),
            comp_yds=("comp_yds", "sum"),
            run_yds=("run_yds", "sum"),
            fumbles_lost=("fumbles_lost", "sum"),
            pen_yds_off=("pen_yds_off", "sum"),
            pen_yds_def=("pen_yds_def", "sum"),
            proe_sum=("proe_sum", "sum"),
            proe_n=("proe_n", "sum"),
            pace_sum=("pace_sum", "sum"),
            pace_n=("pace_n", "sum"),
            nohuddle_sum=("nohuddle_sum", "sum"),
        )
        .reset_index()
        .rename(columns={"posteam": "off", "defteam": "def"})
    )
    # A real game has both offenses; drop stray rows (e.g. a lone kneel-down series).
    games = games[games["plays"] > 0]

    rz = (
        red_zone_drives(plays)
        .groupby(["game_id", "posteam"])
        .agg(rz_trips=("td", "size"), rz_tds=("td", "sum"))
    )
    games = games.merge(rz, left_on=["game_id", "off"], right_index=True, how="left").fillna(
        {"rz_trips": 0, "rz_tds": 0}
    )
    return games


# ---------------------------------------------------------------------------
# Opponent adjustment and window averages
# ---------------------------------------------------------------------------


def adjusted_rates(games: pd.DataFrame, season: int) -> tuple[pd.DataFrame, dict[str, float]]:
    """Adds `{metric}_off_adj` and `{metric}_def_adj` per game. Returns league means too."""
    lam = model_config()["fitting"]["ridgeLambdaPlays"]
    season_w = window_weights(games, "off", season)
    season_w = season_w[season_w["window"] == "season"][["game_id", "off", "weight"]]
    rows = games.merge(season_w, on=["game_id", "off"])

    out = games.copy()
    league = {}
    for name, (num, den) in ADJUSTED_RATES.items():
        rows["_rate"] = rows[num] / rows[den].where(rows[den] > 0)
        mean, off_eff, def_eff = ridge_team_effects(rows, "_rate", den, "weight", lam)
        league[name] = mean
        rate = out[num] / out[den].where(out[den] > 0)
        out[f"{name}_off_adj"] = rate - out["def"].map(def_eff).fillna(0.0)
        out[f"{name}_def_adj"] = rate - out["off"].map(off_eff).fillna(0.0)
    return out, league


def weighted_mean(df: pd.DataFrame, by: list[str], value: str, weight: pd.Series) -> pd.Series:
    """sum(weight * value) / sum(weight) per group, skipping rows where value is NaN."""
    ok = df[value].notna() & (weight > 0)
    num = (df[value] * weight).where(ok, 0.0).groupby([df[c] for c in by]).sum()
    den = weight.where(ok, 0.0).groupby([df[c] for c in by]).sum()
    return num / den.where(den > 0)


def unit_window_values(adj: pd.DataFrame, side: str, season: int) -> pd.DataFrame:
    """Window averages of adjusted rates for offense (side="off") or defense (side="def").
    Returns one row per (team, window) with one column per metric plus `games`."""
    w = window_weights(adj, side, season)
    result = pd.DataFrame(index=w.groupby([side, "window"]).size().index)
    result["games"] = w.groupby([side, "window"]).size()
    for name, (_, den) in ADJUSTED_RATES.items():
        result[name] = weighted_mean(
            w, [side, "window"], f"{name}_{side}_adj", w["weight"] * w[den]
        )
    pen_col = "pen_yds_off" if side == "off" else "pen_yds_def"
    w["_pen_rate"] = w[pen_col] / w["snaps"].where(w["snaps"] > 0)
    result["penaltyYdsPerPlay"] = weighted_mean(
        w, [side, "window"], "_pen_rate", w["weight"] * w["snaps"]
    )
    if side == "off":
        for out_name, num, den in [
            ("proe", "proe_sum", "proe_n"),
            ("neutralSecPerPlay", "pace_sum", "pace_n"),
            ("noHuddleRate", "nohuddle_sum", "plays"),
        ]:
            w["_r"] = w[num] / w[den].where(w[den] > 0)
            result[out_name] = weighted_mean(w, [side, "window"], "_r", w["weight"] * w[den])
    return result


def tilt_for(hist: dict, team_mean: float, league_mean: float) -> float:
    """Tilt that moves the open-field histogram by the team's gap to the league average.
    (Observed means include goal-line-shortened plays, so only the gap carries over.)"""
    return solve_tilt(hist, histogram_mean(hist) + team_mean - league_mean)


def unit_params(row: pd.Series, league: dict[str, float], hists: dict) -> dict:
    def val(name: str) -> float:
        v = row.get(name)
        return float(league[name]) if v is None or pd.isna(v) else float(v)

    return {
        "passEpa": val("passEpa"),
        "runEpa": val("runEpa"),
        "passSuccess": val("passSuccess"),
        "runSuccess": val("runSuccess"),
        "sackRate": val("sackRate"),
        "scrambleRate": val("scrambleRate"),
        "intRate": val("intRate"),
        "completionRate": val("completionRate"),
        "passYdsTilt": tilt_for(hists["completionYds"], val("compYds"), league["compYds"]),
        "explosivePassRate": val("explosivePassRate"),
        "runYdsTilt": tilt_for(hists["runYds"], val("runYds"), league["runYds"]),
        "explosiveRunRate": val("explosiveRunRate"),
        "fumbleLostRate": val("fumbleLostRate"),
        "redZoneTdRate": val("redZoneTdRate"),
        "penaltyYdsPerPlay": val("penaltyYdsPerPlay"),
    }


# ---------------------------------------------------------------------------
# Defense vs position
# ---------------------------------------------------------------------------


def receiver_buckets(plays: pd.DataFrame, rosters: pd.DataFrame) -> pd.DataFrame:
    """Bucket per (season, team, receiver): WR1/WR2/WR3 by targets within team-season
    (WR3 = third and below), TE, or RB (incl. FB). Other positions get no bucket."""
    targets = (
        plays[plays["is_attempt"] & plays["receiver_player_id"].notna()]
        .groupby(["season", "posteam", "receiver_player_id"])
        .size()
        .rename("targets")
        .reset_index()
    )
    pos = (
        rosters.sort_values("week")
        .drop_duplicates(["season", "gsis_id"], keep="last")
        .set_index(["season", "gsis_id"])["position"]
    )
    targets["position"] = [
        pos.get((s, pid))
        for s, pid in zip(targets["season"], targets["receiver_player_id"], strict=True)
    ]
    wr = targets[targets["position"] == "WR"].copy()
    wr["rank"] = wr.groupby(["season", "posteam"])["targets"].rank(method="first", ascending=False)
    wr["bucket"] = wr["rank"].map(lambda r: "WR1" if r == 1 else "WR2" if r == 2 else "WR3")
    other = targets[targets["position"].isin(["TE", "RB", "FB"])].copy()
    other["bucket"] = other["position"].map({"TE": "TE", "RB": "RB", "FB": "RB"})
    both = pd.concat([wr, other])
    return both[["season", "posteam", "receiver_player_id", "bucket"]]


def dvp_by_window(
    plays: pd.DataFrame, rosters: pd.DataFrame, games: pd.DataFrame, season: int
) -> dict:
    buckets = receiver_buckets(plays, rosters)
    t = plays[plays["is_attempt"] & plays["receiver_player_id"].notna()].merge(
        buckets, on=["season", "posteam", "receiver_player_id"], how="inner"
    )
    t["rec_yds"] = t["yards_gained"].where(t["is_complete"], 0.0)
    per_game = t.groupby(["game_id", "defteam", "bucket"]).agg(
        targets=("is_attempt", "size"), yds=("rec_yds", "sum")
    )
    # Every defense-game gets every bucket, zero-filled.
    base = games[["game_id", "season", "week", "def"]].drop_duplicates()
    grid = base.merge(pd.DataFrame({"bucket": DVP_BUCKETS}), how="cross")
    grid = grid.merge(
        per_game, left_on=["game_id", "def", "bucket"], right_index=True, how="left"
    ).fillna({"targets": 0, "yds": 0.0})

    w = window_weights(grid, "def", season)
    g = w.groupby(["def", "window", "bucket"])
    agg = pd.DataFrame(
        {
            "w_games": g["weight"].sum(),
            "w_targets": (w["weight"] * w["targets"])
            .groupby([w["def"], w["window"], w["bucket"]])
            .sum(),
            "w_yds": (w["weight"] * w["yds"]).groupby([w["def"], w["window"], w["bucket"]]).sum(),
            "n": g["targets"].sum(),
        }
    )
    league_ypt = grid["yds"].sum() / max(grid["targets"].sum(), 1)
    out: dict = {}
    for (team, window, bucket), r in agg.iterrows():
        ypt = r["w_yds"] / r["w_targets"] if r["w_targets"] > 0 else league_ypt
        out.setdefault(team, {}).setdefault(window, {})[bucket] = {
            "targetsPerGame": float(r["w_targets"] / r["w_games"]),
            "yardsPerTarget": float(ypt),
            "n": int(r["n"]),
        }
    return out


# ---------------------------------------------------------------------------
# Form
# ---------------------------------------------------------------------------


def signed_streak(results: list[int]) -> int:
    """results most-recent-first, each +1 / -1 / 0. Returns +n or -n for the current run."""
    if not results or results[0] == 0:
        return 0
    first = results[0]
    n = 0
    for r in results:
        if r != first:
            break
        n += 1
    return n * first


def team_form(schedules: pd.DataFrame, season: int, week: int) -> dict:
    s = schedules[
        (schedules["season"] == season) & (schedules["week"] < week) & schedules["result"].notna()
    ]
    rows = []
    for _, g in s.iterrows():
        margin = float(g["result"])  # home - away
        cover = margin - float(g["spread_line"]) if pd.notna(g["spread_line"]) else 0.0
        sign = lambda x: (x > 0) - (x < 0)  # noqa: E731
        rows.append((g["home_team"], g["week"], sign(margin), sign(cover)))
        rows.append((g["away_team"], g["week"], -sign(margin), -sign(cover)))
    df = pd.DataFrame(rows, columns=["team", "week", "win", "ats"]).sort_values(
        "week", ascending=False
    )
    return {
        team: {
            "winStreak": signed_streak(list(g["win"])),
            "atsStreak": signed_streak(list(g["ats"])),
        }
        for team, g in df.groupby("team")
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def fit_teams(season: int, week: int) -> dict:
    cfg = model_config()["fitting"]
    hists = read_json(fits_dir(season, week) / "league_base.json")["histograms"]
    plays = add_pace(load_pbp(season, week))
    games = team_games(plays)
    adj, league = adjusted_rates(games, season)

    off = unit_window_values(adj, "off", season)
    deff = unit_window_values(adj, "def", season)
    league_pen = float((games["pen_yds_off"].sum()) / games["snaps"].sum())
    league_all = {**league, "penaltyYdsPerPlay": league_pen}

    rosters = read_raw(
        "rosters_weekly", [season - 1, season], columns=["season", "week", "gsis_id", "position"]
    )
    schedules = before_slate(read_raw("schedules", [season]), season, week)
    dvp = dvp_by_window(plays, rosters, games, season)
    form = team_form(schedules, season, week)

    teams: dict = {}
    for team in sorted(set(games["off"])):
        params = {}
        for window in history_windows():
            key = (team, window)
            if key not in off.index or off.loc[key, "games"] < cfg["minTeamGamesPerWindow"]:
                key = (team, "season")  # too few games: fall back to the season window
            o, d = off.loc[key], deff.loc[key]
            params[window] = {
                "team": team,
                "window": window,
                "games": int(o["games"]),
                "off": unit_params(o, league_all, hists),
                "def": unit_params(d, league_all, hists),
                "proe": float(o["proe"]) if pd.notna(o["proe"]) else 0.0,
                "neutralSecPerPlay": float(o["neutralSecPerPlay"]),
                "noHuddleRate": float(o["noHuddleRate"]),
            }
        team_dvp = dvp.get(team, {})
        teams[team] = {
            "params": params,
            "dvp": {w: team_dvp.get(w, team_dvp.get("season")) for w in history_windows()},
            "form": form.get(team, {"winStreak": 0, "atsStreak": 0}),
        }
    return {"season": season, "week": week, "league": league_all, "teams": teams}


def main() -> None:
    parser = argparse.ArgumentParser(description="Fit team params for one slate.")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=int, required=True)
    args = parser.parse_args()
    result = fit_teams(args.season, args.week)
    path = fits_dir(args.season, args.week) / "teams.json"
    write_json(path, result)
    print(f"Wrote {path} ({len(result['teams'])} teams)")


if __name__ == "__main__":
    main()
