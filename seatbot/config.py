from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class SeatChoice:
    room_id: str
    seats: tuple[str, ...]


@dataclass(frozen=True)
class BookingConfig:
    day_offset: int
    start_time: str
    end_time: str
    weekdays: tuple[str, ...]
    attempts_per_seat: int
    retry_interval_seconds: float
    choices: tuple[SeatChoice, ...]


@dataclass(frozen=True)
class AppConfig:
    dept_id_enc: str
    tls_verify: bool
    booking: BookingConfig


def _require_time(value: Any, name: str) -> str:
    text = str(value or "")
    parts = text.split(":")
    if len(parts) != 2:
        raise ConfigError(f"{name} 必须是 HH:MM")
    try:
        hour, minute = map(int, parts)
    except ValueError as exc:
        raise ConfigError(f"{name} 必须是 HH:MM") from exc
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ConfigError(f"{name} 时间无效: {text}")
    return f"{hour:02d}:{minute:02d}"


def load_config(path: str | Path) -> AppConfig:
    p = Path(path)
    if not p.exists():
        raise ConfigError(f"配置文件不存在: {p}")
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    dept_id_enc = str(raw.get("dept_id_enc") or "").strip()
    if not dept_id_enc:
        raise ConfigError("dept_id_enc 不能为空")

    b = raw.get("booking") or {}
    day_offset = int(b.get("day_offset", 1))
    if day_offset not in (0, 1, 2, 3):
        raise ConfigError("day_offset 仅允许 0~3")

    attempts = int(b.get("attempts_per_seat", 2))
    if not 1 <= attempts <= 5:
        raise ConfigError("attempts_per_seat 仅允许 1~5")

    interval = max(float(b.get("retry_interval_seconds", 1.0)), 0.5)
    weekdays = tuple(str(x) for x in (b.get("weekdays") or []))
    valid_days = {"Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"}
    if not weekdays or any(day not in valid_days for day in weekdays):
        raise ConfigError("weekdays 配置无效")

    choices: list[SeatChoice] = []
    for item in b.get("choices") or []:
        room_id = str(item.get("room_id") or "").strip()
        seats = tuple(str(x).strip() for x in (item.get("seats") or []) if str(x).strip())
        if room_id and seats:
            choices.append(SeatChoice(room_id=room_id, seats=seats))

    return AppConfig(
        dept_id_enc=dept_id_enc,
        tls_verify=bool(raw.get("tls_verify", True)),
        booking=BookingConfig(
            day_offset=day_offset,
            start_time=_require_time(b.get("start_time", "08:00"), "start_time"),
            end_time=_require_time(b.get("end_time", "22:00"), "end_time"),
            weekdays=weekdays,
            attempts_per_seat=attempts,
            retry_interval_seconds=interval,
            choices=tuple(choices),
        ),
    )
