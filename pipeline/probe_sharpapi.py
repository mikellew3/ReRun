"""One-off: print what SharpAPI returns for NFL odds, books and events, so the odds job can
be written against the real response. Prints status codes, rate-limit headers, the top-level
shape and a couple of sample records. Never prints the key.

    SHARPAPI_KEY=... python probe_sharpapi.py
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

BASE = "https://api.sharpapi.io/api/v1"
PATHS = [
    "/odds?league=nfl&limit=1",
    "/odds?league=nfl&sportsbook=pinnacle&limit=2",
    "/odds?league=nfl&market_type=point_spread&limit=4",
]


def shape(x, depth: int = 0):
    """Type outline of a JSON value (keys and types, first list item only)."""
    if depth > 4:
        return "..."
    if isinstance(x, dict):
        return {k: shape(v, depth + 1) for k, v in list(x.items())[:40]}
    if isinstance(x, list):
        return [shape(x[0], depth + 1), f"({len(x)} items)"] if x else []
    return type(x).__name__


def get(path: str, key: str) -> None:
    req = urllib.request.Request(
        BASE + path, headers={"X-API-Key": key, "Accept": "application/json"}
    )
    print(f"\n===== GET {path}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status, headers, body = resp.status, resp.headers, resp.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        status, headers, body = err.code, err.headers, err.read().decode("utf-8", "replace")
    print("status:", status)
    for h, v in headers.items():
        if any(s in h.lower() for s in ("ratelimit", "rate-limit", "remaining", "quota", "credit")):
            print(f"header {h}: {v}")
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        print("body (not JSON):", body[:500])
        return
    print("shape:", json.dumps(shape(data), indent=1)[:4000])
    sample = data
    if isinstance(data, dict):
        for k in ("data", "splits", "results", "events"):
            if isinstance(data.get(k), list):
                sample = data[k]
                break
    if isinstance(data, dict) and "meta" in data:
        print("meta:", json.dumps(data["meta"], indent=1))
    if isinstance(data, dict) and "pagination" in data:
        print("pagination:", json.dumps(data["pagination"]))
    if isinstance(sample, list):
        print("samples:", json.dumps(sample[:2], indent=1)[:5000])
    else:
        print("body:", json.dumps(data, indent=1)[:3000])


def market_census(key: str) -> None:
    """Pages through NFL odds and counts market types (main lines vs alternates)."""
    from collections import Counter

    counts: Counter = Counter()
    url = f"{BASE}/odds?league=nfl&limit=500"
    pages = 0
    while url and pages < 8:
        req = urllib.request.Request(url, headers={"X-API-Key": key})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        for r in data.get("data", []):
            counts[(r["market_type"], r["is_main_line"], r["is_player_prop"], r["sportsbook"])] += 1
        pages += 1
        cursor = (data.get("pagination") or {}).get("next_cursor")
        has_more = (data.get("pagination") or {}).get("has_more")
        url = f"{BASE}/odds?league=nfl&limit=500&cursor={cursor}" if has_more and cursor else None
        print("page", pages, "rows", len(data.get("data", [])), "limit", data.get("pagination"))
    print("\nmarket_type | main | prop | book | rows")
    for k, v in sorted(counts.items()):
        if not k[2]:
            print(*k, v, sep=" | ")
    print("player-prop rows:", sum(v for k, v in counts.items() if k[2]))


def main() -> None:
    key = os.environ.get("SHARPAPI_KEY", "").strip()
    if not key:
        raise SystemExit("SHARPAPI_KEY is not set")
    market_census(key)


if __name__ == "__main__":
    main()
