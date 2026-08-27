from __future__ import annotations

import json
from html.parser import HTMLParser
from typing import Any
from urllib.parse import quote

import requests

from .crypto import encrypt_login_field, verify_param


class ChaoxingError(RuntimeError):
    pass


class LoginError(ChaoxingError):
    pass


class CaptchaRequired(ChaoxingError):
    pass


class _InputParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.by_id: dict[str, str] = {}
        self.values: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "input":
            return
        data = {k.lower(): (v or "") for k, v in attrs}
        value = data.get("value", "")
        if value:
            self.values.append(value)
        if data.get("id"):
            self.by_id[data["id"]] = value


class ChaoxingClient:
    login_page = "https://passport2.chaoxing.com/mlogin?loginType=1&newversion=true&fid="
    login_url = "https://passport2.chaoxing.com/fanyalogin"
    room_list_url = "https://office.chaoxing.com/data/apps/seat/room/list"
    seat_grid_url = "https://office.chaoxing.com/data/apps/seat/seatgrid/roomid"
    seat_page_url = "https://office.chaoxing.com/front/third/apps/seat/code?id={room_id}&seatNum={seat_num}"
    submit_url = "https://office.chaoxing.com/data/apps/seat/submit"

    def __init__(self, *, tls_verify: bool = True, timeout: float = 12.0) -> None:
        self.verify = tls_verify
        self.timeout = timeout
        self.session = requests.Session()
        self.user_agent = (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
        )

    @property
    def login_headers(self) -> dict[str, str]:
        return {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "User-Agent": self.user_agent,
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        }

    @property
    def office_headers(self) -> dict[str, str]:
        return {
            "Accept": "application/json, text/plain, */*",
            "Referer": "https://office.chaoxing.com/",
            "User-Agent": self.user_agent,
        }

    def login(self, username: str, password: str, dept_id_enc: str) -> None:
        self.session.get(
            self.login_page,
            headers=self.login_headers,
            timeout=self.timeout,
            verify=self.verify,
        ).raise_for_status()
        target = (
            "https://office.chaoxing.com/front/third/apps/seat/list?deptIdEnc="
            + dept_id_enc
        )
        params = {
            "fid": -1,
            "uname": encrypt_login_field(username),
            "password": encrypt_login_field(password),
            "refer": quote(target, safe=""),
            "t": True,
        }
        response = self.session.post(
            self.login_url,
            params=params,
            headers=self.login_headers,
            timeout=self.timeout,
            verify=self.verify,
        )
        response.raise_for_status()
        try:
            data = response.json()
        except ValueError as exc:
            raise LoginError("超星登录接口返回了非 JSON 内容") from exc
        if not data.get("status"):
            message = data.get("msg2") or data.get("mes") or data.get("msg") or "登录失败"
            raise LoginError(str(message))

    def list_rooms(self, dept_id_enc: str) -> list[dict[str, Any]]:
        params = {
            "cpage": 1,
            "pageSize": 100,
            "firstLevelName": "",
            "secondLevelName": "",
            "thirdLevelName": "",
            "deptIdEnc": dept_id_enc,
        }
        response = self.session.get(
            self.room_list_url,
            params=params,
            headers=self.office_headers,
            timeout=self.timeout,
            verify=self.verify,
        )
        response.raise_for_status()
        data = response.json()
        rooms = ((data.get("data") or {}).get("seatRoomList") or [])
        if not isinstance(rooms, list):
            raise ChaoxingError("房间列表返回格式异常")
        return rooms

    def get_seat_grid(self, room_id: str) -> dict[str, Any]:
        """Return the raw seat grid for a room.

        Different Chaoxing deployments use slightly different JSON shapes, so
        discovery intentionally returns the raw payload.  The CLI prints it
        first; after the school's schema is confirmed we can safely derive an
        'any available seat' strategy without probing guessed seat numbers.
        """
        response = self.session.get(
            self.seat_grid_url,
            params={"roomId": room_id},
            headers=self.office_headers,
            timeout=self.timeout,
            verify=self.verify,
        )
        response.raise_for_status()
        try:
            data = response.json()
        except ValueError as exc:
            raise ChaoxingError("座位网格接口返回了非 JSON 内容") from exc
        if not isinstance(data, dict):
            raise ChaoxingError("座位网格接口返回格式异常")
        return data

    def _seat_page_values(self, room_id: str, seat_num: str) -> tuple[str, str]:
        url = self.seat_page_url.format(room_id=room_id, seat_num=seat_num)
        response = self.session.get(
            url,
            headers=self.office_headers,
            timeout=self.timeout,
            verify=self.verify,
        )
        response.raise_for_status()
        parser = _InputParser()
        parser.feed(response.text)
        token = parser.by_id.get("submit_enc", "")
        algorithm = parser.by_id.get("algorithm", "")
        if not algorithm and parser.values:
            algorithm = parser.values[0]
        if not token or not algorithm:
            lower = response.text.lower()
            if "captcha" in lower or "验证码" in response.text:
                raise CaptchaRequired("页面要求验证码，请人工处理后再运行")
            raise ChaoxingError("未能从座位页面取得提交令牌，可能登录已失效或页面已改版")
        return token, algorithm

    @staticmethod
    def _looks_like_captcha(data: dict[str, Any]) -> bool:
        text = json.dumps(data, ensure_ascii=False).lower()
        words = ("captcha", "验证码", "滑块", "verifydata")
        return any(word in text for word in words)

    def reserve(
        self,
        *,
        room_id: str,
        seat_num: str,
        start_time: str,
        end_time: str,
        day: str,
    ) -> tuple[bool, dict[str, Any]]:
        token, algorithm = self._seat_page_values(room_id, seat_num)
        params: dict[str, object] = {
            "roomId": room_id,
            "startTime": start_time,
            "endTime": end_time,
            "day": day,
            "seatNum": seat_num,
            "captcha": "",
            "token": token,
            "type": "1",
            "verifyData": "1",
        }
        params["enc"] = verify_param(params, algorithm)
        response = self.session.post(
            self.submit_url,
            params=params,
            headers=self.office_headers,
            timeout=self.timeout,
            verify=self.verify,
        )
        response.raise_for_status()
        try:
            data = response.json()
        except ValueError as exc:
            raise ChaoxingError("预约接口返回了非 JSON 内容") from exc
        if self._looks_like_captcha(data):
            raise CaptchaRequired("超星要求验证码；脚本不会自动绕过验证码")
        return bool(data.get("success")), data
