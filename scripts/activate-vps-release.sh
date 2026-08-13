#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-}"
APP_DIR="${APP_DIR:-$HOME/export-ai-agent}"
REMOTE_ENV_PATH="${REMOTE_ENV_PATH:-}"
SERVICE_NAME="export-ai-agent-service"
BACKUP_SERVICE_NAME="export-ai-agent-backup"
DAILY_SERVICE_NAME="export-ai-agent-daily"
DEPLOY_LOCK="${APP_DIR}.deploy.lock"

if ! command -v flock >/dev/null 2>&1; then
  echo "[FAIL] flock is required for serialized release activation." >&2
  exit 1
fi
exec 9>"${DEPLOY_LOCK}"
if ! flock -n 9; then
  echo "[FAIL] Another release activation is already running for ${APP_DIR}." >&2
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

if [[ -z "${SOURCE_DIR}" || ! -f "${SOURCE_DIR}/agent_service/package.json" ]]; then
  echo "[FAIL] Release source is missing agent_service/package.json: ${SOURCE_DIR}" >&2
  exit 1
fi

SOURCE_DIR="$(readlink -m "${SOURCE_DIR}")"
APP_DIR="$(readlink -m "${APP_DIR}")"
case "${APP_DIR}" in
  /|/root|/home|"${HOME}")
    echo "[FAIL] Refusing unsafe application directory: ${APP_DIR}" >&2
    exit 1
    ;;
esac

PARENT_DIR="$(dirname "${APP_DIR}")"
NEW_DIR="${APP_DIR}.new.$$"
PREVIOUS_DIR="${APP_DIR}.previous"
ROLLBACK_STATE_DIR="${APP_DIR}.rollback-state"
PREDEPLOY_DB_SNAPSHOT="${ROLLBACK_STATE_DIR}/agent.db"
SERVICE_WAS_ACTIVE=false
BACKUP_TIMER_WAS_ACTIVE=false
BACKUP_TIMER_WAS_ENABLED=false
ACTIVATED=false
BUSINESS_DATA_RELATIVE="customer_business_data"

if [[ -f "${APP_DIR}/.env" ]]; then
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

safe_remove_tree() {
  local target
  target="$(readlink -m "$1")"
  if [[ "${target}" != "${PARENT_DIR}/"* || "${target}" == "${PARENT_DIR}" ]]; then
    echo "[FAIL] Refusing recursive removal outside release parent: ${target}" >&2
    exit 1
  fi
  rm -rf -- "${target}"
}

assert_supported_database_path() {
  local env_file="$1"
  [[ -f "${env_file}" ]] || return 0
  local configured
  configured="$(grep '^AGENT_DB_PATH=' "${env_file}" | tail -n 1 | cut -d= -f2- | tr -d '\r' || true)"
  configured="${configured#\"}"
  configured="${configured%\"}"
  configured="${configured#\'}"
  configured="${configured%\'}"
  case "${configured}" in
    ""|agent_service/data/agent.db|./agent_service/data/agent.db|"${APP_DIR}/agent_service/data/agent.db")
      return 0
      ;;
    *)
      echo "[FAIL] Release activation supports only the managed default AGENT_DB_PATH." >&2
      return 1
      ;;
  esac
}

restore_directory() {
  local relative="$1"
  if [[ -d "${APP_DIR}/${relative}" ]]; then
    mkdir -p "${NEW_DIR}/${relative}"
    cp -a "${APP_DIR}/${relative}/." "${NEW_DIR}/${relative}/"
  fi
}

preserve_non_database_runtime_to() {
  local destination="$1"
  local relative
  for relative in "agent_service/logs" "outputs" "infra/runtime" "${BUSINESS_DATA_RELATIVE}" "private"; do
    if [[ -d "${APP_DIR}/${relative}" ]]; then
      safe_remove_tree "${destination}/${relative}"
      mkdir -p "${destination}/${relative}"
      cp -a "${APP_DIR}/${relative}/." "${destination}/${relative}/"
    fi
  done
  if [[ -f "${APP_DIR}/.env" ]]; then
    cp "${APP_DIR}/.env" "${destination}/.env"
    chmod 600 "${destination}/.env"
  fi
}

force_safe_database_settings() {
  local database="${APP_DIR}/agent_service/data/agent.db"
  [[ -f "${database}" ]] || return 0
  if ! command -v python3 >/dev/null 2>&1; then
    echo "[FAIL] python3 is required to pause the production database before activation." >&2
    return 1
  fi
  python3 - "${database}" <<'PY'
import datetime
import sqlite3
import sys

database = sys.argv[1]
connection = sqlite3.connect(database)
try:
    has_settings = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'"
    ).fetchone()
    if not has_settings:
        raise RuntimeError("settings table is missing")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    for key, value in (("outbound_paused", "true"), ("daily_research_enabled", "false")):
        connection.execute(
            """
            INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
            """,
            (key, value, now),
        )
    connection.commit()
    quick = [row[0] for row in connection.execute("PRAGMA quick_check")]
    foreign_keys = list(connection.execute("PRAGMA foreign_key_check"))
    if quick != ["ok"] or foreign_keys:
        raise RuntimeError("database integrity check failed after applying deployment pauses")
finally:
    connection.close()
PY
  echo "[OK] Global outbound and daily research are paused for release activation."
}

snapshot_predeploy_database() {
  local database="${APP_DIR}/agent_service/data/agent.db"
  [[ -f "${database}" ]] || return 0
  safe_remove_tree "${ROLLBACK_STATE_DIR}"
  mkdir -p "${ROLLBACK_STATE_DIR}"
  python3 - "${database}" "${PREDEPLOY_DB_SNAPSHOT}" <<'PY'
import os
import pathlib
import sqlite3
import sys

source_path = pathlib.Path(sys.argv[1]).resolve()
destination_path = pathlib.Path(sys.argv[2]).resolve()
source = sqlite3.connect(f"{source_path.as_uri()}?mode=ro", uri=True)
destination = sqlite3.connect(str(destination_path))
try:
    source.backup(destination)
finally:
    destination.close()
    source.close()
os.chmod(destination_path, 0o600)
check = sqlite3.connect(f"{destination_path.as_uri()}?mode=ro", uri=True)
try:
    quick = [row[0] for row in check.execute("PRAGMA quick_check")]
    foreign_keys = list(check.execute("PRAGMA foreign_key_check"))
    if quick != ["ok"] or foreign_keys:
        raise RuntimeError("predeploy database snapshot failed integrity verification")
    user_version = check.execute("PRAGMA user_version").fetchone()[0]
finally:
    check.close()
print(f"[OK] Predeploy SQLite snapshot verified; user_version={user_version}")
PY
  sha256sum "${PREDEPLOY_DB_SNAPSHOT}" > "${ROLLBACK_STATE_DIR}/agent.db.sha256"
}

restore_predeploy_database_to() {
  local destination="$1"
  [[ -f "${PREDEPLOY_DB_SNAPSHOT}" ]] || return 0
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
        raise RuntimeError("rollback database snapshot failed integrity verification")
finally:
    connection.close()
PY
  rm -f -- "${data_dir}/agent.db-wal" "${data_dir}/agent.db-shm"
  mv -f -- "${restore_candidate}" "${data_dir}/agent.db"
  echo "[OK] Restored the predeploy database for the previous release."
}

terminate_children() {
  local parent_pid="$1"
  local child
  while read -r child; do
    [[ -z "${child}" ]] && continue
    terminate_children "${child}"
    kill -TERM "${child}" >/dev/null 2>&1 || true
  done < <(pgrep -P "${parent_pid}" || true)
}

rollback() {
  local status=$?
  trap - EXIT
  terminate_children "$$"
  if [[ ${status} -ne 0 ]]; then
    echo "[WARN] Release activation failed; restoring previous version." >&2
    if [[ "${ACTIVATED}" == "true" ]]; then
      run_root systemctl stop "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
      run_root systemctl stop "${BACKUP_SERVICE_NAME}.timer" >/dev/null 2>&1 || true
      run_root systemctl stop "${BACKUP_SERVICE_NAME}.service" >/dev/null 2>&1 || true
      run_root systemctl disable --now "${DAILY_SERVICE_NAME}.timer" >/dev/null 2>&1 || true
      run_root systemctl stop "${DAILY_SERVICE_NAME}.service" >/dev/null 2>&1 || true
      if [[ -d "${PREVIOUS_DIR}" ]]; then
        preserve_non_database_runtime_to "${PREVIOUS_DIR}" || echo "[WARN] Non-database runtime preservation was incomplete during rollback." >&2
        restore_predeploy_database_to "${PREVIOUS_DIR}" || echo "[WARN] Explicit database restore failed; retaining the untouched database stored with the previous release." >&2
      fi
      safe_remove_tree "${APP_DIR}"
      if [[ -d "${PREVIOUS_DIR}" ]]; then
        mv "${PREVIOUS_DIR}" "${APP_DIR}"
      fi
    else
      safe_remove_tree "${NEW_DIR}"
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
  exit "${status}"
}
trap rollback EXIT
trap 'exit 143' TERM HUP
trap 'exit 130' INT

mkdir -p "${PARENT_DIR}"
safe_remove_tree "${NEW_DIR}"
mkdir -p "${NEW_DIR}"
cp -a "${SOURCE_DIR}/." "${NEW_DIR}/"

assert_supported_database_path "${APP_DIR}/.env"
if [[ -n "${REMOTE_ENV_PATH}" ]]; then
  if [[ ! -f "${REMOTE_ENV_PATH}" ]]; then
    echo "[FAIL] Explicit REMOTE_ENV_PATH does not exist." >&2
    exit 1
  fi
  assert_supported_database_path "${REMOTE_ENV_PATH}"
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

if [[ -d "${APP_DIR}" ]]; then
  force_safe_database_settings
  snapshot_predeploy_database
fi

if [[ -d "${APP_DIR}" ]]; then
  restore_directory "agent_service/data"
  restore_directory "agent_service/logs"
  restore_directory "outputs"
  restore_directory "infra/runtime"
  restore_directory "${BUSINESS_DATA_RELATIVE}"
  restore_directory "private"
fi

if [[ -n "${REMOTE_ENV_PATH}" && -f "${REMOTE_ENV_PATH}" ]]; then
  cp "${REMOTE_ENV_PATH}" "${NEW_DIR}/.env"
  rm -f -- "${REMOTE_ENV_PATH}"
elif [[ -f "${APP_DIR}/.env" ]]; then
  cp "${APP_DIR}/.env" "${NEW_DIR}/.env"
elif [[ -f "${NEW_DIR}/.env.example" ]]; then
  cp "${NEW_DIR}/.env.example" "${NEW_DIR}/.env"
fi
if [[ -f "${NEW_DIR}/.env" ]]; then
  chmod 600 "${NEW_DIR}/.env"
fi

safe_remove_tree "${PREVIOUS_DIR}"
if [[ -d "${APP_DIR}" ]]; then
  mv "${APP_DIR}" "${PREVIOUS_DIR}"
fi
mv "${NEW_DIR}" "${APP_DIR}"
ACTIVATED=true

cd "${APP_DIR}"
bash scripts/bootstrap-vps-production.sh
if [[ -d "${APP_DIR}/agents/skills" ]]; then
  HERMES_SKILLS_DIR="${HERMES_HOME:-$HOME/.hermes}/skills"
  mkdir -p "${HERMES_SKILLS_DIR}"
  for source_dir in "${APP_DIR}"/agents/skills/*; do
    [[ -d "${source_dir}" ]] || continue
    target_dir="${HERMES_SKILLS_DIR}/$(basename "${source_dir}")"
    mkdir -p "${target_dir}"
    cp -a "${source_dir}/." "${target_dir}/"
  done
  echo "[OK] Hermes foreign-trade research skills merged into ${HERMES_SKILLS_DIR}"
fi
bash scripts/install-agent-support-services.sh
bash scripts/install-agent-service-systemd.sh
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/run-vps-activation-acceptance.ps1 -Workspace "${APP_DIR}"
run_root systemctl enable --now "${BACKUP_SERVICE_NAME}.timer"

trap - EXIT
echo "[OK] Release activated: ${APP_DIR}"
if [[ -d "${PREVIOUS_DIR}" ]]; then
  echo "[OK] Previous release retained for rollback: ${PREVIOUS_DIR}"
fi
