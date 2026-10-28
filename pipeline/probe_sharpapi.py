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
    "/books",
    "/sportsbooks",
    "/odds?league=nfl",
    "/events?league=nfl",
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
    if isinstance(sample, list):
        print("samples:", json.dumps(sample[:2], indent=1)[:5000])
    else:
        print("body:", json.dumps(data, indent=1)[:3000])


def main() -> None:
    key = os.environ.get("SHARPAPI_KEY", "").strip()
    if not key:
        raise SystemExit("SHARPAPI_KEY is not set")
    for path in PATHS:
        get(path, key)


if __name__ == "__main__":
    main()
