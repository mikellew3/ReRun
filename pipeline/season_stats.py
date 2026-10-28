"""Real scoring components per game, for comparison with jobs/seasonStats.ts when sim scoring
drifts from real scoring.

Usage: python season_stats.py --season 2024 --weeks 4 8 12 16
"""

import argparse
import json

from common.io import read_raw


def season_stats(season: int, weeks: list[int]) -> dict:
    pbp = read_raw("pbp", [season])
    p = pbp[(pbp["season_type"] == "REG") & pbp["week"].isin(weeks)]
    games = p["game_id"].nunique()
    snaps = p[p["play_type"].isin(["pass", "run"]) & (p["qb_kneel"] != 1) & (p["qb_spike"] != 1)]
    fg = p[p["field_goal_attempt"] == 1]
    fourth = p[(p["down"] == 4) & p["play_type"].isin(["pass", "run", "punt", "field_goal"])]
    scrim = p[p["play_type"].isin(["pass", "run", "punt", "field_goal"]) | (p["penalty"] == 1)]
    scrim = scrim[scrim["fixed_drive"].notna() & scrim["yardline_100"].notna()]
    drives = scrim.groupby(["game_id", "fixed_drive"]).agg(
        start=("yardline_100", "first"),
        best=("yardline_100", "min"),
        result=("fixed_drive_result", "first"),
    )
    rz = drives[drives["best"] <= 20]
    finals = p.groupby("game_id")[["total_home_score", "total_away_score"]].max()
    pts = float((finals["total_home_score"] + finals["total_away_score"]).sum())
    fg50 = fg[fg["kick_distance"] >= 50]
    third = snaps[snaps["down"] == 3]
    first = snaps[snaps["down"] == 1]
    return {
        "thirdDist": float(third["ydstogo"].mean()),
        "thirdConv": float((third["yards_gained"] >= third["ydstogo"]).mean()),
        "firstDownYpp": float(first["yards_gained"].mean()),
        "firstDownSuccess": float((first["yards_gained"] >= 0.4 * first["ydstogo"]).mean()),
        "games": int(games),
        "points": pts / games,
        "touchdowns": float(p["touchdown"].sum()) / games,
        "fga": len(fg) / games,
        "fgRate": float((fg["field_goal_result"] == "made").mean()),
        "fga50": len(fg50) / games,
        "fg50Rate": float((fg50["field_goal_result"] == "made").mean()),
        "punts": float(p["punt_attempt"].sum()) / games,
        "plays": len(snaps) / games,
        "yardsPerPlay": float(snaps["yards_gained"].mean()),
        "drives": len(drives) / games,
        "driveStart": float((100 - drives["start"]).mean()),
        "turnovers": float(p["interception"].sum() + p["fumble_lost"].sum()) / games,
        "fourthGoRate": float(fourth["play_type"].isin(["pass", "run"]).mean()),
        "redZoneDrives": len(rz) / games,
        "redZoneTdRate": float((rz["result"] == "Touchdown").mean()),
        "pointsPerDrive": pts / len(drives),
        "twoPt": float(p["two_point_attempt"].sum()) / games,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--weeks", type=int, nargs="+", required=True)
    args = parser.parse_args()
    out = season_stats(args.season, args.weeks)
    print(json.dumps({k: round(v, 3) for k, v in out.items()}))


if __name__ == "__main__":
    main()
