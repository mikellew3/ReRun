"""Measures the situational effects the engine's step-5 adjustments use, from 2022-2025 data.

    python measure_adjustments.py [--seasons 2022 2023 2024 2025] [--out ../docs/adjustments.json]

Sections:
  weather   - wind, rain, snow and cold vs calm/dry outdoor games, on per-play outcomes, with the
              offense's and defense's season averages taken out (residuals)
  qb        - quarterbacks who were not the team's usual QB, vs league average (opp-adjusted)
  lines     - offensive-line and secondary starters missing (from snap counts)
  usage     - how a missing receiver's targets are shared out among teammates
  matchup   - defense vs position: how much of a defense's positional pattern carries over
  schedule  - rest, bye, travel, time zones, altitude and streaks: what the closing spread
              charges for each (team-season ratings held fixed), and what results show

The engine's config (engine/src/config/model.config.ts) is set by hand from this report;
docs/adjustments.md records the numbers and the choices.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from build_snapshot import Stadiums, haversine_miles
from common.io import read_raw
from common.plays import PBP_COLUMNS, add_flags, fg_make_prob
from fit_team_params import receiver_buckets

SEASONS = [2022, 2023, 2024, 2025]
OL = {"T", "G", "C", "OL"}
SECONDARY = {"CB", "FS", "SS", "S", "DB"}


def logit(p: float | np.ndarray) -> float | np.ndarray:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def ols(x: np.ndarray, y: np.ndarray, w: np.ndarray | None = None, ridge: np.ndarray | None = None):
    """Weighted least squares; returns (coef, se)."""
    w = np.ones(len(y)) if w is None else w
    xw = x * w[:, None]
    a = x.T @ xw
    if ridge is not None:
        a = a + np.diag(ridge)
    coef = np.linalg.solve(a, xw.T @ y)
    resid = y - x @ coef
    dof = max(1, len(y) - x.shape[1])
    sigma2 = float((w * resid**2).sum() / dof)
    cov = sigma2 * np.linalg.inv(a)
    return coef, np.sqrt(np.diag(cov))


def load_plays(seasons: list[int]) -> pd.DataFrame:
    p = read_raw("pbp", seasons, columns=[*PBP_COLUMNS, "wind", "temp", "weather", "roof"])
    p = add_flags(p[p["season_type"] == "REG"])
    w = p["weather"].fillna("").str.lower()
    p["snow"] = w.str.contains("snow")
    p["rain"] = ~p["snow"] & w.str.contains("rain|shower|drizzle")
    p["outdoor"] = p["roof"].isin(["outdoors", "open"])
    p["off_ts"] = p["posteam"] + p["season"].astype(str)
    p["def_ts"] = p["defteam"] + p["season"].astype(str)
    return p


def residual(df: pd.DataFrame, col: str, transform=None) -> pd.Series:
    """Outcome minus (offense team-season mean + defense team-season mean - league mean), in
    the transformed scale (e.g. logit for rates)."""
    t = transform or (lambda v: v)
    league = t(df[col].mean())
    off = df.groupby("off_ts")[col].transform("mean").map(t)
    de = df.groupby("def_ts")[col].transform("mean").map(t)
    expected = off + de - league
    if transform is None:
        return df[col] - expected
    # For rates: residual in probability, then scaled to logit at the expected rate.
    pe = 1 / (1 + np.exp(-expected))
    return (df[col].astype(float) - pe) / (pe * (1 - pe))


# ---------------------------------------------------------------------------
# Weather
# ---------------------------------------------------------------------------


def weather(p: pd.DataFrame, wind_start: float, wind_full: float) -> dict:
    o = p[p["outdoor"]].copy()
    o["wind_ramp"] = ((o["wind"].fillna(0) - wind_start) / (wind_full - wind_start)).clip(0, 1)
    o["cold"] = o["temp"].fillna(60) < 25
    feats = ["wind_ramp", "rain", "snow", "cold"]

    def fit(frame: pd.DataFrame, y: pd.Series) -> dict:
        x = np.column_stack([np.ones(len(frame))] + [frame[f].astype(float) for f in feats])
        coef, se = ols(x, y.to_numpy(float))
        return {
            f: {"coef": round(float(c), 4), "se": round(float(s), 4)}
            for f, c, s in zip(feats, coef[1:], se[1:], strict=True)
        }

    att = o[o["is_attempt"]].copy()
    att["y"] = att["is_complete"].astype(float)
    comp = o[o["is_complete"]].copy()
    runs = o[o["is_designed_run"]].copy()
    plays = o[o["is_play"]].copy()
    drop = o[o["is_dropback"]].copy()
    drop["y"] = drop["is_sack"].astype(float)
    att["int"] = att["is_int"].astype(float)
    plays["fl"] = plays["fumble_lost"].astype(float)

    fg = o[o["field_goal_attempt"] & o["kick_distance"].notna()].copy()
    made = (fg["field_goal_result"] == "made").astype(float)
    pe = fg_make_prob(fg["kick_distance"])
    fg_res = (made - pe) / (pe * (1 - pe))
    # Wind effect on FGs scales with distance (config: distance / reference).
    fg_scaled = fg.copy()
    fg_scaled["wind_ramp"] = fg["wind_ramp"] * fg["kick_distance"] / 45

    buckets = pd.cut(o["wind"], [-1, 7, 11, 15, 19, 24, 60])
    by_wind = (
        att.assign(b=buckets)
        .groupby("b", observed=True)
        .apply(lambda g: pd.Series({"n": len(g), "comp": g["y"].mean()}), include_groups=False)
    )
    return {
        "completionLogit": fit(att, residual(att, "y", logit)),
        "intLogit": fit(att, residual(att, "int", logit)),
        "sackLogit": fit(drop, residual(drop, "y", logit)),
        "yardsPerCompletion": fit(comp, residual(comp, "yards_gained")),
        "yardsPerCarry": fit(runs, residual(runs, "yards_gained")),
        "fumbleLostPerPlay": fit(plays, residual(plays, "fl")),
        "fumbleLostBase": round(float(plays["fl"].mean()), 5),
        "fgLogit": fit(fg_scaled, fg_res),
        "completionByWind": {
            str(k): [int(v["n"]), round(float(v["comp"]), 3)] for k, v in by_wind.iterrows()
        },
        "attempts": int(len(att)),
    }


# ---------------------------------------------------------------------------
# Backup quarterbacks
# ---------------------------------------------------------------------------


def backup_qbs(p: pd.DataFrame) -> dict:
    d = p[p["is_dropback"] & p["passer_id"].notna()].copy()
    usual = (
        d.groupby(["off_ts", "passer_id"])
        .size()
        .reset_index(name="n")
        .sort_values("n")
        .groupby("off_ts")
        .tail(1)
        .set_index("off_ts")["passer_id"]
    )
    d["backup"] = d["passer_id"] != d["off_ts"].map(usual)
    d["sack"] = d["is_sack"].astype(float)
    d["scr"] = d["is_scramble"].astype(float)
    att = d[d["is_attempt"]].copy()
    att["comp"] = att["is_complete"].astype(float)
    att["int"] = att["is_int"].astype(float)
    comp = att[att["is_complete"]].copy()

    def defense_adjusted(frame: pd.DataFrame, col: str, rate: bool) -> dict:
        """Backup minus league, and backup minus his team's usual QB, after the defense."""
        league = frame[col].mean()
        de = frame.groupby("def_ts")[col].transform("mean")
        if rate:
            r = (frame[col] - de) / (de * (1 - de)).clip(lower=1e-3)  # per-play logit residual
        else:
            r = frame[col] - de
        back = r[frame["backup"]].mean()
        start = r[~frame["backup"]].mean()
        return {
            "backupVsLeague": round(float(back), 4),
            "backupVsUsual": round(float(back - start), 4),
            "league": round(float(league), 4),
        }

    return {
        "completionLogit": defense_adjusted(att, "comp", True),
        "intLogit": defense_adjusted(att, "int", True),
        "sackLogit": defense_adjusted(d, "sack", True),
        "scrambleLogit": defense_adjusted(d, "scr", True),
        "yardsPerCompletion": defense_adjusted(comp, "yards_gained", False),
        "epaPerDropback": defense_adjusted(d, "epa", False),
        "backupDropbacks": int(d["backup"].sum()),
        "dropbacks": int(len(d)),
    }


# ---------------------------------------------------------------------------
# Offensive line and secondary starters missing
# ---------------------------------------------------------------------------


def starters_missing(
    seasons: list[int], positions: set[str], side: str, n_starters: int
) -> pd.DataFrame:
    """Per (game, team): how many of the team-season's top-n snap getters at these positions
    played under a quarter of the snaps (or not at all)."""
    s = read_raw("snap_counts", seasons)
    s = s[s["game_type"] == "REG"]
    snaps, pct = f"{side}_snaps", f"{side}_pct"
    s = s[s["position"].isin(positions)]
    tot = s.groupby(["season", "team", "pfr_player_id"])[snaps].sum().reset_index()
    top = tot.sort_values(snaps).groupby(["season", "team"]).tail(n_starters)
    games = s[["season", "game_id", "team"]].drop_duplicates()
    played = s[s[pct] >= 0.25][["game_id", "team", "pfr_player_id"]]
    m = games.merge(top[["season", "team", "pfr_player_id"]], on=["season", "team"])
    m = m.merge(played.assign(on=1), on=["game_id", "team", "pfr_player_id"], how="left")
    out = m.groupby(["game_id", "team"])["on"].apply(lambda v: int(v.isna().sum()))
    return out.reset_index(name="missing")


def team_game_outcomes(p: pd.DataFrame, team_col: str) -> pd.DataFrame:
    g = p.groupby(["game_id", "season", team_col])
    df = (
        pd.DataFrame(
            {
                "dropbacks": g["is_dropback"].sum(),
                "sacks": g["is_sack"].sum(),
                "attempts": g["is_attempt"].sum(),
                "completions": g["is_complete"].sum(),
                "comp_yds": g.apply(
                    lambda x: x.loc[x["is_complete"], "yards_gained"].sum(), include_groups=False
                ),
                "carries": g["is_designed_run"].sum(),
                "rush_yds": g.apply(
                    lambda x: x.loc[x["is_designed_run"], "yards_gained"].sum(),
                    include_groups=False,
                ),
            }
        )
        .reset_index()
        .rename(columns={team_col: "team"})
    )
    return df


def loo_effect(df: pd.DataFrame, num: str, den: str, missing: str, is_rate: bool) -> dict:
    """Game value minus the team-season leave-one-out mean, regressed on starters missing."""
    key = ["season", "team"]
    tn = df.groupby(key)[num].transform("sum") - df[num]
    td = df.groupby(key)[den].transform("sum") - df[den]
    base = tn / td
    val = df[num] / df[den]
    ok = (df[den] > 0) & (td > 0)
    if is_rate:
        y = ((val - base) / (base * (1 - base)).clip(lower=1e-3))[ok]
    else:
        y = (val - base)[ok]
    x = np.column_stack([np.ones(ok.sum()), df.loc[ok, missing].astype(float)])
    coef, se = ols(x, y.to_numpy(float), w=df.loc[ok, den].to_numpy(float))
    counts = df.loc[ok, missing].value_counts().sort_index()
    return {
        "perStarter": round(float(coef[1]), 4),
        "se": round(float(se[1]), 4),
        "games": {int(k): int(v) for k, v in counts.items()},
    }


def lines(p: pd.DataFrame, seasons: list[int]) -> dict:
    ol = starters_missing(seasons, OL, "offense", 5)
    sec = starters_missing(seasons, SECONDARY, "defense", 4)
    off = team_game_outcomes(p, "posteam").merge(ol, on=["game_id", "team"])
    # Secondary: the defense's missing starters vs the passing it allowed.
    dfn = team_game_outcomes(p, "defteam").merge(sec, on=["game_id", "team"])
    return {
        "olSackLogit": loo_effect(off, "sacks", "dropbacks", "missing", True),
        "olYardsPerCarry": loo_effect(off, "rush_yds", "carries", "missing", False),
        "olCompletionLogit": loo_effect(off, "completions", "attempts", "missing", True),
        "secondaryCompletionLogit": loo_effect(dfn, "completions", "attempts", "missing", True),
        "secondaryYardsPerCompletion": loo_effect(dfn, "comp_yds", "completions", "missing", False),
    }


# ---------------------------------------------------------------------------
# Defense vs position: how much of a defense's positional pattern carries over
# ---------------------------------------------------------------------------


def matchup(p: pd.DataFrame, seasons: list[int]) -> dict:
    """Split-half check of defense-vs-position. For each defense-season and receiver bucket, the
    bucket's target share and yards per target relative to the defense's overall numbers and
    to the league's pattern (as the engine computes them), in weeks 1-9 and in weeks 10-18.
    The slope of second half on first half is how much of an observed deviation is real; with
    n targets behind the first-half value, the matching shrinkage constant is
    k = n x (1 - slope) / slope."""
    rost = read_raw("rosters_weekly", seasons, columns=["season", "week", "gsis_id", "position"])
    buckets = receiver_buckets(p, rost)
    t = p[p["is_attempt"] & p["receiver_player_id"].notna()].merge(
        buckets, on=["season", "posteam", "receiver_player_id"], how="inner"
    )
    t["rec_yds"] = t["yards_gained"].where(t["is_complete"], 0.0)
    t["half"] = np.where(t["week"] <= 9, 1, 2)
    g = t.groupby(["def_ts", "half", "bucket"]).agg(n=("rec_yds", "size"), yds=("rec_yds", "sum"))
    g = g.reset_index()
    tot = g.groupby(["def_ts", "half"])[["n", "yds"]].transform("sum")
    lg = g.groupby("bucket")[["n", "yds"]].sum()
    lg_share = lg["n"] / lg["n"].sum()
    lg_ypt = lg["yds"] / lg["n"]
    lg_all = lg["yds"].sum() / lg["n"].sum()
    g["share_ratio"] = (g["n"] / tot["n"]) / g["bucket"].map(lg_share)
    g["ypt_ratio"] = (
        (g["yds"] / g["n"]) / (tot["yds"] / tot["n"]) / (g["bucket"].map(lg_ypt) / lg_all)
    )
    wide = g.pivot_table(
        index=["def_ts", "bucket"], columns="half", values=["share_ratio", "ypt_ratio", "n"]
    ).dropna()
    out = {}
    for name in ("share_ratio", "ypt_ratio"):
        x = wide[(name, 1)] - 1
        y = wide[(name, 2)] - 1
        slope = float((x * y).sum() / (x * x).sum())
        n1 = float(wide[("n", 1)].mean())
        out[name] = {
            "slope": round(slope, 3),
            "corr": round(float(np.corrcoef(x, y)[0, 1]), 3),
            "firstHalfTargets": round(n1, 1),
            "impliedK": round(n1 * (1 - slope) / slope, 0) if slope > 0 else None,
            "pairs": int(len(wide)),
        }
    return out


# ---------------------------------------------------------------------------
# Where a missing receiver's targets go
# ---------------------------------------------------------------------------


def usage(p: pd.DataFrame, seasons: list[int]) -> dict:
    """When a player with a big share misses a game: how much of his share his same-position
    teammates pick up, against what proportional reallocation would give them."""
    rost = read_raw("rosters_weekly", seasons, columns=["season", "gsis_id", "position"])
    pos = rost.drop_duplicates(["season", "gsis_id"]).set_index(["season", "gsis_id"])["position"]

    def measure(plays: pd.DataFrame, id_col: str, min_share: float) -> dict:
        n = plays.groupby(["season", "off_ts", "game_id", id_col]).size().rename("n").reset_index()
        n["share"] = n["n"] / n.groupby(["off_ts", "game_id"])["n"].transform("sum")
        events = []
        for _, sub in n.groupby("off_ts"):
            season = int(sub["season"].iloc[0])
            g_ids = sub["game_id"].unique()
            wide = sub.pivot_table(
                index="game_id", columns=id_col, values="share", fill_value=0.0
            ).reindex(g_ids, fill_value=0.0)
            for star in wide.columns:
                on = wide[star] > 0
                if on.sum() < 4 or not 1 <= (~on).sum() <= len(g_ids) - 4:
                    continue
                vac = wide.loc[on, star].mean()
                if vac < min_share:
                    continue
                star_pos = pos.get((season, star))
                others = [c for c in wide.columns if c != star]
                gain = wide.loc[~on, others].mean() - wide.loc[on, others].mean()
                same = [c for c in others if pos.get((season, c)) == star_pos]
                with_same = wide.loc[on, same].mean().sum()
                events.append(
                    {
                        "pos": star_pos,
                        "w": int((~on).sum()),
                        "kept": gain[same].sum() / vac,
                        "proportional": with_same / (1 - vac),
                    }
                )
        ev = pd.DataFrame(events)
        out = {}
        for star_pos, g in ev.groupby("pos"):
            out[star_pos] = {
                "keptInPosition": round(float(np.average(g["kept"], weights=g["w"])), 3),
                "proportionalWouldKeep": round(
                    float(np.average(g["proportional"], weights=g["w"])), 3
                ),
                "players": int(len(g)),
            }
        return out

    targets = p[p["is_attempt"] & p["receiver_player_id"].notna()]
    carries = p[p["is_designed_run"] & p["rusher_player_id"].notna()]
    return {
        "targets": measure(targets, "receiver_player_id", 0.18),
        "carries": measure(carries, "rusher_player_id", 0.35),
    }


# ---------------------------------------------------------------------------
# Rest, travel, altitude, streaks: closing spreads and results
# ---------------------------------------------------------------------------


def schedule(seasons: list[int]) -> dict:
    stadiums = Stadiums()
    sc = read_raw("schedules", seasons)
    sc = sc[(sc["game_type"] == "REG") & sc["result"].notna()].sort_values(["season", "week"])
    sc = sc.reset_index(drop=True)

    # Entering-game streaks (+ wins, - losses; ATS from the closing spread).
    streak: dict[tuple[int, str], tuple[int, int]] = {}
    feats = []
    for _, g in sc.iterrows():
        site = stadiums.find(g["stadium"], g["stadium_id"])
        away_home = stadiums.home_of[g["away_team"]]
        home_home = stadiums.home_of[g["home_team"]]
        miles = haversine_miles(away_home, site) - haversine_miles(home_home, site)
        tz_a = tz_hours(away_home["tz"], site["tz"])
        tz_h = tz_hours(home_home["tz"], site["tz"])
        sh = streak.get((g["season"], g["home_team"]), (0, 0))
        sa = streak.get((g["season"], g["away_team"]), (0, 0))
        hr, ar = int(g["home_rest"]), int(g["away_rest"])
        feats.append(
            {
                "home_field": 0.0 if g["location"] == "Neutral" else 1.0,
                # Rest-day gap for teams not coming off a bye (e.g. Monday night -> Sunday).
                "rest_gap": float(np.clip(min(hr, 8) - min(ar, 8), -3, 3))
                if max(hr, ar) < 13
                else 0.0,
                "bye": float(hr >= 13) - float(ar >= 13),
                "long_travel": float(miles >= 2000) - float(-miles >= 2000),
                "tz_hours": abs(tz_a) - abs(tz_h),
                "altitude": float(int(site["altitude_ft"]) >= 5000 and g["location"] != "Neutral"),
                "win_streak": float(np.clip(sh[0], -4, 4) - np.clip(sa[0], -4, 4)),
                "ats_streak": float(np.clip(sh[1], -4, 4) - np.clip(sa[1], -4, 4)),
            }
        )
        r, sp = float(g["result"]), float(g["spread_line"])
        for team, sign in ((g["home_team"], 1), (g["away_team"], -1)):
            w, a = streak.get((g["season"], team), (0, 0))
            won = sign * r > 0
            cov = sign * (r - sp)
            w = (max(w, 0) + 1) if won else (min(w, 0) - 1) if sign * r < 0 else 0
            a = (max(a, 0) + 1) if cov > 0 else (min(a, 0) - 1) if cov < 0 else a
            streak[(g["season"], team)] = (w, a)
    f = pd.DataFrame(feats)
    names = list(f.columns)

    # Team ratings per team-season half (ridge, light).
    half = np.where(sc["week"] <= 9, "a", "b")
    th = sc["home_team"] + sc["season"].astype(str) + half
    ta = sc["away_team"] + sc["season"].astype(str) + half
    teams = sorted(set(th) | set(ta))
    ix = {t: i for i, t in enumerate(teams)}
    tm = np.zeros((len(sc), len(teams)))
    tm[np.arange(len(sc)), th.map(ix)] = 1
    tm[np.arange(len(sc)), ta.map(ix)] = -1
    x = np.column_stack([f.to_numpy(float), tm])
    ridge = np.r_[np.zeros(len(names)), np.full(len(teams), 1.0)]

    def fit(y: np.ndarray, ridge_scale: float) -> dict:
        coef, se = ols(x, y, ridge=ridge * ridge_scale)
        return {
            n: {"pts": round(float(c), 3), "se": round(float(s), 3)}
            for n, c, s in zip(names, coef, se, strict=False)
        }

    counts = {n: int((f[n] != 0).sum()) for n in names}
    return {
        "games": int(len(sc)),
        "gamesWithFeature": counts,
        "closingSpread": fit(sc["spread_line"].to_numpy(float), 1.0),
        # Results are noisy (sd ~13 pts); stronger ridge on ratings.
        "result": fit(sc["result"].to_numpy(float), 10.0),
        "resultMinusSpread": fit((sc["result"] - sc["spread_line"]).to_numpy(float), 1e6),
    }


def tz_hours(a: str, b: str) -> float:
    ref = pd.Timestamp("2024-10-15 18:00", tz="UTC")
    return (ref.tz_convert(b).utcoffset() - ref.tz_convert(a).utcoffset()).total_seconds() / 3600


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--seasons", type=int, nargs="+", default=SEASONS)
    ap.add_argument("--wind-start", type=float, default=12.0)
    ap.add_argument("--wind-full", type=float, default=25.0)
    ap.add_argument(
        "--out", type=Path, default=Path(__file__).parent.parent / "docs" / "adjustments.json"
    )
    args = ap.parse_args()

    plays = load_plays(args.seasons)
    report = {
        "seasons": args.seasons,
        "weather": weather(plays, args.wind_start, args.wind_full),
        "qb": backup_qbs(plays),
        "lines": lines(plays, args.seasons),
        "usage": usage(plays, args.seasons),
        "matchup": matchup(plays, args.seasons),
        "schedule": schedule(args.seasons),
    }
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
