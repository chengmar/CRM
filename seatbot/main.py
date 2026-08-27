from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

from .client import CaptchaRequired, ChaoxingClient, ChaoxingError, LoginError
from .config import AppConfig, ConfigError, load_config

TZ = ZoneInfo("Asia/Shanghai")
LOG = logging.getLogger("seatbot")


def _load_environment() -> None:
    candidates = [
        Path.cwd() / ".env",
        Path(__file__).resolve().parents[1] / ".env",
        Path("/etc/chaoxing-seatbot/seatbot.env"),
    ]
    for path in candidates:
        if path.exists():
            load_dotenv(path, override=False)


def _credentials() -> tuple[str, str]:
    username = (os.getenv("CX_USERNAME") or "").strip()
    password = os.getenv("CX_PASSWORD") or ""
    if not username or not password:
        raise ConfigError("缺少 CX_USERNAME/CX_PASSWORD；请写入 .env 或 /etc/chaoxing-seatbot/seatbot.env")
    return username, password


def _client_and_login(config: AppConfig) -> ChaoxingClient:
    username, password = _credentials()
    client = ChaoxingClient(tls_verify=config.tls_verify)
    client.login(username, password, config.dept_id_enc)
    return client


def cmd_rooms(config: AppConfig) -> int:
    client = _client_and_login(config)
    rooms = client.list_rooms(config.dept_id_enc)
    if not rooms:
        print("没有读取到房间。")
        return 2
    print("room_id\t位置")
    for room in rooms:
        names = [
            str(room.get("firstLevelName") or "").strip(),
            str(room.get("secondLevelName") or "").strip(),
            str(room.get("thirdLevelName") or "").strip(),
        ]
        location = " - ".join(x for x in names if x)
        print(f"{room.get('id')}\t{location}")
    return 0


def cmd_seats(config: AppConfig, room_id: str) -> int:
    client = _client_and_login(config)
    data = client.get_seat_grid(room_id)
    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


def cmd_check(config: AppConfig) -> int:
    client = _client_and_login(config)
    rooms = client.list_rooms(config.dept_id_enc)
    print(f"登录成功；读取到 {len(rooms)} 个房间。")
    return 0


def cmd_reserve(config: AppConfig, *, dry_run: bool = False) -> int:
    now = datetime.now(TZ)
    booking = config.booking
    if now.strftime("%A") not in booking.weekdays:
        LOG.info("今天未配置执行预约：%s", now.strftime("%A"))
        return 0
    if not booking.choices:
        raise ConfigError("尚未配置 choices。先运行 rooms 获取 room_id，再填写座位号。")

    day = (now.date() + timedelta(days=booking.day_offset)).isoformat()
    if dry_run:
        print(
            json.dumps(
                {
                    "day": day,
                    "start_time": booking.start_time,
                    "end_time": booking.end_time,
                    "choices": [
                        {"room_id": c.room_id, "seats": list(c.seats)} for c in booking.choices
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    client = _client_and_login(config)
    last_message = ""
    for choice in booking.choices:
        for seat in choice.seats:
            for attempt in range(1, booking.attempts_per_seat + 1):
                LOG.info(
                    "尝试预约 day=%s room=%s seat=%s (%s/%s)",
                    day,
                    choice.room_id,
                    seat,
                    attempt,
                    booking.attempts_per_seat,
                )
                ok, data = client.reserve(
                    room_id=choice.room_id,
                    seat_num=seat,
                    start_time=booking.start_time,
                    end_time=booking.end_time,
                    day=day,
                )
                last_message = json.dumps(data, ensure_ascii=False)
                if ok:
                    print(f"预约成功：{day} {booking.start_time}-{booking.end_time}，room={choice.room_id}，seat={seat}")
                    return 0
                LOG.warning("预约未成功：%s", last_message)
                if attempt < booking.attempts_per_seat:
                    time.sleep(booking.retry_interval_seconds)
    print(f"所有候选座位均未预约成功。最后返回：{last_message}", file=sys.stderr)
    return 3


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="超星图书馆座位预约脚本")
    parser.add_argument(
        "--config",
        default=os.getenv("SEATBOT_CONFIG", "config.yaml"),
        help="YAML 配置文件路径",
    )
    parser.add_argument("--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("rooms", help="登录并列出房间 room_id")
    seats = sub.add_parser("seats", help="读取指定房间的原始座位网格")
    seats.add_argument("room_id", help="房间 ID，例如三楼为 3748")
    sub.add_parser("check", help="检查账号登录和房间读取")
    reserve = sub.add_parser("reserve", help="执行一次预约")
    reserve.add_argument("--dry-run", action="store_true", help="只显示计划，不发送预约请求")
    return parser


def main() -> int:
    _load_environment()
    args = build_parser().parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    try:
        config = load_config(args.config)
        if args.command == "rooms":
            return cmd_rooms(config)
        if args.command == "seats":
            return cmd_seats(config, args.room_id)
        if args.command == "check":
            return cmd_check(config)
        if args.command == "reserve":
            return cmd_reserve(config, dry_run=args.dry_run)
        return 2
    except CaptchaRequired as exc:
        LOG.error("%s", exc)
        return 4
    except (ConfigError, LoginError, ChaoxingError) as exc:
        LOG.error("%s", exc)
        return 2
    except Exception:
        LOG.exception("未处理异常")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
