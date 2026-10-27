from datetime import UTC, datetime, timedelta

import fetch_weather as fw

KICKOFF = datetime(2026, 11, 1, 18, 0, tzinfo=UTC)


def nws_period(hour: int, wind: str, temp: int, pop: int, text: str) -> dict:
    start = KICKOFF + timedelta(hours=hour)
    return {
        "startTime": start.isoformat(),
        "endTime": (start + timedelta(hours=1)).isoformat(),
        "temperature": temp,
        "temperatureUnit": "F",
        "windSpeed": wind,
        "probabilityOfPrecipitation": {"unitCode": "wmoUnit:percent", "value": pop},
        "shortForecast": text,
    }


def test_parse_wind():
    assert fw.parse_wind_mph("10 mph") == 10
    assert fw.parse_wind_mph("10 to 20 mph") == 15
    assert fw.parse_wind_mph("") == 0
    assert fw.parse_wind_mph(None) == 0


def test_nws_game_window_average():
    periods = [
        nws_period(-2, "30 mph", 10, 90, "Heavy Snow"),  # before kickoff: ignored
        nws_period(0, "18 mph", 30, 20, "Cloudy"),
        nws_period(1, "20 to 24 mph", 28, 60, "Chance Rain Showers"),
        nws_period(2, "20 mph", 26, 70, "Rain Showers"),
        nws_period(5, "5 mph", 20, 0, "Clear"),  # after the window: ignored
    ]
    w = fw.nws_game_weather(periods, KICKOFF)
    assert w["source"] == "nws"
    assert w["windMph"] == round((18 + 22 + 20) / 3, 1)
    assert w["tempF"] == 28.0
    assert w["precip"] == "light_rain"
    assert w["roofExpected"] is None


def test_nws_precip_needs_a_real_chance():
    assert fw.precip_from_forecast(["Slight Chance Rain"], 20) == "none"
    assert fw.precip_from_forecast(["Heavy Rain"], 80) == "heavy_rain"
    assert fw.precip_from_forecast(["Snow Showers"], 60) == "light_snow"
    assert fw.precip_from_forecast(["Sunny"], 90) == "none"


def test_nws_forecast_that_does_not_reach_the_game():
    assert fw.nws_game_weather([nws_period(-10, "5 mph", 50, 0, "Sunny")], KICKOFF) is None


def test_open_meteo_game_weather():
    times = [(KICKOFF + timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M") for h in range(-2, 6)]
    data = {
        "hourly": {
            "time": times,
            "temperature_2m": [40, 40, 34, 33, 32, 31, 30, 30],
            "wind_speed_10m": [5, 5, 12, 14, 16, 18, 5, 5],
            "wind_gusts_10m": [9, 9, 20, 25, 30, 32, 9, 9],
            "rain": [0, 0, 0, 0, 0, 0, 0, 0],
            "showers": [0, 0, 0, 0, 0, 0, 0, 0],
            "snowfall": [0, 0, 0.6, 0.8, 1.0, 0.4, 0, 0],
        }
    }
    w = fw.open_meteo_game_weather(data, KICKOFF)
    assert w["source"] == "open-meteo"
    # Window = kickoff hour and the two after it.
    assert w["windMph"] == 14.0
    assert w["gustMph"] == 30
    assert w["precip"] == "light_snow"


def test_precip_from_amounts():
    assert fw.precip_from_amounts(0.1, 0) == "none"
    assert fw.precip_from_amounts(1.0, 0) == "light_rain"
    assert fw.precip_from_amounts(5.0, 0) == "heavy_rain"
    assert fw.precip_from_amounts(0, 5.0) == "heavy_snow"


STADIUM = {
    "name": "Test Field",
    "roof": "outdoors",
    "lat": 42.77,
    "lon": -78.79,
    "tz": "America/New_York",
}


def test_forecast_skips_domes_and_far_games():
    dome = {**STADIUM, "roof": "dome"}
    assert fw.forecast_for(dome, KICKOFF, now=KICKOFF - timedelta(days=1)) is None
    assert fw.forecast_for(STADIUM, KICKOFF, now=KICKOFF - timedelta(days=10)) is None


def test_forecast_falls_back_to_open_meteo(monkeypatch):
    calls = []

    def fake_http(url: str, retries: int = 3):
        calls.append(url)
        if "weather.gov" in url:
            raise RuntimeError("503")
        hours = [(KICKOFF + timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M") for h in range(3)]
        return {
            "hourly": {
                "time": hours,
                "temperature_2m": [50, 50, 50],
                "wind_speed_10m": [10, 10, 10],
                "rain": [0, 0, 0],
                "showers": [0, 0, 0],
                "snowfall": [0, 0, 0],
            }
        }

    monkeypatch.setattr(fw, "http_json", fake_http)
    w = fw.forecast_for(STADIUM, KICKOFF, now=KICKOFF - timedelta(days=1))
    assert w["source"] == "open-meteo"
    assert any("weather.gov" in c for c in calls)


def test_international_games_use_open_meteo(monkeypatch):
    seen = []
    monkeypatch.setattr(fw, "open_meteo_forecast", lambda lat, lon, k: seen.append("om") or {})
    monkeypatch.setattr(fw, "nws_forecast", lambda lat, lon, k: seen.append("nws") or {})
    london = {**STADIUM, "tz": "Europe/London"}
    fw.forecast_for(london, KICKOFF, now=KICKOFF - timedelta(days=1))
    assert seen == ["om"]


def test_user_agent_has_contact(monkeypatch):
    monkeypatch.delenv("NWS_CONTACT_EMAIL", raising=False)
    assert fw.DEFAULT_CONTACT in fw.user_agent()
