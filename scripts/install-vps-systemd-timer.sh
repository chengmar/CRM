#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/export-ai-agent}"
DAILY_TIME="${DAILY_TIME:-09:10:00}"
RUN_USER="${RUN_USER:-$(id -un)}"
SERVICE_NAME="export-ai-agent-daily"

if [[ ! -d "${APP_DIR}" ]]; then
  echo "[FAIL] APP_DIR not found: ${APP_DIR}" >&2
  exit 1
fi

if ! command -v pwsh >/dev/null 2>&1; then
  echo "[FAIL] pwsh not found. Run scripts/bootstrap-vps-production.sh first." >&2
  exit 1
fi

sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null <<EOF
[Unit]
Description=Export AI Agent Daily Real Pipeline
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
Environment=APP_DIR=${APP_DIR}
ExecStart=/usr/bin/env pwsh -NoProfile -ExecutionPolicy Bypass -File ${APP_DIR}/scripts/invoke-daily-real-pipeline.ps1 -Workspace ${APP_DIR}
TimeoutStartSec=7200
EOF

sudo tee "/etc/systemd/system/${SERVICE_NAME}.timer" >/dev/null <<EOF
[Unit]
Description=Run Export AI Agent daily

[Timer]
OnCalendar=*-*-* ${DAILY_TIME}
Persistent=true
Unit=${SERVICE_NAME}.service

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}.timer"

echo "[OK] Installed systemd timer: ${SERVICE_NAME}.timer"
echo "[OK] App dir: ${APP_DIR}"
echo "[OK] Daily time: ${DAILY_TIME} server local time"
systemctl list-timers "${SERVICE_NAME}.timer" --no-pager || true
