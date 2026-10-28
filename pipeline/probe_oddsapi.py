"""One-off: check the The Odds API key, the plan's remaining credits and whether Pinnacle NFL
lines come back. Uses about 1 credit. Never prints the key.

    ODDS_API_KEY=... python probe_oddsapi.py
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://api.the-odds-api.com/v4"


def get(path: str, params: dict[str, str]) -> None:
    key = os.environ.get("ODDS_API_KEY", "").strip()
    if not key:
        raise SystemExit("ODDS_API_KEY is not set")
    url = f"{BASE}{path}?{urllib.parse.urlencode({**params, 'apiKey': key})}"
    print(f"\n===== GET {path} {params}")
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            status, headers, body = resp.status, resp.headers, resp.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        status, headers, body = err.code, err.headers, err.read().decode("utf-8", "replace")
    print("status:", status)
    for h in ("x-requests-remaining", "x-requests-used", "x-requests-last"):
        print(f"{h}: {headers.get(h)}")
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        print("body (not JSON):", body[:300])
        return
    if isinstance(data, list):
        print("items:", len(data))
        print("sample:", json.dumps(data[:1], indent=1)[:2500])
    else:
        print("body:", json.dumps(data)[:500])


def main() -> None:
    get("/sports", {})  # free: 0 credits
    get(
        "/sports/americanfootball_nfl/odds",
        {"regions": "eu", "markets": "spreads", "bookmakers": "pinnacle", "oddsFormat": "american"},
    )


if __name__ == "__main__":
    main()
