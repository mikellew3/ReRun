"""Line history (fetch_lines.py) -> each snapshot game's `market`, `lineHistory` and `props`.

`market` holds the current main lines in the engine's MarketLine shape (spreads, totals,
moneylines, first-half lines, team totals): the reference line is the sharp book's (config
lineMovement.sharpBook) when it has one, else the most common current line; each book quoting
that line contributes prices. No-vig probabilities come from the sharp book when it quotes the
line, else the average of the books that do (CLAUDE.md §10.4).

`props` lists each player prop with every book's opening and latest price. Book player names
are matched to the snapshot roster of the two teams; unmatched props keep playerId null.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from datetime import datetime, timedelta
from statistics import mean

from common.config import model_config

MATCH_WINDOW = timedelta(hours=36)

# History market -> (MarketLine market, team-total side or None).
MARKET_NAMES: dict[str, tuple[str, str | None]] = {
    "spreads": ("spreads", None),
    "totals": ("totals", None),
    "h2h": ("h2h", None),
    "spreads_h1": ("spreads_h1", None),
    "totals_h1": ("totals_h1", None),
    "h2h_h1": ("h2h_h1", None),
    "team_totals_home": ("team_totals", "home"),
    "team_totals_away": ("team_totals", "away"),
}


def implied(american: float) -> float:
    return 100 / (american + 100) if american > 0 else -american / (-american + 100)


def implied_payout(american: float) -> float:
    """Decimal odds; higher is better for the bettor."""
    return 1 + (american / 100 if american > 0 else 100 / -american)


def no_vig(a: float, b: float) -> tuple[float, float]:
    """Two-way prices -> no-vig probabilities (multiplicative)."""
    pa, pb = implied(a), implied(b)
    return pa / (pa + pb), pb / (pa + pb)


def _parse(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def find_history(game: dict, history: dict) -> dict | None:
    kickoff = _parse(game["kickoff"])
    for g in history.get("games", {}).values():
        if g["home"] == game["home"] and g["away"] == game["away"]:
            if abs(_parse(g["kickoff"]) - kickoff) <= MATCH_WINDOW:
                return g
    return None


def line_history(entry: dict) -> list[dict]:
    out = []
    for key, ticks in sorted(entry["series"].items()):
        book, market = key.split("|")
        if market in MARKET_NAMES:
            out.append({"book": book, "market": market, "ticks": ticks})
    return out


def market_lines(entry: dict) -> list[dict]:
    sharp = model_config()["lineMovement"]["sharpBook"]
    current: dict[str, dict[str, dict]] = {}  # history market -> book -> last tick
    for key, ticks in entry["series"].items():
        book, market = key.split("|")
        if ticks and market in MARKET_NAMES:
            current.setdefault(market, {})[book] = ticks[-1]

    out: list[dict] = []
    for hist_market, by_book in sorted(current.items()):
        market, side = MARKET_NAMES[hist_market]
        if market.startswith("h2h"):
            ref = None
        elif sharp in by_book:
            ref = by_book[sharp]["line"]
        else:
            ref = Counter(t["line"] for t in by_book.values()).most_common(1)[0][0]
        at_ref = {b: t for b, t in by_book.items() if t["line"] == ref}
        if not at_ref:
            continue
        if sharp in at_ref:
            pa, pb = no_vig(at_ref[sharp]["a"], at_ref[sharp]["b"])
            source = "pinnacle"
        else:
            probs = [no_vig(t["a"], t["b"]) for t in at_ref.values()]
            pa, pb = mean(p[0] for p in probs), mean(p[1] for p in probs)
            source = "consensus"
        over_under = market.startswith(("totals", "team_totals"))
        sel_a, sel_b = ("over", "under") if over_under else ("home", "away")
        for sel, price_key, prob in ((sel_a, "a", pa), (sel_b, "b", pb)):
            prices = [{"book": b, "price": t[price_key]} for b, t in sorted(at_ref.items())]
            line = ref
            if market.startswith("spreads") and sel == "away" and ref is not None:
                line = -ref
            row = {
                "market": market,
                "selection": sel,
                "line": line,
                "prices": prices,
                "best": max(prices, key=lambda p: implied_payout(p["price"])),
                "noVigProb": round(prob, 4),
                "noVigSource": source,
            }
            if side:
                row["side"] = side
            out.append(row)
    return out


# ---------------------------------------------------------------------------
# Props
# ---------------------------------------------------------------------------

SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")


def name_key(name: str) -> str:
    """'Pierre Strong Jr.' -> 'pierre strong'; accents and punctuation dropped."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z ]", " ", ascii_name.lower().replace(".", "").replace("'", ""))
    return " ".join(SUFFIX.sub(" ", s).split())


def initial_key(name: str) -> str:
    """'Cameron Ward' -> 'c ward', so nicknames ('Cam Ward') still match."""
    parts = name_key(name).split()
    return f"{parts[0][0]} {parts[-1]}" if len(parts) >= 2 else ""


def roster_index(players: dict, teams: set[str]) -> dict[str, str]:
    """name key -> playerId for the two teams' players, plus first-initial + last-name keys
    as a fallback. Ambiguous keys are left out."""
    seen: dict[str, list[str]] = {}
    for pid, p in players.items():
        if p.get("team") in teams:
            seen.setdefault(name_key(p["name"]), []).append(pid)
            seen.setdefault("~" + initial_key(p["name"]), []).append(pid)
    return {k: ids[0] for k, ids in seen.items() if len(ids) == 1}


def match_player(name: str, index: dict[str, str]) -> str | None:
    return index.get(name_key(name)) or index.get("~" + initial_key(name))


def game_props(entry: dict, game: dict, players: dict) -> list[dict]:
    index = roster_index(players, {game["home"], game["away"]})
    grouped: dict[tuple[str, str], list[dict]] = {}
    for key, slot in entry.get("props", {}).items():
        book, market, player = key.split("|", 2)
        if "current" not in slot or player.endswith(" Defense"):
            continue  # team defense / special teams TD props are not players
        grouped.setdefault((market, player), []).append(
            {"book": book, "open": slot["open"], "current": slot["current"]}
        )
    out = []
    for (market, player), books in sorted(grouped.items()):
        out.append(
            {
                "playerId": match_player(player, index),
                "player": player,
                "market": market,
                "books": sorted(books, key=lambda b: b["book"]),
            }
        )
    return out


def attach_lines(games: list[dict], history: dict, players: dict | None = None) -> int:
    """Fills market, lineHistory and props in place. Returns how many games got lines."""
    matched = 0
    for game in games:
        entry = find_history(game, history)
        if entry is None:
            continue
        game["market"] = market_lines(entry)
        game["lineHistory"] = line_history(entry)
        if players is not None and entry.get("props"):
            game["props"] = game_props(entry, game, players)
        matched += 1
    return matched
