"""Loads model_config.json, the Python copy of engine/src/config/model.config.ts.

Never edit model_config.json by hand. Change model.config.ts and run `npm run export-config`.
"""

import json
from functools import cache
from pathlib import Path
from typing import Any

MODEL_CONFIG_PATH = Path(__file__).resolve().parent.parent / "model_config.json"


@cache
def load_config_file() -> dict[str, Any]:
    """The whole exported file: configHash, engineVersion and model."""
    with MODEL_CONFIG_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def model_config() -> dict[str, Any]:
    """The MODEL_CONFIG object."""
    return load_config_file()["model"]


def config_hash() -> str:
    """Hash of MODEL_CONFIG, written into every snapshot."""
    return load_config_file()["configHash"]


def history_windows() -> list[str]:
    """History windows the pipeline publishes params for, e.g. ["season", "L3", ...]."""
    return list(model_config()["fitting"]["historyWindows"])
