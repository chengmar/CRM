#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ACTIVATE_SCRIPT="${SCRIPT_DIR}/activate-vps-release.sh"
ROLLBACK_SCRIPT="${SCRIPT_DIR}/rollback-vps-release.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/crm-agent-db-rollback.XXXXXX")"
FAKE_BIN="${TEST_ROOT}/bin"

cleanup() {
  rm -rf -- "${TEST_ROOT}"
}
trap cleanup EXIT
mkdir -p "${FAKE_BIN}"

if ! command -v python3 >/dev/null 2>&1; then
  if [[ -z "${VPS_ROLLBACK_TEST_PYTHON:-}" ]]; then
    echo "[WARN] python3 is unavailable; database-aware rollback behavior test skipped."
    exit 0
  fi
  cat >"${FAKE_BIN}/python3" <<'SH'
#!/usr/bin/env bash
exec "${VPS_ROLLBACK_TEST_PYTHON}" "$@"
SH
  chmod +x "${FAKE_BIN}/python3"
fi

cat >"${FAKE_BIN}/systemctl" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  is-active|is-enabled) exit 0 ;;
  *) exit 0 ;;
esac
SH
cat >"${FAKE_BIN}/sudo" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == "-n" ]]; then shift; fi
exec "$@"
SH
cat >"${FAKE_BIN}/curl" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"${FAKE_BIN}/pwsh" <<'SH'
#!/usr/bin/env bash
exit 1
SH
cat >"${FAKE_BIN}/flock" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "${FAKE_BIN}/systemctl" "${FAKE_BIN}/sudo" "${FAKE_BIN}/curl" "${FAKE_BIN}/pwsh" "${FAKE_BIN}/flock"
export PATH="${FAKE_BIN}:${PATH}"

create_database() {
  local database="$1"
  local version="$2"
  mkdir -p "$(dirname "${database}")"
  python3 - "${database}" "${version}" <<'PY'
import sqlite3
import sys

database, version = sys.argv[1], int(sys.argv[2])
connection = sqlite3.connect(database)
try:
    connection.execute(
        "CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
    )
    connection.execute(
        "INSERT INTO settings(key, value, updated_at) VALUES ('outbound_paused', 'false', 'fixture')"
    )
    connection.execute(
        "INSERT INTO settings(key, value, updated_at) VALUES ('daily_research_enabled', 'true', 'fixture')"
    )
    connection.execute(f"PRAGMA user_version={version}")
    connection.commit()
finally:
    connection.close()
PY
}

database_version() {
  python3 - "$1" <<'PY'
import pathlib
import sqlite3
import sys

database = pathlib.Path(sys.argv[1]).resolve()
connection = sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)
try:
    print(connection.execute("PRAGMA user_version").fetchone()[0])
finally:
    connection.close()
PY
}

database_setting() {
  python3 - "$1" "$2" <<'PY'
import pathlib
import sqlite3
import sys

database = pathlib.Path(sys.argv[1]).resolve()
connection = sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)
try:
    row = connection.execute("SELECT value FROM settings WHERE key=?", (sys.argv[2],)).fetchone()
    print("" if row is None else row[0])
finally:
    connection.close()
PY
}

ACTIVATION_ROOT="${TEST_ROOT}/activation"
ACTIVATION_APP="${ACTIVATION_ROOT}/export-ai-agent"
ACTIVATION_SOURCE="${ACTIVATION_ROOT}/release"
mkdir -p "${ACTIVATION_APP}/outputs" "${ACTIVATION_SOURCE}/agent_service" "${ACTIVATION_SOURCE}/scripts"
printf 'old-release\n' >"${ACTIVATION_APP}/release-marker"
printf 'new-release\n' >"${ACTIVATION_SOURCE}/release-marker"
printf '{}\n' >"${ACTIVATION_SOURCE}/agent_service/package.json"
create_database "${ACTIVATION_APP}/agent_service/data/agent.db" 3

for script in bootstrap-vps-production.sh install-agent-support-services.sh; do
  cat >"${ACTIVATION_SOURCE}/scripts/${script}" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  chmod +x "${ACTIVATION_SOURCE}/scripts/${script}"
done
cat >"${ACTIVATION_SOURCE}/scripts/install-agent-service-systemd.sh" <<'SH'
#!/usr/bin/env bash
python3 - "${APP_DIR}/agent_service/data/agent.db" <<'PY'
import sqlite3
import sys
connection = sqlite3.connect(sys.argv[1])
connection.execute("PRAGMA user_version=16")
connection.commit()
connection.close()
PY
SH
chmod +x "${ACTIVATION_SOURCE}/scripts/install-agent-service-systemd.sh"
printf 'exit 1\n' >"${ACTIVATION_SOURCE}/scripts/run-vps-activation-acceptance.ps1"

ACTIVATION_LOG="${ACTIVATION_ROOT}/activation.log"
if APP_DIR="${ACTIVATION_APP}" bash "${ACTIVATE_SCRIPT}" "${ACTIVATION_SOURCE}" >"${ACTIVATION_LOG}" 2>&1; then
  echo "[FAIL] Activation failure fixture unexpectedly succeeded." >&2
  exit 1
fi
if [[ "$(<"${ACTIVATION_APP}/release-marker")" != "old-release" ]] ||
   [[ "$(database_version "${ACTIVATION_APP}/agent_service/data/agent.db")" != "3" ]] ||
   [[ "$(database_setting "${ACTIVATION_APP}/agent_service/data/agent.db" outbound_paused)" != "true" ]] ||
   [[ "$(database_setting "${ACTIVATION_APP}/agent_service/data/agent.db" daily_research_enabled)" != "false" ]] ||
   [[ ! -f "${ACTIVATION_APP}.rollback-state/agent.db" ]] ||
   [[ "$(database_version "${ACTIVATION_APP}.rollback-state/agent.db")" != "3" ]]; then
  cat "${ACTIVATION_LOG}" >&2
  echo "[FAIL] Failed activation did not restore its predeploy database fixture." >&2
  exit 1
fi
echo "[OK] Failed activation restored the predeploy database and paused settings."

ROLLBACK_ROOT="${TEST_ROOT}/manual"
ROLLBACK_APP="${ROLLBACK_ROOT}/export-ai-agent"
ROLLBACK_PREVIOUS="${ROLLBACK_APP}.previous"
ROLLBACK_STATE="${ROLLBACK_APP}.rollback-state"
mkdir -p "${ROLLBACK_APP}/outputs" "${ROLLBACK_PREVIOUS}/outputs" "${ROLLBACK_STATE}"
printf 'v16-release\n' >"${ROLLBACK_APP}/release-marker"
printf 'v3-release\n' >"${ROLLBACK_PREVIOUS}/release-marker"
printf 'current-output\n' >"${ROLLBACK_APP}/outputs/runtime-marker"
printf 'old-output\n' >"${ROLLBACK_PREVIOUS}/outputs/runtime-marker"
create_database "${ROLLBACK_APP}/agent_service/data/agent.db" 16
create_database "${ROLLBACK_PREVIOUS}/agent_service/data/agent.db" 3
cp -a "${ROLLBACK_PREVIOUS}/agent_service/data/agent.db" "${ROLLBACK_STATE}/agent.db"
sha256sum "${ROLLBACK_STATE}/agent.db" >"${ROLLBACK_STATE}/agent.db.sha256"

APP_DIR="${ROLLBACK_APP}" bash "${ROLLBACK_SCRIPT}" >/dev/null
[[ "$(<"${ROLLBACK_APP}/release-marker")" == "v3-release" ]]
[[ "$(database_version "${ROLLBACK_APP}/agent_service/data/agent.db")" == "3" ]]
[[ "$(<"${ROLLBACK_APP}/outputs/runtime-marker")" == "current-output" ]]
shopt -s nullglob
replaced=("${ROLLBACK_APP}.replaced."*)
[[ "${#replaced[@]}" -eq 1 ]]
[[ "$(<"${replaced[0]}/release-marker")" == "v16-release" ]]
[[ "$(database_version "${replaced[0]}/agent_service/data/agent.db")" == "16" ]]
echo "[OK] Manual rollback paired v3 code with v3 data and retained the v16 database."
