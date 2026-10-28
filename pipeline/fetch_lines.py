"""Game-line prices and their movement (CLAUDE.md §5, §11).

Two sources, both server-side only:
- SharpAPI (free tier, env SHARPAPI_KEY): DraftKings and FanDuel main lines for spreads,
  totals and moneylines, 60s delayed. Polled often; costs no credits.
- The Odds API (env ODDS_API_KEY): Pinnacle, the sharp reference, a few times a day
  (config oddsApi.sharpPullHoursUtc). 3 credits per pull. Credits left are logged on every
  call, and the pull is skipped below config oddsApi.creditFloor.

Every pull is merged into a history file: per game, per book, per market, a tick is kept only
when the line or a price changes. build_snapshot.py reads the history to fill each game's
`market` (current prices) and `lineHistory`.

    python fetch_lines.py [--pinnacle] [--history pipeline/data/lines/history.json]

In GitHub Actions the history file persists between runs in the Actions cache
(.github/workflows/lines.yml), and is published with each snapshot.
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from common.config import model_config
from common.io import DATA_DIR
from common.teams import abbr

HISTORY_PATH = DATA_DIR / "lines" / "history.json"
SHARPAPI_BASE = "https://api.sharpapi.io/api/v1"
ODDS_API_BASE = "https://api.the-odds-api.com/v4"
# Games are dropped from the history this long after kickoff.
KEEP_AFTER_KICKOFF = timedelta(days=3)

Quote = dict[str, Any]  # {game, home, away, kickoff, book, market, line, a, b, t}


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_time(s: str) -> datetime:
    s = s.replace("Z", "+00:00")
    if len(s) == len("2026-10-30T00:15+00:00"):  # SharpAPI omits seconds
        s = s[:16] + ":00" + s[16:]
    return datetime.fromisoformat(s).astimezone(UTC)


def game_key(away: str, home: str, kickoff: datetime) -> str:
    """Our own id for a game (date in UTC); build_snapshot maps it to the nflverse game id."""
    return f"{kickoff:%Y-%m-%d}_{away}_{home}"


def http_json(url: str, headers: dict[str, str] | None = None) -> tuple[Any, dict[str, str]]:
    req = urllib.request.Request(url, headers={"Accept": "application/json", **(headers or {})})
    last: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8")), dict(resp.headers)
        except urllib.error.HTTPError as err:
            if err.code in (401, 403):  # bad key or plan: retrying won't help
                body = err.read().decode("utf-8", "replace")[:300]
                raise RuntimeError(f"HTTP {err.code}: {body}") from err
            last = err
        except (urllib.error.URLError, TimeoutError) as err:
            last = err
        time.sleep(2**attempt)
    raise RuntimeError(f"GET failed: {last}")


# ---------------------------------------------------------------------------
# SharpAPI: DraftKings + FanDuel
# ---------------------------------------------------------------------------


def sharpapi_rows_to_quotes(rows: list[dict], market: str) -> list[Quote]:
    """Main-line rows (one per selection) -> one quote per (game, book): line + both prices."""
    groups: dict[tuple[str, str], dict[str, dict]] = {}
    for r in rows:
        if not r.get("is_main_line") or r.get("is_live") or not r.get("is_active", True):
            continue
        if r.get("is_stale_pregame_price") or r.get("is_player_prop"):
            continue
        side = (r.get("selection_type") or "").lower()
        if side not in ("home", "away", "over", "under"):
            sel = (r.get("selection") or "").lower()
            side = "over" if sel.startswith("over") else "under" if sel.startswith("under") else ""
        if not side:
            continue
        groups.setdefault((r["event_id"], r["sportsbook"]), {})[side] = r
    quotes = []
    for (_, book), sides in groups.items():
        first, second = ("over", "under") if market == "totals" else ("home", "away")
        if first not in sides or second not in sides:
            continue
        a, b = sides[first], sides[second]
        home = abbr((a.get("home") or {}).get("name") or a.get("home_team", ""))
        away = abbr((a.get("away") or {}).get("name") or a.get("away_team", ""))
        if not home or not away:
            continue
        kickoff = parse_time(a["event_start_time"])
        quotes.append(
            {
                "game": game_key(away, home, kickoff),
                "home": home,
                "away": away,
                "kickoff": iso(kickoff),
                "book": book,
                "market": market,
                "line": None if market == "h2h" else float(a["line"]),
                "a": int(a["odds_american"]),
                "b": int(b["odds_american"]),
                "t": a.get("timestamp") or iso(datetime.now(UTC)),
            }
        )
    return quotes


def fetch_sharpapi(key: str) -> list[Quote]:
    cfg = model_config()["sharpApi"]
    pause = 60 / cfg["requestsPerMinute"] + 0.2
    quotes: list[Quote] = []
    for market_type, market in cfg["marketTypes"].items():
        cursor = None
        while True:
            params = {"league": "nfl", "market_type": market_type, "limit": cfg["pageLimit"]}
            if cursor:
                params["cursor"] = cursor
            url = f"{SHARPAPI_BASE}/odds?{urllib.parse.urlencode(params)}"
            data, _ = http_json(url, {"X-API-Key": key})
            quotes += sharpapi_rows_to_quotes(data.get("data", []), market)
            page = data.get("pagination") or {}
            time.sleep(pause)
            cursor = page.get("next_cursor") if page.get("has_more") else None
            if not cursor:
                break
    print(f"SharpAPI: {len(quotes)} main-line quotes")
    return quotes


# ---------------------------------------------------------------------------
# The Odds API: Pinnacle
# ---------------------------------------------------------------------------


def odds_api_events_to_quotes(events: list[dict], book: str) -> list[Quote]:
    quotes = []
    for ev in events:
        home, away = abbr(ev["home_team"]), abbr(ev["away_team"])
        if not home or not away:
            continue
        kickoff = parse_time(ev["commence_time"])
        for bm in ev.get("bookmakers", []):
            if bm["key"] != book:
                continue
            for mk in bm.get("markets", []):
                market = mk["key"]
                if market not in ("h2h", "spreads", "totals"):
                    continue
                by_name = {o["name"]: o for o in mk["outcomes"]}
                if market == "totals":
                    a, b = by_name.get("Over"), by_name.get("Under")
                else:
                    a, b = by_name.get(ev["home_team"]), by_name.get(ev["away_team"])
                if not a or not b:
                    continue
                quotes.append(
                    {
                        "game": game_key(away, home, kickoff),
                        "home": home,
                        "away": away,
                        "kickoff": iso(kickoff),
                        "book": book,
                        "market": market,
                        "line": None if market == "h2h" else float(a["point"]),
                        "a": int(a["price"]),
                        "b": int(b["price"]),
                        "t": mk.get("last_update") or bm.get("last_update"),
                    }
                )
    return quotes


def fetch_pinnacle(key: str, history: dict) -> list[Quote]:
    cfg = model_config()
    floor = cfg["oddsApi"]["creditFloor"]
    remaining = history.get("oddsApi", {}).get("creditsRemaining")
    if remaining is not None and remaining < floor:
        print(f"The Odds API: {remaining} credits left, below the floor of {floor}; skipping")
        return []
    book = cfg["lineMovement"]["sharpBook"]
    params = {
        "apiKey": key,
        "regions": "eu",
        "markets": "h2h,spreads,totals",
        "bookmakers": book,
        "oddsFormat": "american",
    }
    url = f"{ODDS_API_BASE}/sports/americanfootball_nfl/odds?{urllib.parse.urlencode(params)}"
    events, headers = http_json(url)
    lower = {k.lower(): v for k, v in headers.items()}
    usage = {
        "creditsRemaining": int(lower.get("x-requests-remaining", -1)),
        "creditsUsed": int(lower.get("x-requests-used", -1)),
        "creditsLast": int(lower.get("x-requests-last", -1)),
        "calledAt": iso(datetime.now(UTC)),
    }
    history["oddsApi"] = usage
    print(
        f"The Odds API: {usage['creditsLast']} credits used, "
        f"{usage['creditsRemaining']} left this month"
    )
    quotes = odds_api_events_to_quotes(events, book)
    print(f"The Odds API: {len(quotes)} {book} quotes")
    return quotes


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------


def load_history(path: Path) -> dict:
    if path.exists():
        return json.loads(path.read_text())
    return {"games": {}}


def merge(history: dict, quotes: list[Quote], now: datetime) -> int:
    """Adds a tick wherever a book's line or prices changed. Returns ticks added."""
    added = 0
    games = history.setdefault("games", {})
    for q in quotes:
        g = games.setdefault(
            q["game"], {"home": q["home"], "away": q["away"], "kickoff": q["kickoff"], "series": {}}
        )
        g["kickoff"] = q["kickoff"]
        series = g["series"].setdefault(f"{q['book']}|{q['market']}", [])
        tick = {"t": q["t"], "line": q["line"], "a": q["a"], "b": q["b"]}
        last = series[-1] if series else None
        if last and (last["line"], last["a"], last["b"]) == (tick["line"], tick["a"], tick["b"]):
            continue
        series.append(tick)
        added += 1
    # Forget games long finished.
    for key in [k for k, g in games.items() if parse_time(g["kickoff"]) + KEEP_AFTER_KICKOFF < now]:
        del games[key]
    history["updatedAt"] = iso(now)
    return added


def pinnacle_due(history: dict, now: datetime) -> bool:
    """At a configured UTC hour, and not already pulled in the last 2 hours (the poller runs
    every 30 minutes)."""
    if now.hour not in model_config()["oddsApi"]["sharpPullHoursUtc"]:
        return False
    last = history.get("oddsApi", {}).get("calledAt")
    return last is None or now - parse_time(last) > timedelta(hours=2)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pinnacle", action="store_true", help="also pull Pinnacle (credits)")
    parser.add_argument(
        "--auto-pinnacle",
        action="store_true",
        help="pull Pinnacle only at the configured UTC hours",
    )
    parser.add_argument("--history", type=Path, default=HISTORY_PATH)
    args = parser.parse_args()

    now = datetime.now(UTC)
    history = load_history(args.history)
    quotes: list[Quote] = []

    sharp_key = os.environ.get("SHARPAPI_KEY", "").strip()
    if sharp_key:
        try:
            quotes += fetch_sharpapi(sharp_key)
        except RuntimeError as err:
            print(f"SharpAPI failed: {err}")
    else:
        print("SHARPAPI_KEY not set; skipping DraftKings/FanDuel")

    want_pinnacle = args.pinnacle or (args.auto_pinnacle and pinnacle_due(history, now))
    odds_key = os.environ.get("ODDS_API_KEY", "").strip()
    if want_pinnacle and odds_key:
        try:
            quotes += fetch_pinnacle(odds_key, history)
        except RuntimeError as err:
            print(f"The Odds API failed: {err}")
    elif want_pinnacle:
        print("ODDS_API_KEY not set; skipping Pinnacle")

    added = merge(history, quotes, now)
    args.history.parent.mkdir(parents=True, exist_ok=True)
    args.history.write_text(json.dumps(history, separators=(",", ":")))
    print(f"History: {len(history['games'])} games, {added} new ticks -> {args.history}")


if __name__ == "__main__":
    main()
