"""Inspects SharpAPI responses, so pipeline code is written against real data. Never prints
the key. Driven by environment variables (set from the "API probe" workflow's inputs):

    PROBE_MODE=paths   PROBE_PATHS="/odds?league=nfl&limit=2,/sports"
        GET each path; print status, rate-limit headers, the JSON shape and two samples.
    PROBE_MODE=census  PROBE_QUERY="league=nfl"  PROBE_PAGES=20
        Page through /odds and count rows by (market_type, main line, player prop, book).

    SHARPAPI_KEY=... PROBE_MODE=paths PROBE_PATHS=/account python probe_sharpapi.py
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from collections import Counter

BASE = "https://api.sharpapi.io/api/v1"


def shape(x, depth: int = 0):
    """Type outline of a JSON value (keys and types, first list item only)."""
    if depth > 4:
        return "..."
    if isinstance(x, dict):
        return {k: shape(v, depth + 1) for k, v in list(x.items())[:40]}
    if isinstance(x, list):
        return [shape(x[0], depth + 1), f"({len(x)} items)"] if x else []
    return type(x).__name__


def fetch(path: str, key: str) -> tuple[int, dict, object]:
    req = urllib.request.Request(
        BASE + path, headers={"X-API-Key": key, "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status, headers, body = resp.status, dict(resp.headers), resp.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        status, headers, body = err.code, dict(err.headers), err.read().decode("utf-8", "replace")
    try:
        return status, headers, json.loads(body)
    except json.JSONDecodeError:
        return status, headers, body[:500]


def show(path: str, key: str) -> None:
    status, headers, data = fetch(path, key)
    print(f"\n===== GET {path}\nstatus: {status}")
    for h, v in headers.items():
        if "ratelimit" in h.lower():
            print(f"header {h}: {v}")
    if not isinstance(data, (dict, list)):
        print("body:", data)
        return
    print("shape:", json.dumps(shape(data), indent=1)[:3000])
    if isinstance(data, dict):
        for k in ("meta", "pagination"):
            if k in data:
                print(f"{k}:", json.dumps(data[k])[:800])
        rows = data.get("data")
        if isinstance(rows, list):
            print("samples:", json.dumps(rows[:2], indent=1)[:4000])
        elif rows is not None:
            print("data:", json.dumps(rows, indent=1)[:4000])


def census(key: str, query: str, pages: int) -> None:
    counts: Counter = Counter()
    path = f"/odds?{query}&limit=200"
    for page in range(1, pages + 1):
        status, _, data = fetch(path, key)
        if status != 200 or not isinstance(data, dict):
            print("stopped:", status, str(data)[:300])
            break
        rows = data.get("data", [])
        events = {r["event_id"] for r in rows}
        for r in rows:
            counts[(r["market_type"], r["is_main_line"], r["is_player_prop"], r["sportsbook"])] += 1
        info = data.get("pagination") or {}
        print(f"page {page}: {len(rows)} rows, events {sorted(events)[:3]}")
        if not info.get("has_more") or not info.get("next_cursor"):
            break
        path = f"/odds?{query}&limit=200&cursor={info['next_cursor']}"
        time.sleep(5.2)  # free tier: 12 requests/minute
    print("\nmarket_type | main | prop | book | rows")
    for k, v in sorted(counts.items()):
        print(*k, v, sep=" | ")


def main() -> None:
    key = os.environ.get("SHARPAPI_KEY", "").strip()
    if not key:
        raise SystemExit("SHARPAPI_KEY is not set")
    mode = os.environ.get("PROBE_MODE", "paths")
    if mode == "census":
        census(
            key,
            os.environ.get("PROBE_QUERY", "league=nfl"),
            int(os.environ.get("PROBE_PAGES", "8")),
        )
    else:
        for path in filter(None, os.environ.get("PROBE_PATHS", "/account").split(",")):
            show(path.strip(), key)


if __name__ == "__main__":
    main()
