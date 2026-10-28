"""Game-time weather forecasts for a slate (CLAUDE.md §5).

- US stadiums: National Weather Service hourly forecast (api.weather.gov, free, no key).
  NWS asks every caller to identify itself with a contact in the User-Agent header.
- International games, or when NWS fails: Open-Meteo (free, no key).
- Domes get no forecast (weather has no effect there).

Conditions are averaged over the game window (config weatherForecast.gameWindowHours from
kickoff). Wind is the sustained mean, temperature the mean, precipitation the kind expected
in the window. Retractable roofs are left as unknown (the engine treats unknown as closed;
users can open the roof in the Sim Lab).

build_snapshot.py calls forecast_for() for every game not yet played when it builds a live
snapshot. Run on its own to print forecasts for a slate:

    python fetch_weather.py --season 2026 --week 9

Contact for the NWS User-Agent: env NWS_CONTACT_EMAIL, else the default below.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime, timedelta
from typing import Any

from common.config import model_config

DEFAULT_CONTACT = "mikellew3@gmail.com"
NWS_BASE = "https://api.weather.gov"
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"

# Time zones served by NWS. Everything else (London, Munich, Mexico City, Sao Paulo, ...)
# goes to Open-Meteo.
NWS_TIMEZONES = {
    "America/New_York",
    "America/Detroit",
    "America/Indiana/Indianapolis",
    "America/Chicago",
    "America/Denver",
    "America/Phoenix",
    "America/Los_Angeles",
}


def user_agent() -> str:
    return f"ReRun (GMDHC; {os.environ.get('NWS_CONTACT_EMAIL', DEFAULT_CONTACT)})"


def http_json(url: str, retries: int = 3) -> Any:
    """GET a JSON document, with a few retries (NWS returns occasional 500s)."""
    req = urllib.request.Request(
        url, headers={"User-Agent": user_agent(), "Accept": "application/geo+json"}
    )
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
            last = err
            time.sleep(2**attempt)
    raise RuntimeError(f"GET {url} failed: {last}")


# ---------------------------------------------------------------------------
# Parsing (pure; unit-tested)
# ---------------------------------------------------------------------------


def parse_wind_mph(text: str | None) -> float:
    """NWS windSpeed: "10 mph", "10 to 15 mph" (-> midpoint), "" or None (-> 0)."""
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", text or "")]
    return sum(nums) / len(nums) if nums else 0.0


def precip_from_forecast(texts: list[str], max_prob: float) -> str:
    """NWS shortForecast texts in the window + highest chance of precipitation (%) -> kind."""
    if max_prob < model_config()["weatherForecast"]["precipProbThreshold"]:
        return "none"
    t = " ".join(texts).lower()
    heavy = "heavy" in t
    if "snow" in t or "flurries" in t or "wintry" in t or "sleet" in t:
        return "heavy_snow" if heavy else "light_snow"
    if any(w in t for w in ("rain", "shower", "drizzle", "thunderstorm", "t-storm")):
        return "heavy_rain" if heavy else "light_rain"
    return "none"


def precip_from_amounts(rain_mm_per_hr: float, snow_cm_per_hr: float) -> str:
    """Open-Meteo hourly amounts averaged over the window -> kind."""
    cfg = model_config()["weatherForecast"]
    # Snowfall is reported in cm of snow; ~1 cm of snow is ~1 mm of water.
    total = rain_mm_per_hr + snow_cm_per_hr
    if total < cfg["lightPrecipMmPerHour"]:
        return "none"
    heavy = total >= cfg["heavyPrecipMmPerHour"]
    if snow_cm_per_hr > rain_mm_per_hr:
        return "heavy_snow" if heavy else "light_snow"
    return "heavy_rain" if heavy else "light_rain"


def game_window(kickoff: datetime) -> tuple[datetime, datetime]:
    hours = model_config()["weatherForecast"]["gameWindowHours"]
    return kickoff, kickoff + timedelta(hours=hours)


def nws_game_weather(periods: list[dict], kickoff: datetime) -> dict | None:
    """NWS hourly periods -> game weather, or None if the forecast doesn't reach the game."""
    start, end = game_window(kickoff)
    inside = [
        p
        for p in periods
        if datetime.fromisoformat(p["startTime"]) < end
        and datetime.fromisoformat(p["endTime"]) > start
    ]
    if not inside:
        return None

    def temp_f(p: dict) -> float:
        t = float(p["temperature"])
        return t * 9 / 5 + 32 if p.get("temperatureUnit") == "C" else t

    probs = [float((p.get("probabilityOfPrecipitation") or {}).get("value") or 0) for p in inside]
    precip = precip_from_forecast([p.get("shortForecast", "") for p in inside], max(probs))
    return {
        "source": "nws",
        "windMph": round(sum(parse_wind_mph(p.get("windSpeed")) for p in inside) / len(inside), 1),
        "gustMph": None,
        "tempF": round(sum(temp_f(p) for p in inside) / len(inside), 1),
        "precip": precip,
        # The engine applies this share of the precipitation effect (CLAUDE.md §9.7).
        "precipChance": round(max(probs) / 100, 2) if precip != "none" else 0.0,
        "roofExpected": None,
    }


def open_meteo_game_weather(data: dict, kickoff: datetime) -> dict | None:
    """Open-Meteo hourly response (UTC times) -> game weather."""
    h = data.get("hourly") or {}
    times = [datetime.fromisoformat(t).replace(tzinfo=UTC) for t in h.get("time", [])]
    start, end = game_window(kickoff)
    idx = [i for i, t in enumerate(times) if start <= t < end]
    if not idx:
        return None

    def mean(key: str) -> float:
        vals = [h[key][i] for i in idx if h.get(key) and h[key][i] is not None]
        return sum(vals) / len(vals) if vals else 0.0

    gusts = [h["wind_gusts_10m"][i] for i in idx if h.get("wind_gusts_10m")]
    return {
        "source": "open-meteo",
        "windMph": round(mean("wind_speed_10m"), 1),
        "gustMph": round(max(gusts), 1) if gusts else None,
        "tempF": round(mean("temperature_2m"), 1),
        "precip": precip_from_amounts(mean("rain") + mean("showers"), mean("snowfall")),
        "roofExpected": None,
    }


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------


def nws_forecast(lat: float, lon: float, kickoff: datetime) -> dict | None:
    point = http_json(f"{NWS_BASE}/points/{lat:.4f},{lon:.4f}")
    hourly_url = point["properties"]["forecastHourly"]
    periods = http_json(hourly_url)["properties"]["periods"]
    return nws_game_weather(periods, kickoff)


def open_meteo_forecast(lat: float, lon: float, kickoff: datetime) -> dict | None:
    query = urllib.parse.urlencode(
        {
            "latitude": f"{lat:.4f}",
            "longitude": f"{lon:.4f}",
            "hourly": "temperature_2m,wind_speed_10m,wind_gusts_10m,rain,showers,snowfall",
            "temperature_unit": "fahrenheit",
            "wind_speed_unit": "mph",
            "timezone": "UTC",
            "forecast_days": 16,
        }
    )
    return open_meteo_game_weather(http_json(f"{OPEN_METEO}?{query}"), kickoff)


def forecast_for(stadium: dict, kickoff: datetime, now: datetime | None = None) -> dict | None:
    """Forecast for one game. stadium: snapshot StadiumFacts. None for domes, games too far
    out, or when every source fails (the engine then uses mild defaults)."""
    if stadium["roof"] == "dome":
        return None
    now = now or datetime.now(UTC)
    if kickoff - now > timedelta(days=model_config()["weatherForecast"]["maxLeadDays"]):
        return None
    lat, lon = float(stadium["lat"]), float(stadium["lon"])
    if stadium["tz"] in NWS_TIMEZONES:
        try:
            got = nws_forecast(lat, lon, kickoff)
            if got is not None:
                return got
        except (RuntimeError, KeyError) as err:
            print(f"NWS failed for {stadium['name']}: {err}; trying Open-Meteo")
    try:
        return open_meteo_forecast(lat, lon, kickoff)
    except (RuntimeError, KeyError) as err:
        print(f"Open-Meteo failed for {stadium['name']}: {err}; no forecast")
        return None


def main() -> None:
    from build_snapshot import Stadiums, kickoff_utc
    from common.io import read_raw

    parser = argparse.ArgumentParser(description="Print game-time forecasts for a slate.")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=int, required=True)
    args = parser.parse_args()
    sched = read_raw("schedules", [args.season])
    stadiums = Stadiums()
    for _, g in sched[sched["week"] == args.week].iterrows():
        site = Stadiums.facts(stadiums.find(g["stadium"], g["stadium_id"]))
        kickoff = kickoff_utc(g["gameday"], g["gametime"])
        print(g["game_id"], site["roof"], forecast_for(site, kickoff))


if __name__ == "__main__":
    main()
