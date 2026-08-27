from pathlib import Path

from seatbot.config import load_config


def test_example_config_loads():
    cfg = load_config(Path(__file__).resolve().parents[1] / "config.example.yaml")
    assert cfg.dept_id_enc == "214d62ddb0e920e7"
    assert cfg.booking.retry_interval_seconds >= 0.5
