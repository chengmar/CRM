#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/export-ai-agent}"
SERVICE_NAME="${SERVICE_NAME:-export-ai-agent-service}"
BACKUP_SERVICE_NAME="export-ai-agent-backup"
DAILY_SERVICE_NAME="export-ai-agent-daily"
IF_PRESENT=false
if [[ "${1:-}" == "--if-present" ]]; then
  IF_PRESENT=true
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--if-present]" >&2
  exit 2
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

APP_DIR="$(readlink -m "${APP_DIR}")"
case "${APP_DIR}" in
  /|/root|/home|"${HOME}")
    echo "[FAIL] Refusing unsafe application directory: ${APP_DIR}" >&2
    exit 1
    ;;
esac

PARENT_DIR="$(dirname "${APP_DIR}")"
DEPLOY_LOCK="${APP_DIR}.deploy.lock"
if ! command -v flock >/dev/null 2>&1; then
  echo "[FAIL] flock is required for serialized release rollback." >&2
  exit 1
fi
exec 9>"${DEPLOY_LOCK}"
if ! flock -n 9; then
  echo "[FAIL] Another release activation or rollback is already running for ${APP_DIR}." >&2
  exit 1
fi
PREVIOUS_DIR="${APP_DIR}.previous"
REPLACED_DIR="${APP_DIR}.replaced.$(date -u +%Y%m%dT%H%M%SZ)"
ROLLBACK_STATE_DIR="${APP_DIR}.rollback-state"
PREDEPLOY_DB_SNAPSHOT="${ROLLBACK_STATE_DIR}/agent.db"
RUNTIME_STAGE=""
SERVICE_WAS_ACTIVE=false
BACKUP_TIMER_WAS_ACTIVE=false
BACKUP_TIMER_WAS_ENABLED=false
SWAPPED=false
BUSINESS_DATA_RELATIVE="customer_business_data"

if [[ -f "${APP_DIR}/.env" ]]; then
  configured_db="$(grep '^AGENT_DB_PATH=' "${APP_DIR}/.env" | tail -n 1 | cut -d= -f2- | tr -d '\r' || true)"
  configured_db="${configured_db#\"}"
  configured_db="${configured_db%\"}"
  configured_db="${configured_db#\'}"
  configured_db="${configured_db%\'}"
  case "${configured_db}" in
    ""|agent_service/data/agent.db|./agent_service/data/agent.db|"${APP_DIR}/agent_service/data/agent.db")
      ;;
    *)
      echo "[FAIL] Release rollback supports only the managed default AGENT_DB_PATH." >&2
      exit 1
      ;;
  esac
  candidate="$(grep '^BUSINESS_DATA_DIR=' "${APP_DIR}/.env" | tail -n 1 | cut -d= -f2- | tr -d '\r' || true)"
  candidate="${candidate#\"}"
  candidate="${candidate%\"}"
  candidate="${candidate#\'}"
  candidate="${candidate%\'}"
  if [[ -n "${candidate}" && "${candidate}" != /* && "${candidate}" != ".." && "${candidate}" != ../* && "${candidate}" != */../* && "${candidate}" != */.. ]]; then
    BUSINESS_DATA_RELATIVE="${candidate}"
  fi
fi
case "${BUSINESS_DATA_RELATIVE}" in
  .|./*|agent_service|agent_service/*)
    echo "[FAIL] BUSINESS_DATA_DIR must not overlap the application database tree." >&2
    exit 1
    ;;
esac
RUNTIME_STAGE="$(mktemp -d "${PARENT_DIR}/.crm-agent-rollback-runtime.XXXXXX")"

safe_remove_tree() {
  local target
  target="$(readlink -m "$1")"
  if [[ "${target}" != "${PARENT_DIR}/"* || "${target}" == "${PARENT_DIR}" ]]; then
    echo "[FAIL] Refusing recursive removal outside release parent: ${target}" >&2
    exit 1
  fi
  rm -rf -- "${target}"
}

stage_non_database_runtime() {
  local relative
  for relative in "agent_service/logs" "outputs" "infra/runtime" "${BUSINESS_DATA_RELATIVE}"; do
    if [[ -d "${APP_DIR}/${relative}" ]]; then
      mkdir -p "${RUNTIME_STAGE}/${relative}"
      cp -a "${APP_DIR}/${relative}/." "${RUNTIME_STAGE}/${relative}/"
    fi
  done
  if [[ -f "${APP_DIR}/.env" ]]; then
    cp "${APP_DIR}/.env" "${RUNTIME_STAGE}/.env"
    chmod 600 "${RUNTIME_STAGE}/.env"
  fi
}

restore_staged_non_database_runtime() {
  local relative
  for relative in "agent_service/logs" "outputs" "infra/runtime" "${BUSINESS_DATA_RELATIVE}"; do
    if [[ -d "${RUNTIME_STAGE}/${relative}" ]]; then
      safe_remove_tree "${APP_DIR}/${relative}"
      mkdir -p "${APP_DIR}/${relative}"
      cp -a "${RUNTIME_STAGE}/${relative}/." "${APP_DIR}/${relative}/"
    fi
  done
  if [[ -f "${RUNTIME_STAGE}/.env" ]]; then
    cp "${RUNTIME_STAGE}/.env" "${APP_DIR}/.env"
    chmod 600 "${APP_DIR}/.env"
  fi
}

restore_predeploy_database_to() {
  local destination="$1"
  if [[ ! -f "${PREDEPLOY_DB_SNAPSHOT}" ]]; then
    if [[ -f "${APP_DIR}/agent_service/data/agent.db" && ! -f "${destination}/agent_service/data/agent.db" ]]; then
      echo "[FAIL] Previous release has no database and the predeploy database snapshot is missing." >&2
      return 1
    fi
    echo "[WARN] Predeploy database snapshot is missing; using the database retained with the previous release." >&2
    return 0
  fi
  if [[ -f "${ROLLBACK_STATE_DIR}/agent.db.sha256" ]] && ! sha256sum -c --status "${ROLLBACK_STATE_DIR}/agent.db.sha256"; then
    echo "[FAIL] Predeploy database snapshot checksum mismatch." >&2
    return 1
  fi
  local data_dir="${destination}/agent_service/data"
  local restore_candidate="${data_dir}/.agent.db.predeploy.$$"
  mkdir -p "${data_dir}"
  cp -a "${PREDEPLOY_DB_SNAPSHOT}" "${restore_candidate}"
  python3 - "${restore_candidate}" <<'PY'
import pathlib
import sqlite3
import sys

database_path = pathlib.Path(sys.argv[1]).resolve()
connection = sqlite3.connect(f"{database_path.as_uri()}?mode=ro", uri=True)
try:
    quick = [row[0] for row in connection.execute("PRAGMA quick_check")]
    foreign_keys = list(connection.execute("PRAGMA foreign_key_check"))
    if quick != ["ok"] or foreign_keys:
        raise RuntimeError("predeploy database snapshot failed rollback verification")
    user_version = connection.execute("PRAGMA user_version").fetchone()[0]
finally:
    connection.close()
print(f"[OK] Rollback database verified; user_version={user_version}")
PY
  rm -f -- "${data_dir}/agent.db-wal" "${data_dir}/agent.db-shm"
  mv -f -- "${restore_candidate}" "${data_dir}/agent.db"
}

recover_current_release() {
  local status=$?
  trap - EXIT
  if [[ ${status} -ne 0 ]]; then
    if [[ "${SWAPPED}" == "true" ]]; then
      echo "[WARN] Previous release did not become healthy; restoring the current release." >&2
      run_root systemctl stop "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
      if [[ -d "${APP_DIR}" ]]; then
        safe_remove_tree "${PREVIOUS_DIR}"
        mv "${APP_DIR}" "${PREVIOUS_DIR}"
      fi
      if [[ -d "${REPLACED_DIR}" ]]; then
        mv "${REPLACED_DIR}" "${APP_DIR}"
      fi
    fi
    if [[ "${SERVICE_WAS_ACTIVE}" == "true" && -d "${APP_DIR}" ]]; then
      run_root systemctl start "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
    fi
    if [[ "${BACKUP_TIMER_WAS_ENABLED}" == "true" ]]; then
      run_root systemctl enable "${BACKUP_SERVICE_NAME}.timer" >/dev/null 2>&1 || true
    fi
    if [[ "${BACKUP_TIMER_WAS_ACTIVE}" == "true" ]]; then
      run_root systemctl start "${BACKUP_SERVICE_NAME}.timer" >/dev/null 2>&1 || true
    fi
  fi
  safe_remove_tree "${RUNTIME_STAGE}"
  exit "${status}"
}
trap recover_current_release EXIT

if [[ ! -d "${PREVIOUS_DIR}" ]]; then
  if [[ "${IF_PRESENT}" == "true" ]]; then
    echo "[OK] No previous release is available; rollback skipped."
    exit 0
  fi
  echo "[FAIL] Previous release is missing: ${PREVIOUS_DIR}" >&2
  exit 1
fi
if [[ ! -d "${APP_DIR}" ]]; then
  echo "[FAIL] Current release is missing: ${APP_DIR}" >&2
  exit 1
fi

if run_root systemctl is-active --quiet "${SERVICE_NAME}.service"; then
  SERVICE_WAS_ACTIVE=true
  run_root systemctl stop "${SERVICE_NAME}.service"
fi
if run_root systemctl is-enabled --quiet "${BACKUP_SERVICE_NAME}.timer"; then
  BACKUP_TIMER_WAS_ENABLED=true
fi
if run_root systemctl is-active --quiet "${BACKUP_SERVICE_NAME}.timer"; then
  BACKUP_TIMER_WAS_ACTIVE=true
fi
run_root systemctl stop "${BACKUP_SERVICE_NAME}.timer" >/dev/null 2>&1 || true
run_root systemctl stop "${BACKUP_SERVICE_NAME}.service" >/dev/null 2>&1 || true
run_root systemctl disable --now "${DAILY_SERVICE_NAME}.timer" >/dev/null 2>&1 || true
run_root systemctl stop "${DAILY_SERVICE_NAME}.service" >/dev/null 2>&1 || true

stage_non_database_runtime
restore_predeploy_database_to "${PREVIOUS_DIR}"

mv "${APP_DIR}" "${REPLACED_DIR}"
mv "${PREVIOUS_DIR}" "${APP_DIR}"
SWAPPED=true
restore_staged_non_database_runtime

run_root systemctl daemon-reload
run_root systemctl start "${SERVICE_NAME}.service"
healthy=false
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:18790/health >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "${healthy}" != "true" ]]; then
  run_root systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
  echo "[FAIL] Rolled-back release failed its health check." >&2
  exit 1
fi

if [[ "${BACKUP_TIMER_WAS_ENABLED}" == "true" ]]; then
  run_root systemctl enable "${BACKUP_SERVICE_NAME}.timer" >/dev/null 2>&1 || true
fi
if [[ "${BACKUP_TIMER_WAS_ACTIVE}" == "true" ]]; then
  run_root systemctl start "${BACKUP_SERVICE_NAME}.timer" >/dev/null 2>&1 || true
fi

safe_remove_tree "${RUNTIME_STAGE}"
trap - EXIT
echo "[OK] Previous release restored: ${APP_DIR}"
echo "[OK] Replaced release retained at: ${REPLACED_DIR}"
