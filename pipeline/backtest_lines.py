"""Closing lines and results for the walk-forward backtest (CLAUDE.md §14).

nflverse schedules carry closing spreads, totals, moneylines and their prices. Exported as JSON
for jobs/backtest.ts, keyed by game id. Spreads are stored as the home team's line (nflverse
spread_line is the home team's expected margin, so the home line is its negative).

Usage: python backtest_lines.py --seasons 2022 2023 2024 2025
Writes data/backtest/closing.json.
"""

import argparse
import json

import pandas as pd

from common.io import PIPELINE_DIR, read_raw

OUT = PIPELINE_DIR / "data" / "backtest" / "closing.json"


def _int(x: object) -> int | None:
    return None if pd.isna(x) else int(x)  # type: ignore[arg-type]


def closing_lines(sched: pd.DataFrame) -> dict[str, dict]:
    games = sched[(sched["game_type"] == "REG") & sched["home_score"].notna()]
    out: dict[str, dict] = {}
    for _, g in games.iterrows():
        out[g["game_id"]] = {
            "season": int(g["season"]),
            "week": int(g["week"]),
            "home": g["home_team"],
            "away": g["away_team"],
            "homeScore": int(g["home_score"]),
            "awayScore": int(g["away_score"]),
            "homeSpread": None if pd.isna(g["spread_line"]) else -float(g["spread_line"]),
            "homeSpreadPrice": _int(g["home_spread_odds"]),
            "awaySpreadPrice": _int(g["away_spread_odds"]),
            "total": None if pd.isna(g["total_line"]) else float(g["total_line"]),
            "overPrice": _int(g["over_odds"]),
            "underPrice": _int(g["under_odds"]),
            "homeMl": _int(g["home_moneyline"]),
            "awayMl": _int(g["away_moneyline"]),
        }
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seasons", type=int, nargs="+", required=True)
    args = parser.parse_args()
    lines = closing_lines(read_raw("schedules", args.seasons))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(lines, separators=(",", ":")))
    print(f"Wrote {OUT}: {len(lines)} games")


if __name__ == "__main__":
    main()
