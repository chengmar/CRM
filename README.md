# Chaoxing SeatBot

一个用于**本人账号**的超星图书馆座位预约脚本，目标部署环境为 Ubuntu 24.04 + systemd。

当前仓库已经预填河北工业大学座位入口中的：

```text
deptIdEnc=214d62ddb0e920e7
```

## 设计原则

- 使用超星网页正常登录与座位提交请求，不需要常驻浏览器。
- 账号密码只放在服务器 `/etc/chaoxing-seatbot/seatbot.env`，不提交 Git。
- 候选座位按顺序尝试；成功即停止。
- 请求失败不会无限狂刷：每个座位最多 1~5 次，间隔最低 0.5 秒。
- **不自动识别、破解或绕过验证码/滑块。** 超星要求验证码时，程序停止并记录错误。
- 请遵守学校和超星的预约规则；若学校禁止自动预约，请不要启用定时任务。

## 服务器要求

1C1G 即可。2C2G / 50GB 的 Ubuntu 24.04 服务器绰绰有余。

## 本地/服务器手动运行

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
cp config.example.yaml config.yaml
```

编辑 `.env`，填写自己的超星账号：

```dotenv
CX_USERNAME=你的账号
CX_PASSWORD=你的密码
```

检查登录：

```bash
python -m seatbot.main check
```

列出学校自习室，获取 `room_id`：

```bash
python -m seatbot.main rooms
```

然后编辑 `config.yaml`：

```yaml
booking:
  day_offset: 1
  start_time: "08:00"
  end_time: "22:00"
  weekdays: [Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday]
  attempts_per_seat: 2
  retry_interval_seconds: 1.0
  choices:
    - room_id: "1234"
      seats: ["056", "057", "058"]
```

先做 dry-run：

```bash
python -m seatbot.main reserve --dry-run
```

确认后执行一次：

```bash
python -m seatbot.main reserve
```

## Ubuntu systemd 部署

从仓库目录执行：

```bash
sudo ./scripts/install.sh --time 06:59:55
```

安装后填写：

- `/etc/chaoxing-seatbot/seatbot.env`
- `/etc/chaoxing-seatbot/config.yaml`

验证：

```bash
sudo -u seatbot /opt/chaoxing-seatbot/.venv/bin/python \
  -m seatbot.main --config /etc/chaoxing-seatbot/config.yaml check
```

手动跑一次预约：

```bash
sudo systemctl start chaoxing-seatbot.service
journalctl -u chaoxing-seatbot.service -n 100 --no-pager
```

一切正确后启用每天定时任务：

```bash
sudo systemctl enable --now chaoxing-seatbot.timer
systemctl list-timers chaoxing-seatbot.timer
```

查看日志：

```bash
journalctl -u chaoxing-seatbot.service --since today
```

修改每日启动时间时重新运行安装脚本，例如：

```bash
sudo ./scripts/install.sh --time 07:59:55
```

## 还需要你自己确认的参数

自动预约真正启用前必须确认三项：

1. 超星账号/密码；
2. 你要预约的 `room_id + seatNum`（可用 `rooms` 命令辅助获取房间 ID）；
3. 学校每天开放次日预约的准确时间，以及你需要的开始/结束时间。

在这些参数未确认前，不建议直接启用 timer。
