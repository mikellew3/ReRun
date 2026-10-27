"""History windows and recency weights.

Every fitter works on rows about an entity (a team or a player) in games played BEFORE the
slate (walk-forward: the caller filters out the slate week and later). An entity may have
several rows per game (e.g. one per position bucket); weights are always worked out per game
and then copied onto every row of that game.

Windows (model_config fitting.historyWindows):
- "season": current-season games, weight halves every `recencyHalfLifeGames` games back.
  Prior-season games also count, with a total weight of C * C / (C + g), where
  C = priorSeasonCarryoverGames and g = current-season games played. So in week 1 the prior
  season is all there is, and its pull fades as the new season fills in.
- "L3".."L8": the entity's last N games (crossing into the prior season if needed), equal weight.
"""

import pandas as pd

from common.config import model_config


def game_order(season: pd.Series, week: pd.Series) -> pd.Series:
    """Sortable game time. Postseason weeks (19+) sort after the regular season."""
    return season.astype(int) * 100 + week.astype(int)


def _game_weights(games: pd.DataFrame, entity: str, season: int) -> pd.DataFrame:
    """games: one row per (entity, season, week). Returns rows per (entity, game, window)."""
    fitting = model_config()["fitting"]
    half_life = fitting["recencyHalfLifeGames"]
    carryover = fitting["priorSeasonCarryoverGames"]

    df = games.copy()
    df["_order"] = game_order(df["season"], df["week"])
    # 0 = most recent game for this entity
    df["_recency"] = df.groupby(entity)["_order"].rank(method="first", ascending=False) - 1

    out = []

    # Season window
    cur = df[df["season"] == season].copy()
    cur["_rank"] = cur.groupby(entity)["_order"].rank(method="first", ascending=False) - 1
    cur["weight"] = 0.5 ** (cur["_rank"] / half_life)

    prior = df[df["season"] == season - 1].copy()
    if not prior.empty:
        prior["_rank"] = prior.groupby(entity)["_order"].rank(method="first", ascending=False) - 1
        prior["_raw"] = 0.5 ** (prior["_rank"] / half_life)
        games_this_season = cur.groupby(entity).size()
        g = prior[entity].map(games_this_season).fillna(0)
        total_prior = carryover * carryover / (carryover + g)
        prior["weight"] = prior["_raw"] / prior.groupby(entity)["_raw"].transform("sum")
        prior["weight"] *= total_prior

    season_rows = pd.concat([cur, prior], ignore_index=True)
    season_rows["window"] = "season"
    out.append(season_rows)

    # Last-N windows
    for window in fitting["historyWindows"]:
        if window == "season":
            continue
        n = int(window[1:])
        last = df[df["_recency"] < n].copy()
        last["weight"] = 1.0
        last["window"] = window
        out.append(last)

    result = pd.concat(out, ignore_index=True)
    return result[[entity, "season", "week", "window", "weight"]]


def window_weights(rows: pd.DataFrame, entity: str, season: int) -> pd.DataFrame:
    """Expands rows into (row, window) rows with a `weight` column.

    `rows` needs columns: entity, "season", "week". Only the prior and current season are
    used. Rows with weight 0 are dropped.
    """
    rows = rows[rows["season"].isin([season, season - 1])]
    games = rows[[entity, "season", "week"]].drop_duplicates()
    weights = _game_weights(games, entity, season)
    result = rows.merge(weights, on=[entity, "season", "week"])
    return result[result["weight"] > 0].reset_index(drop=True)
