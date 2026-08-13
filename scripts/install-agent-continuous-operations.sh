#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/export-ai-agent}"
RUN_USER="${RUN_USER:-$(id -un)}"
SERVICE_NAME="export-ai-agent-continuous"
INTERVAL="${CONTINUOUS_OPERATIONS_INTERVAL:-15m}"

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

if [[ ! -f "${APP_DIR}/agent_service/dist/cli.js" ]]; then
  echo "[FAIL] Built Agent CLI not found under ${APP_DIR}." >&2
  exit 1
fi

case "${INTERVAL}" in
  *[!0-9smhd]*) echo "[FAIL] Invalid continuous operations interval." >&2; exit 1 ;;
esac

run_root tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null <<EOF
[Unit]
Description=CRM Export AI Agent continuous acquisition and authorized message replenishment
After=export-ai-agent-service.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${RUN_USER}
WorkingDirectory=${APP_DIR}/agent_service
Environment=NODE_ENV=production
UMask=0077
ExecStart=/usr/bin/env node ${APP_DIR}/agent_service/dist/cli.js schedule-continuous-acquisition
ExecStart=/usr/bin/env node ${APP_DIR}/agent_service/dist/cli.js replay-autonomous-messages --confirm-enqueue
TimeoutStartSec=900
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
ReadWritePaths=${APP_DIR}/agent_service/data ${APP_DIR}/agent_service/logs ${APP_DIR}/outputs
EOF

run_root tee "/etc/systemd/system/${SERVICE_NAME}.timer" >/dev/null <<EOF
[Unit]
Description=Continuously replenish authorized CRM outreach messages

[Timer]
OnBootSec=3m
OnUnitActiveSec=${INTERVAL}
RandomizedDelaySec=45s
Persistent=true
Unit=${SERVICE_NAME}.service

[Install]
WantedBy=timers.target
EOF

run_root systemctl daemon-reload
run_root systemctl enable --now "${SERVICE_NAME}.timer"
run_root systemctl start "${SERVICE_NAME}.service"

printf 'CONTINUOUS_OPERATIONS_TIMER=%s\n' "$(systemctl is-active "${SERVICE_NAME}.timer")"
printf 'CONTINUOUS_OPERATIONS_SERVICE=%s\n' "$(systemctl is-failed "${SERVICE_NAME}.service" 2>/dev/null || true)"
