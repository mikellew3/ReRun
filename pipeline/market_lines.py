"""Line history (fetch_lines.py) -> each snapshot game's `market` and `lineHistory`.

`market` holds the current main lines in the engine's MarketLine shape: for spreads and totals
the reference line is the sharp book's (config lineMovement.sharpBook) when it has one, else
the most common current line; each book quoting that line contributes prices. No-vig
probabilities come from the sharp book when it quotes the line, else the average of the books
that do (CLAUDE.md §10.4).
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta
from statistics import mean

from common.config import model_config

MATCH_WINDOW = timedelta(hours=36)


def implied(american: float) -> float:
    return 100 / (american + 100) if american > 0 else -american / (-american + 100)


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
        out.append({"book": book, "market": market, "ticks": ticks})
    return out


def market_lines(entry: dict) -> list[dict]:
    sharp = model_config()["lineMovement"]["sharpBook"]
    current: dict[str, dict[str, dict]] = {}  # market -> book -> last tick
    for key, ticks in entry["series"].items():
        book, market = key.split("|")
        if ticks:
            current.setdefault(market, {})[book] = ticks[-1]

    out: list[dict] = []
    for market, by_book in sorted(current.items()):
        if market == "h2h":
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
        sel_a, sel_b = ("over", "under") if market == "totals" else ("home", "away")
        for sel, price_key, prob in ((sel_a, "a", pa), (sel_b, "b", pb)):
            prices = [{"book": b, "price": t[price_key]} for b, t in sorted(at_ref.items())]
            line = ref
            if market == "spreads" and sel == "away" and ref is not None:
                line = -ref
            out.append(
                {
                    "market": market,
                    "selection": sel,
                    "line": line,
                    "prices": prices,
                    "best": max(prices, key=lambda p: implied_payout(p["price"])),
                    "noVigProb": round(prob, 4),
                    "noVigSource": source,
                }
            )
    return out


def implied_payout(american: float) -> float:
    """Decimal odds; higher is better for the bettor."""
    return 1 + (american / 100 if american > 0 else 100 / -american)


def attach_lines(games: list[dict], history: dict) -> int:
    """Fills market and lineHistory in place. Returns how many games got lines."""
    matched = 0
    for game in games:
        entry = find_history(game, history)
        if entry is None:
            continue
        game["market"] = market_lines(entry)
        game["lineHistory"] = line_history(entry)
        matched += 1
    return matched
