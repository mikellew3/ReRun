"""Grades the forward test (jobs/recordForward.ts) once games are played.

For every recorded quote (the last record before kickoff), finds the result: final and
first-half scores for game lines, the player's box score for props (void if he didn't play).
Reports by market: the sim's and the market's average chance of side A (home / over), how often
side A won, log loss of each, and the record of the quotes the site shades green (expected value
at least config markets.valueShading.minEv at the sim's chances). Game lines also get
closing-line value against nflverse closing lines.

Usage: python grade_forward.py [--dir ../forward-test] [--out ../docs/forward-test.json]
"""

import argparse
import json
import math
from pathlib import Path

import pandas as pd

from common.config import model_config
from common.io import PIPELINE_DIR, read_raw

ROOT = PIPELINE_DIR.parent


def implied(a: float) -> float:
    return 100 / (a + 100) if a > 0 else -a / (-a + 100)


def decimal(a: float) -> float:
    return 1 + (a / 100 if a > 0 else 100 / -a)


def load_records(folder: Path) -> pd.DataFrame:
    rows = []
    for f in sorted(folder.glob("*.jsonl")):
        rows += [json.loads(line) for line in f.read_text().splitlines() if line.strip()]
    return pd.DataFrame(rows)


def game_results(seasons: list[int]) -> pd.DataFrame:
    sched = read_raw("schedules", seasons)
    sched = sched[sched["home_score"].notna()].set_index("game_id")
    pbp = read_raw(
        "pbp", seasons, columns=["game_id", "qtr", "total_home_score", "total_away_score"]
    )
    h1 = pbp[pbp["qtr"] <= 2].groupby("game_id")[["total_home_score", "total_away_score"]].max()
    out = pd.DataFrame(
        {
            "home": sched["home_score"],
            "away": sched["away_score"],
            "closeSpread": -sched["spread_line"],
            "closeTotal": sched["total_line"],
            "closeHomeMl": sched["home_moneyline"],
            "closeAwayMl": sched["away_moneyline"],
        }
    )
    return out.join(h1.rename(columns={"total_home_score": "h1Home", "total_away_score": "h1Away"}))


def player_stats(seasons: list[int]) -> pd.DataFrame:
    """Per game and player: the stats props settle on, and whether he played."""
    cols = [
        "game_id", "passer_player_id", "rusher_player_id", "receiver_player_id",
        "td_player_id", "complete_pass", "incomplete_pass", "interception", "pass_touchdown",
        "passing_yards", "rushing_yards", "receiving_yards", "rush_attempt", "touchdown",
    ]  # fmt: skip
    p = read_raw("pbp", seasons, columns=cols)
    att = sum(p[c].fillna(0) for c in ("complete_pass", "incomplete_pass", "interception"))
    passing = (
        p.assign(att=att)
        .groupby(["game_id", "passer_player_id"])
        .agg(
            passAtt=("att", "sum"),
            passCmp=("complete_pass", "sum"),
            passYds=("passing_yards", "sum"),
            passTd=("pass_touchdown", "sum"),
            passInt=("interception", "sum"),
        )
    )
    rushing = (
        p[p["rush_attempt"] == 1]
        .groupby(["game_id", "rusher_player_id"])
        .agg(rushAtt=("rush_attempt", "sum"), rushYds=("rushing_yards", "sum"))
    )
    receiving = (
        p[p["receiver_player_id"].notna()]
        .groupby(["game_id", "receiver_player_id"])
        .agg(rec=("complete_pass", "sum"), recYds=("receiving_yards", "sum"))
    )
    tds = p[p["touchdown"] == 1].groupby(["game_id", "td_player_id"]).size().rename("tds")
    for df in (passing, rushing, receiving):
        df.index.names = ["game_id", "id"]
    tds.index.names = ["game_id", "id"]
    stats = passing.join(rushing, how="outer").join(receiving, how="outer").join(tds, how="outer")
    stats = stats.fillna(0)
    stats["anyTd"] = (stats["tds"] > 0).astype(float)
    return stats


PROP_STAT = {
    "player_pass_yds": "passYds",
    "player_pass_attempts": "passAtt",
    "player_pass_completions": "passCmp",
    "player_pass_tds": "passTd",
    "player_pass_interceptions": "passInt",
    "player_rush_yds": "rushYds",
    "player_rush_attempts": "rushAtt",
    "player_receptions": "rec",
    "player_reception_yds": "recYds",
    "player_anytime_td": "anyTd",
}


def played_ids(seasons: list[int]) -> set[tuple[str, str]]:
    """(game_id, gsis id) for players with offensive snaps."""
    snaps = read_raw("snap_counts", seasons, columns=["game_id", "pfr_player_id", "offense_snaps"])
    ids = read_raw("rosters_weekly", seasons, columns=["gsis_id", "pfr_id"]).drop_duplicates()
    snaps = snaps[snaps["offense_snaps"] > 0].merge(
        ids, left_on="pfr_player_id", right_on="pfr_id", how="inner"
    )
    return set(zip(snaps["game_id"], snaps["gsis_id"], strict=True))


def side_a_value(r: pd.Series, g: pd.Series) -> float | None:
    """The number side A settles on (margin, total, points), or None if unknown."""
    m = r["market"]
    if m.endswith("_h1"):
        if pd.isna(g["h1Home"]):
            return None
        home, away = g["h1Home"], g["h1Away"]
    else:
        home, away = g["home"], g["away"]
    if m.startswith(("h2h", "spreads")):
        return home - away
    if m.startswith("totals"):
        return home + away
    return home if m == "team_totals_home" else away


def outcome(r: pd.Series, value: float) -> float | None:
    """1 = side A won, 0 = side B won, None = push."""
    m, line = r["market"], r["line"]
    if r["kind"] == "line" and m.startswith("h2h"):
        x = value
    elif r["kind"] == "line" and m.startswith("spreads"):
        x = value + line
    else:
        x = value - (0.5 if line is None or pd.isna(line) else line)
    return None if x == 0 else float(x > 0)


def clv(r: pd.Series, side: str, g: pd.Series) -> float | None:
    """Closing-line value of a full-game bet: points for spreads and totals, expected-value %
    at the no-vig closing price for moneylines."""
    m = r["market"]
    if m == "spreads" and not pd.isna(g["closeSpread"]):
        d = r["line"] - g["closeSpread"]
        return d if side == "A" else -d
    if m == "totals" and not pd.isna(g["closeTotal"]):
        d = g["closeTotal"] - r["line"]
        return d if side == "A" else -d
    if m == "h2h" and not pd.isna(g["closeHomeMl"]):
        ph, pa = implied(g["closeHomeMl"]), implied(g["closeAwayMl"])
        close = ph / (ph + pa) if side == "A" else pa / (ph + pa)
        return close * decimal(r["priceA" if side == "A" else "priceB"]) - 1
    return None


def grade(records: pd.DataFrame) -> pd.DataFrame:
    seasons = sorted({int(g[:4]) for g in records["gameId"]})
    games = game_results(seasons)
    stats = player_stats(seasons)
    played = played_ids(seasons)
    out = []
    for _, r in records.iterrows():
        if r["gameId"] not in games.index:
            continue  # not played yet
        g = games.loc[r["gameId"]]
        if r["kind"] == "line":
            value = side_a_value(r, g)
        else:
            if (r["gameId"], r["playerId"]) not in played:
                continue  # void: didn't play
            key = (r["gameId"], r["playerId"])
            value = float(stats.loc[key, PROP_STAT[r["market"]]]) if key in stats.index else 0.0
        if value is None:
            continue
        out.append({**r.to_dict(), "outcome": outcome(r, value), "game": g})
    return pd.DataFrame(out)


def summarize(graded: pd.DataFrame) -> dict:
    min_ev = model_config()["markets"]["valueShading"]["minEv"]
    report: dict = {}
    for (kind, market), x in graded.groupby(["kind", "market"]):
        two_way = x["priceB"].notna()
        nv = x["priceA"].map(implied) / (
            x["priceA"].map(implied) + x["priceB"].where(two_way, x["priceA"]).map(implied)
        )
        nv = nv.where(two_way, x["priceA"].map(implied))
        sim_a = x["simA"] / (x["simA"] + x["simB"]).clip(lower=1e-9)
        dec = x["outcome"].notna()

        def ll(p: pd.Series, y: pd.Series) -> float:
            p = p.clip(1e-4, 1 - 1e-4)
            return float(-(y * p.map(math.log) + (1 - y) * (1 - p).map(math.log)).mean())

        y = x.loc[dec, "outcome"]
        bets = []
        for _, r in x.iterrows():
            for side in ("A", "B"):
                price = r["priceA" if side == "A" else "priceB"]
                if price is None or pd.isna(price):
                    continue
                win = r["simA" if side == "A" else "simB"]
                ev = win * (decimal(price) - 1) - (1 - win - r["push"])
                if ev < min_ev:
                    continue
                res = r["outcome"]
                won = None if res is None or pd.isna(res) else (res == 1) == (side == "A")
                units = 0.0 if won is None else (decimal(price) - 1 if won else -1.0)
                c = clv(r, side, r["game"]) if kind == "line" else None
                bets.append({"won": won, "units": units, "clv": c})
        b = pd.DataFrame(bets)
        w = int((b["won"] == True).sum()) if len(b) else 0  # noqa: E712
        lost = int((b["won"] == False).sum()) if len(b) else 0  # noqa: E712
        pushes = len(b) - w - lost
        clvs = b["clv"].dropna() if len(b) else pd.Series(dtype=float)
        report[f"{kind}:{market}"] = {
            "quotes": len(x),
            "decided": int(dec.sum()),
            "simA": round(float(sim_a.mean()), 3),
            "marketA": round(float(nv.mean()), 3),
            "actualA": round(float(y.mean()), 3) if len(y) else None,
            "logLoss": {
                "sim": round(ll(sim_a[dec], y), 4) if len(y) else None,
                "market": round(ll(nv[dec], y), 4) if len(y) else None,
            },
            "valueBets": {
                "bets": len(b),
                "record": f"{w}-{lost}-{pushes}",
                "units": round(float(b["units"].sum()), 2) if len(b) else 0.0,
                "roi": round(float(b["units"].sum()) / len(b), 3) if len(b) else None,
                "avgClv": round(float(clvs.mean()), 3) if len(clvs) else None,
            },
        }
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dir", type=Path, default=ROOT / "forward-test")
    parser.add_argument("--out", type=Path, default=ROOT / "docs" / "forward-test.json")
    args = parser.parse_args()
    records = load_records(args.dir)
    if records.empty:
        args.out.write_text(json.dumps({"quotesRecorded": 0, "quotesGraded": 0}, indent=2) + "\n")
        print("No forward-test records yet")
        return
    graded = grade(records)
    report = {
        "quotesRecorded": len(records),
        "quotesGraded": len(graded),
        "markets": summarize(graded) if len(graded) else {},
    }
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Graded {len(graded)} of {len(records)} quotes -> {args.out}")


if __name__ == "__main__":
    main()
