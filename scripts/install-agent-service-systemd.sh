#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/export-ai-agent}"
SERVICE_NAME="export-ai-agent-service"
BACKUP_SERVICE_NAME="export-ai-agent-backup"
RUN_USER="${RUN_USER:-$(id -un)}"
RUN_HOME="$(getent passwd "${RUN_USER}" | cut -d: -f6)"

if [[ -z "${RUN_HOME}" || ! -d "${RUN_HOME}" ]]; then
  echo "[FAIL] Could not resolve home directory for ${RUN_USER}." >&2
  exit 1
fi

if [[ "${EUID}" -eq 0 ]]; then
  ROOT=()
else
  if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1; then
    echo "[FAIL] Run as root or configure passwordless sudo." >&2
    exit 1
  fi
  ROOT=(sudo -n)
fi

run_root() {
  "${ROOT[@]}" "$@"
}

if [[ ! -f "${APP_DIR}/agent_service/package.json" ]]; then
  echo "[FAIL] agent_service package is missing under ${APP_DIR}" >&2
  exit 1
fi

cd "${APP_DIR}/agent_service"
npm ci
npm run build
mkdir -p data logs "${APP_DIR}/outputs" "${RUN_HOME}/.hermes" "${RUN_HOME}/.cache"

run_root tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null <<EOF
[Unit]
Description=CRM Export AI Lead Generation Agent
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}/agent_service
Environment=NODE_ENV=production
Environment=HOME=${RUN_HOME}
Environment=PATH=${RUN_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
UMask=0077
ExecStartPre=/usr/bin/env node ${APP_DIR}/agent_service/dist/cli.js verify-db
ExecStart=/usr/bin/env node ${APP_DIR}/agent_service/dist/app.js
Restart=always
RestartSec=10
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths=${APP_DIR}/agent_service/data ${APP_DIR}/agent_service/logs ${APP_DIR}/outputs ${RUN_HOME}/.hermes ${RUN_HOME}/.cache

[Install]
WantedBy=multi-user.target
EOF

run_root tee "/etc/systemd/system/${BACKUP_SERVICE_NAME}.service" >/dev/null <<EOF
[Unit]
Description=CRM Export AI Agent production state backup
After=${SERVICE_NAME}.service

[Service]
Type=oneshot
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
Environment=APP_DIR=${APP_DIR}
UMask=0077
ExecStart=/usr/bin/env pwsh -NoProfile -ExecutionPolicy Bypass -File ${APP_DIR}/scripts/backup-production-state.ps1 -Workspace ${APP_DIR} -Reason scheduled-vps-backup -KeepLatest 30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${APP_DIR}/agent_service/data ${APP_DIR}/outputs
EOF

run_root tee "/etc/systemd/system/${BACKUP_SERVICE_NAME}.timer" >/dev/null <<EOF
[Unit]
Description=Daily CRM Export AI Agent backup

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=30m
Persistent=true
Unit=${BACKUP_SERVICE_NAME}.service

[Install]
WantedBy=timers.target
EOF

run_root systemctl daemon-reload
run_root systemctl enable --now "${SERVICE_NAME}.service"
run_root systemctl enable --now "${BACKUP_SERVICE_NAME}.timer"
run_root systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
echo "[OK] Installed ${SERVICE_NAME}.service"
echo "[OK] Installed ${BACKUP_SERVICE_NAME}.timer"
