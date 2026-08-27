#!/usr/bin/env bash
set -euo pipefail

RUN_AT="06:59:55"
ENABLE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --time) RUN_AT="${2:?missing HH:MM:SS}"; shift 2 ;;
    --enable) ENABLE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo/root." >&2
  exit 1
fi
if ! [[ "$RUN_AT" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$ ]]; then
  echo "--time must be HH:MM:SS" >&2
  exit 2
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/chaoxing-seatbot
ETC_DIR=/etc/chaoxing-seatbot
LOG_DIR=/var/log/chaoxing-seatbot

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-venv python3-pip ca-certificates

if ! id seatbot >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --create-home --shell /usr/sbin/nologin seatbot
fi
mkdir -p "$APP_DIR" "$ETC_DIR" "$LOG_DIR"

rm -rf "$APP_DIR/seatbot" "$APP_DIR/systemd" "$APP_DIR/scripts" "$APP_DIR/tests"
cp -a "$SRC_DIR/seatbot" "$APP_DIR/"
cp -a "$SRC_DIR/systemd" "$APP_DIR/"
cp -a "$SRC_DIR/scripts" "$APP_DIR/"
cp "$SRC_DIR/requirements.txt" "$APP_DIR/requirements.txt"

python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"

if [[ ! -f "$ETC_DIR/config.yaml" ]]; then
  install -m 640 -o root -g seatbot "$SRC_DIR/config.example.yaml" "$ETC_DIR/config.yaml"
fi
if [[ ! -f "$ETC_DIR/seatbot.env" ]]; then
  install -m 640 -o root -g seatbot "$SRC_DIR/.env.example" "$ETC_DIR/seatbot.env"
  sed -i 's#SEATBOT_CONFIG=config.yaml#SEATBOT_CONFIG=/etc/chaoxing-seatbot/config.yaml#' "$ETC_DIR/seatbot.env"
fi

install -m 644 "$SRC_DIR/systemd/chaoxing-seatbot.service" /etc/systemd/system/chaoxing-seatbot.service
sed "s/__RUN_AT__/$RUN_AT/g" "$SRC_DIR/systemd/chaoxing-seatbot.timer.template" > /etc/systemd/system/chaoxing-seatbot.timer
chmod 644 /etc/systemd/system/chaoxing-seatbot.timer

chown -R root:seatbot "$APP_DIR" "$ETC_DIR"
chmod -R o-rwx "$ETC_DIR"
chown seatbot:seatbot "$LOG_DIR"
systemctl daemon-reload

if [[ $ENABLE -eq 1 ]]; then
  if grep -Eq '^CX_USERNAME=.+$' "$ETC_DIR/seatbot.env" && grep -Eq '^CX_PASSWORD=.+$' "$ETC_DIR/seatbot.env"; then
    systemctl enable --now chaoxing-seatbot.timer
  else
    echo "Credentials are empty; timer was NOT enabled." >&2
    exit 3
  fi
else
  systemctl disable --now chaoxing-seatbot.timer >/dev/null 2>&1 || true
fi

echo "Installed to $APP_DIR"
echo "Config: $ETC_DIR/config.yaml"
echo "Credentials: $ETC_DIR/seatbot.env"
echo "Timer time: $RUN_AT Asia/Shanghai"
echo "After configuration: systemctl enable --now chaoxing-seatbot.timer"
