"""File locations and read/write helpers for pipeline working data.

Everything under pipeline/data/ is generated and gitignored:
  data/raw/{dataset}_{season}.parquet   nflverse downloads (fetch_nflverse.py)
  data/raw/manifest.json                when each dataset was fetched
  data/fits/{season}-W{week:02d}/       fitted params for one slate (fit_*.py)
  data/snapshots/{snapshot_id}.json     published slate snapshots (build_snapshot.py)
"""

import json
import math
from pathlib import Path
from typing import Any

import pandas as pd

PIPELINE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = PIPELINE_DIR / "data"
RAW_DIR = DATA_DIR / "raw"
FITS_DIR = DATA_DIR / "fits"
SNAPSHOTS_DIR = DATA_DIR / "snapshots"
STADIUMS_CSV = PIPELINE_DIR / "stadiums.csv"
MANIFEST_PATH = RAW_DIR / "manifest.json"


def raw_path(dataset: str, season: int | None = None) -> Path:
    name = dataset if season is None else f"{dataset}_{season}"
    return RAW_DIR / f"{name}.parquet"


def read_raw(dataset: str, seasons: list[int], columns: list[str] | None = None) -> pd.DataFrame:
    """Reads one nflverse dataset for several seasons. Missing seasons are skipped."""
    frames = []
    for season in seasons:
        path = raw_path(dataset, season)
        if path.exists():
            frames.append(pd.read_parquet(path, columns=columns))
    if not frames:
        raise FileNotFoundError(
            f"No raw {dataset} data for seasons {seasons}. Run fetch_nflverse.py first."
        )
    return pd.concat(frames, ignore_index=True)


def fits_dir(season: int, week: int) -> Path:
    return FITS_DIR / f"{season}-W{week:02d}"


def round_floats(value: Any, decimals: int) -> Any:
    """Rounds every float in a nested structure; NaN and inf become None."""
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return round(value, decimals)
    if isinstance(value, dict):
        return {k: round_floats(v, decimals) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [round_floats(v, decimals) for v in value]
    return value


def write_json(path: Path, data: Any, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        if compact:
            json.dump(data, f, separators=(",", ":"), allow_nan=False)
        else:
            json.dump(data, f, indent=2, allow_nan=False)
            f.write("\n")


def read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def read_manifest() -> dict[str, str]:
    return read_json(MANIFEST_PATH) if MANIFEST_PATH.exists() else {}
