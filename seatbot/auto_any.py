from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

from .client import ChaoxingClient
from .config import load_config
from .crypto import verify_param

TZ = ZoneInfo("Asia/Shanghai")
BASE = "https://office.chaoxing.com"


def load_environment() -> None:
    for path in (
        Path.cwd() / ".env",
        Path(__file__).resolve().parents[1] / ".env",
        Path("/etc/chaoxing-seatbot/seatbot.env"),
    ):
        if path.exists():
            load_dotenv(path, override=False)


def discover_fid_enc(client: ChaoxingClient, dept_id_enc: str) -> str:
    url = f"{BASE}/front/third/apps/seat/list?deptIdEnc={dept_id_enc}"
    response = client.session.get(
        url,
        headers=client.office_headers,
        timeout=12,
        verify=client.verify,
    )
    response.raise_for_status()
    patterns = (
        r"loadData\(['\"]data/apps/seat/config['\"],\s*\{\s*fidEnc\s*:\s*['\"]([A-Za-z0-9_-]+)['\"]",
        r"fidEnc\s*:\s*['\"]([A-Za-z0-9_-]+)['\"]",
    )
    for pattern in patterns:
        match = re.search(pattern, response.text, re.I)
        if match and match.group(1) != dept_id_enc:
            return match.group(1)
    raise RuntimeError("未能从座位列表页解析 fidEnc")


def room_info(
    client: ChaoxingClient,
    room_id: str,
    day: str,
    fid_enc: str,
) -> dict:
    response = client.session.post(
        f"{BASE}/data/apps/seat/room/info",
        data={
            "id": room_id,
            "toDay": day,
            "fidEnc": fid_enc,
            "queryReserve": "true",
        },
        headers=client.office_headers,
        timeout=12,
        verify=client.verify,
    )
    response.raise_for_status()
    data = response.json()
    if not data.get("success"):
        raise RuntimeError(f"读取房间信息失败: {data}")
    return data


def candidate_seats(info: dict) -> list[str]:
    attrs = ((info.get("data") or {}).get("seatAttributes") or [])
    enabled = [
        str(item.get("seatNum")).strip()
        for item in attrs
        if item.get("seatNum") is not None and int(item.get("isReserve", 1)) == 1
    ]
    if not enabled:
        enabled = [
            str(item.get("seatNum")).strip()
            for item in attrs
            if item.get("seatNum") is not None
        ]
    return sorted(set(enabled), key=lambda x: (not x.isdigit(), int(x) if x.isdigit() else x))


def _add_seat_values(value: object, output: set[str]) -> None:
    if isinstance(value, (str, int)):
        text = str(value).strip()
        if text:
            output.add(text)
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, (str, int)):
                text = str(item).strip()
                if text:
                    output.add(text)
            elif isinstance(item, dict) and item.get("seatNum") is not None:
                output.add(str(item.get("seatNum")).strip())
    elif isinstance(value, dict) and value.get("seatNum") is not None:
        output.add(str(value.get("seatNum")).strip())


def extract_used_seats(payload: object) -> set[str]:
    used: set[str] = set()
    interesting = {
        "seatnum",
        "seatnums",
        "usedseatnum",
        "usedseatnums",
        "reserveseatnum",
        "reserveseatnums",
    }

    def walk(obj: object) -> None:
        if isinstance(obj, dict):
            for key, value in obj.items():
                if str(key).lower() in interesting:
                    _add_seat_values(value, used)
                else:
                    walk(value)
        elif isinstance(obj, list):
            for item in obj:
                walk(item)

    walk(payload)
    return used


def get_used_seats(
    client: ChaoxingClient,
    room_id: str,
    day: str,
    start_time: str,
    end_time: str,
    fid_enc: str,
) -> tuple[set[str], dict]:
    response = client.session.post(
        f"{BASE}/data/apps/seat/getusedseatnums",
        data={
            "roomId": room_id,
            "startTime": start_time,
            "endTime": end_time,
            "day": day,
            "fidEnc": fid_enc,
        },
        headers=client.office_headers,
        timeout=12,
        verify=client.verify,
    )
    response.raise_for_status()
    payload = response.json()
    return extract_used_seats(payload), payload


def fetch_submit_enc(
    client: ChaoxingClient,
    dept_id_enc: str,
    room_id: str,
    day: str,
    fid_enc: str,
    retries: int = 6,
) -> str:
    params = {
        "deptIdEnc": dept_id_enc,
        "id": room_id,
        "day": day,
        "backLevel": "2",
        "fidEnc": fid_enc,
    }
    for attempt in range(retries):
        response = client.session.get(
            f"{BASE}/front/third/apps/seat/select",
            params=params,
            headers={
                **client.office_headers,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Referer": f"{BASE}/front/third/apps/seat/list?deptIdEnc={dept_id_enc}",
            },
            timeout=12,
            verify=client.verify,
        )
        if response.status_code == 200:
            match = re.search(
                r'<input\b[^>]*\bid=["\']submit_enc["\'][^>]*\bvalue=["\']([^"\']+)["\']'
                r'|<input\b[^>]*\bvalue=["\']([^"\']+)["\'][^>]*\bid=["\']submit_enc["\']',
                response.text,
                re.I,
            )
            if match:
                value = match.group(1) or match.group(2)
                if value:
                    return value
        if response.status_code in (401, 403) and attempt + 1 < retries:
            time.sleep(1.0)
            continue
        raise RuntimeError(
            f"选座页不可用: HTTP {response.status_code}, url={response.url}"
        )
    raise RuntimeError("未能取得 submit_enc")


def submit_one(
    client: ChaoxingClient,
    dept_id_enc: str,
    room_id: str,
    seat_num: str,
    day: str,
    start_time: str,
    end_time: str,
    submit_enc: str,
) -> tuple[bool, dict]:
    form: dict[str, object] = {
        "deptIdEnc": dept_id_enc,
        "roomId": room_id,
        "startTime": start_time,
        "endTime": end_time,
        "day": day,
        "seatNum": seat_num,
        "captcha": "",
        "wyToken": "",
    }
    form["enc"] = verify_param(form, submit_enc)
    response = client.session.post(
        f"{BASE}/data/apps/seat/submit",
        data=form,
        headers={
            **client.office_headers,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Origin": BASE,
        },
        timeout=12,
        verify=client.verify,
    )
    response.raise_for_status()
    payload = response.json()
    text = json.dumps(payload, ensure_ascii=False).lower()
    if any(word in text for word in ("captcha", "验证码", "滑块")):
        raise RuntimeError("超星要求验证码；脚本不会自动绕过验证码")
    return bool(payload.get("success")), payload


def wait_for_open(info: dict, max_wait_seconds: int) -> None:
    data = info.get("data") or {}
    ts = data.get("beforeOpenTimeStamp")
    if not isinstance(ts, (int, float)) or ts <= 0:
        return
    wait = ts / 1000.0 - time.time()
    if wait <= 0:
        return
    target = datetime.fromtimestamp(ts / 1000.0, TZ)
    if wait > max_wait_seconds:
        raise RuntimeError(
            f"距离开放还有 {wait:.0f} 秒（{target:%Y-%m-%d %H:%M:%S}），"
            f"超过本次允许等待的 {max_wait_seconds} 秒"
        )
    print(f"等待预约开放：{target:%Y-%m-%d %H:%M:%S}，约 {wait:.1f} 秒")
    time.sleep(max(0.0, wait + 0.15))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="超星三楼任意空座预约")
    p.add_argument("--config", default="/etc/chaoxing-seatbot/config.yaml")
    p.add_argument("--room", default="3748")
    p.add_argument("--day-offset", type=int, default=1)
    p.add_argument("--start", required=True, help="预约开始时间 HH:MM")
    p.add_argument("--end", required=True, help="预约结束时间 HH:MM")
    p.add_argument("--max-candidates", type=int, default=20)
    p.add_argument("--retry-interval", type=float, default=0.8)
    p.add_argument("--max-wait", type=int, default=120)
    p.add_argument("--dry-run", action="store_true")
    return p


def main() -> int:
    load_environment()
    args = build_parser().parse_args()
    cfg = load_config(args.config)
    username = (os.getenv("CX_USERNAME") or "").strip()
    password = os.getenv("CX_PASSWORD") or ""
    if not username or not password:
        print("缺少 CX_USERNAME/CX_PASSWORD", file=sys.stderr)
        return 2

    target_day = str(date.today() + timedelta(days=args.day_offset))
    client = ChaoxingClient(tls_verify=cfg.tls_verify)
    client.login(username, password, cfg.dept_id_enc)
    fid_enc = discover_fid_enc(client, cfg.dept_id_enc)
    info = room_info(client, args.room, target_day, fid_enc)
    data = info.get("data") or {}
    room = data.get("seatRoom") or {}
    seats = candidate_seats(info)

    print(
        f"房间: {room.get('firstLevelName','')} - {room.get('secondLevelName','')} - "
        f"{room.get('thirdLevelName','')} (room={args.room})"
    )
    print(f"目标日期: {target_day}  时间: {args.start}-{args.end}")
    print(f"容量: {room.get('capacity')}  可参与预约的静态座位数: {len(seats)}")
    open_ts = data.get("beforeOpenTimeStamp")
    if isinstance(open_ts, (int, float)) and open_ts > 0:
        print(
            "系统返回的预约开放时间: "
            + datetime.fromtimestamp(open_ts / 1000.0, TZ).strftime("%Y-%m-%d %H:%M:%S")
        )

    if args.dry_run:
        print("候选座位示例:", ", ".join(seats[:40]))
        return 0

    wait_for_open(info, max_wait_seconds=args.max_wait)

    # Refresh state after the opening moment.
    info = room_info(client, args.room, target_day, fid_enc)
    seats = candidate_seats(info)
    used, used_payload = get_used_seats(
        client,
        args.room,
        target_day,
        args.start,
        args.end,
        fid_enc,
    )
    available = [seat for seat in seats if seat not in used]
    random.SystemRandom().shuffle(available)
    print(f"已识别占用座位: {len(used)}，待尝试候选: {len(available)}")
    if not available:
        print("没有可尝试座位。getusedseatnums 返回：")
        print(json.dumps(used_payload, ensure_ascii=False)[:3000])
        return 3

    submit_enc = fetch_submit_enc(
        client,
        cfg.dept_id_enc,
        args.room,
        target_day,
        fid_enc,
    )

    last: dict = {}
    limit = max(1, min(args.max_candidates, 50))
    interval = max(0.5, args.retry_interval)
    for index, seat in enumerate(available[:limit], start=1):
        print(f"尝试 {index}/{min(limit, len(available))}: seat={seat}")
        ok, payload = submit_one(
            client,
            cfg.dept_id_enc,
            args.room,
            seat,
            target_day,
            args.start,
            args.end,
            submit_enc,
        )
        last = payload
        if ok:
            print(
                f"预约成功：{target_day} {args.start}-{args.end}，"
                f"room={args.room}，seat={seat}"
            )
            return 0
        print("未成功:", json.dumps(payload, ensure_ascii=False)[:500])
        time.sleep(interval)

    print("候选座位均未成功。最后返回：", json.dumps(last, ensure_ascii=False), file=sys.stderr)
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
