import re

from common.config import config_hash, history_windows, load_config_file, model_config


def test_file_is_generated_export():
    data = load_config_file()
    assert data["_generated"].startswith("by jobs/exportConfig.ts")
    assert set(data) == {"_generated", "configHash", "engineVersion", "model"}


def test_config_hash_format():
    assert re.fullmatch(r"[0-9a-f]{16}", config_hash())


def test_history_windows():
    assert history_windows() == ["season", "L3", "L4", "L5", "L6", "L7", "L8"]


def test_sections_the_pipeline_needs_exist():
    cfg = model_config()
    for section in ("fitting", "shrinkage", "injuries", "markets", "oddsApi"):
        assert section in cfg, section
    assert cfg["oddsApi"]["creditFloor"] > 0
