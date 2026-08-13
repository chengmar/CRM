param(
  [string]$Workspace = "",
  [string]$EnvPath = "",
  [switch]$ConfirmConfigure,
  [ValidateRange(5, 60)]
  [int]$SshConnectTimeoutSeconds = 15
)

$ErrorActionPreference = "Stop"

function Get-PrivateEnvMap {
  param([string]$Path)

  $map = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line -split '=', 2
    $name = $parts[0].Trim()
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    $map[$name] = $parts[1].Trim().Trim('"').Trim("'")
  }
  return $map
}

if (-not $ConfirmConfigure) {
  throw "Feishu owner-role configuration requires -ConfirmConfigure. No remote connection or change was attempted."
}
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $Workspace = (Resolve-Path -LiteralPath $Workspace).Path
}
if ([string]::IsNullOrWhiteSpace($EnvPath)) { $EnvPath = Join-Path $Workspace ".env" }
if (-not (Test-Path -LiteralPath $EnvPath -PathType Leaf)) {
  throw "Private environment file is missing."
}

$envMap = Get-PrivateEnvMap -Path $EnvPath
foreach ($name in @("VPS_IP", "VPS_SSH_USER", "VPS_SSH_KEY_PATH")) {
  if ([string]::IsNullOrWhiteSpace([string]$envMap[$name])) {
    throw "Private SSH configuration is incomplete."
  }
}
if (-not (Test-Path -LiteralPath $envMap.VPS_SSH_KEY_PATH -PathType Leaf)) {
  throw "The configured SSH private key file is unavailable."
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { throw "ssh is not available." }

$remoteScript = @'
set -euo pipefail

APP_DIR="$HOME/export-ai-agent"
ENV_PATH="$APP_DIR/.env"
DB_PATH="$APP_DIR/agent_service/data/agent.db"
SERVICE_NAME="export-ai-agent-service"
DEPLOY_LOCK="${APP_DIR}.deploy.lock"
ENV_LOCK="${ENV_PATH}.update.lock"
BACKUP_PATH=""
CONFIGURATION_COMPLETE=false
BACKUP_READY=false

if [[ "${EUID}" -eq 0 ]]; then
  ROOT=()
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  ROOT=(sudo -n)
else
  printf 'REMOTE_RESULT=PREREQUISITE_FAILED\n'
  exit 20
fi

run_root() {
  "${ROOT[@]}" "$@"
}

restart_service() {
  run_root systemctl restart "${SERVICE_NAME}.service" >/dev/null 2>&1
}

wait_for_safe_health() {
  local health_file ready
  health_file="$(mktemp)"
  ready=false
  for _ in $(seq 1 60); do
    if run_root systemctl is-active --quiet "${SERVICE_NAME}.service" &&
       curl -fsS --max-time 5 http://127.0.0.1:18790/health -o "$health_file" &&
       python3 - "$health_file" <<'PY'
import json, pathlib, sys
health = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
if not health.get("ok") or health.get("outboundPaused") is not True:
    raise SystemExit(1)
PY
    then
      ready=true
      break
    fi
    sleep 1
  done
  rm -f -- "$health_file"
  [[ "$ready" == true ]]
}

rollback_configuration() {
  set +e
  rollback_ok=true
  if [[ "$BACKUP_READY" == true && -f "$BACKUP_PATH" ]]; then
    rollback_tmp="$(mktemp -p "$APP_DIR" .env.feishu-owner.rollback.XXXXXX)"
    cp -- "$BACKUP_PATH" "$rollback_tmp" >/dev/null 2>&1 || rollback_ok=false
    chmod 600 "$rollback_tmp" >/dev/null 2>&1 || rollback_ok=false
    if [[ "$rollback_ok" == true ]]; then
      mv -f -- "$rollback_tmp" "$ENV_PATH" >/dev/null 2>&1 || rollback_ok=false
    fi
    if [[ "$rollback_ok" == true ]] &&
       [[ "$(sha256sum "$BACKUP_PATH" 2>/dev/null | awk '{print $1}')" != "$(sha256sum "$ENV_PATH" 2>/dev/null | awk '{print $1}')" ]]; then
      rollback_ok=false
    fi
    if [[ "$rollback_ok" == true ]]; then
      restart_service || rollback_ok=false
    fi
    if [[ "$rollback_ok" == true ]]; then
      wait_for_safe_health || rollback_ok=false
    fi
    rm -f -- "$rollback_tmp" >/dev/null 2>&1
    if [[ "$rollback_ok" == true ]]; then
      rm -f -- "$BACKUP_PATH" >/dev/null 2>&1
      printf 'REMOTE_RESULT=ROLLED_BACK\n'
    else
      printf 'REMOTE_RESULT=ROLLBACK_FAILED\n'
    fi
  else
    printf 'REMOTE_RESULT=UNCHANGED\n'
  fi
}

on_exit() {
  exit_code=$?
  if [[ "$CONFIGURATION_COMPLETE" != true ]]; then
    rollback_configuration
  fi
  exit "$exit_code"
}
trap on_exit EXIT
trap 'exit 130' HUP INT TERM

if [[ ! -f "$ENV_PATH" || ! -f "$DB_PATH" ]] || [[ "$(stat -c %a "$ENV_PATH")" != "600" ]]; then
  printf 'REMOTE_RESULT=PREREQUISITE_FAILED\n'
  exit 21
fi
for command_name in flock python3 curl sha256sum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'REMOTE_RESULT=PREREQUISITE_FAILED\n'
    exit 22
  fi
done

exec 8>"$DEPLOY_LOCK"
if ! flock -w 15 8; then
  printf 'REMOTE_RESULT=LOCKED\n'
  exit 23
fi
exec 9>"$ENV_LOCK"
if ! flock -w 15 9; then
  printf 'REMOTE_RESULT=LOCKED\n'
  exit 24
fi
if ! wait_for_safe_health; then
  printf 'REMOTE_RESULT=PREREQUISITE_FAILED\n'
  exit 25
fi

BACKUP_PATH="$(mktemp -p "$APP_DIR" .env.feishu-owner.XXXXXX.bak)"
cp -- "$ENV_PATH" "$BACKUP_PATH"
chmod 600 "$BACKUP_PATH"
BACKUP_READY=true

set +e
MUTATION_CHANGED="$(python3 - "$ENV_PATH" "$DB_PATH" <<'PY'
import json, os, pathlib, re, sqlite3, sys, tempfile

path = pathlib.Path(sys.argv[1]).resolve()
database_path = pathlib.Path(sys.argv[2]).resolve()
raw = path.read_bytes()
if raw.startswith(b"\xef\xbb\xbf"):
    raise SystemExit(30)
text = raw.decode("utf-8")
newline = "\r\n" if "\r\n" in text else "\n"
lines = re.split(r"\r\n|\n|\r", text)
entry = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")
values = {}
indexes = {}

def unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value

for index, line in enumerate(lines):
    if re.match(r"^\s*#", line):
        continue
    match = entry.match(line)
    if not match:
        continue
    name, value = match.group(1), unquote(match.group(2))
    values.setdefault(name, []).append(value)
    indexes.setdefault(name, []).append(index)

managed = "FEISHU_TRUSTED_USER_ROLES"
if len(indexes.get(managed, [])) > 1:
    raise SystemExit(30)

existing = {}
if len(values.get(managed, [])) == 1 and values[managed][0].strip():
    try:
        existing = json.loads(values[managed][0])
    except Exception:
        raise SystemExit(30)
    if not isinstance(existing, dict):
        raise SystemExit(30)

candidates = set(existing.keys())
for name in ("FEISHU_ALLOWED_USERS", "FEISHU_MESSAGE_REVIEWER_USERS"):
    if len(values.get(name, [])) > 1:
        raise SystemExit(30)
    if len(values.get(name, [])) == 1:
        candidates.update(item.strip() for item in values[name][0].split(",") if item.strip())

connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
try:
    rows = connection.execute(
        "SELECT key FROM settings WHERE key LIKE 'feishu_user:%' ORDER BY key"
    ).fetchall()
finally:
    connection.close()
candidates.update(row[0][len("feishu_user:"):] for row in rows if row[0][len("feishu_user:"):])

if len(candidates) != 1:
    raise SystemExit(31)
owner = next(iter(candidates))
if not owner or owner.strip() != owner or re.search(r"\s", owner):
    raise SystemExit(30)

roles = [
    "ENGINEERING", "COMPLIANCE", "LOCALIZATION", "CONTENT_REVIEW", "PUBLISHER",
    "INBOUND_REVIEW", "SALES", "SALES_MANAGER", "CAMPAIGN_APPROVER",
    "BUDGET_APPROVER", "MARKET_REVIEW", "EXPERIMENT_REVIEW", "MESSAGE_REVIEWER",
]
target = {owner: roles}
serialized = json.dumps(target, ensure_ascii=True, separators=(",", ":"))
changed = existing != target

if len(indexes.get(managed, [])) == 1:
    if changed:
        lines[indexes[managed][0]] = f"{managed}={serialized}"
else:
    changed = True
    if lines and lines[-1] == "":
        lines.insert(len(lines) - 1, f"{managed}={serialized}")
    else:
        lines.append(f"{managed}={serialized}")

if changed:
    output = newline.join(lines)
    if text.endswith(("\r", "\n")) and not output.endswith(newline):
        output += newline
    fd, temporary = tempfile.mkstemp(prefix=".env.feishu-owner.", suffix=".tmp", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb", closefd=True) as stream:
            stream.write(output.encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
print("true" if changed else "false")
PY
)"
mutation_exit=$?
set -e
if [[ "$mutation_exit" -eq 31 ]]; then
  printf 'REMOTE_RESULT=OPERATOR_CANDIDATE_NOT_UNIQUE\n'
  exit 31
fi
if [[ "$mutation_exit" -ne 0 || ( "$MUTATION_CHANGED" != "true" && "$MUTATION_CHANGED" != "false" ) ]]; then
  printf 'REMOTE_RESULT=CONFIGURATION_INVALID\n'
  exit 30
fi
if [[ "$MUTATION_CHANGED" == "true" ]]; then
  restart_service
fi

HEALTH_FILE="$(mktemp)"
READY=false
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 http://127.0.0.1:18790/health -o "$HEALTH_FILE" &&
     python3 - "$HEALTH_FILE" <<'PY'
import json, pathlib, sys
health = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
if not health.get("ok") or health.get("outboundPaused") is not True:
    raise SystemExit(1)
if health.get("sensitiveOperatorConfigured") is not True:
    raise SystemExit(1)
PY
  then
    READY=true
    break
  fi
  sleep 1
done
rm -f -- "$HEALTH_FILE"
if [[ "$READY" != true || "$(stat -c %a "$ENV_PATH")" != "600" ]]; then
  exit 32
fi

rm -f -- "$BACKUP_PATH"
BACKUP_READY=false
CONFIGURATION_COMPLETE=true
printf 'REMOTE_RESULT=CONFIGURED\n'
printf 'SENSITIVE_OPERATOR_CONFIGURED=true\n'
printf 'OUTBOUND_PAUSED=true\n'
printf 'EMAIL_SENT=false\n'
'@

$remote = "$($envMap.VPS_SSH_USER)@$($envMap.VPS_IP)"
$sshArguments = @(
  "-i", $envMap.VPS_SSH_KEY_PATH,
  "-o", "BatchMode=yes",
  "-o", "IdentitiesOnly=yes",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "ConnectTimeout=$SshConnectTimeoutSeconds",
  "-o", "LogLevel=ERROR"
)
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  $remoteOutput = $remoteScript | & ssh @sshArguments $remote "bash -s" 2>$null
  $remoteExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousPreference
}
$remoteText = (($remoteOutput | ForEach-Object { [string]$_ }) -join "`n")
if ($remoteText -match '(?m)^REMOTE_RESULT=OPERATOR_CANDIDATE_NOT_UNIQUE$') {
  throw "Production has zero or multiple existing Feishu user candidates. No owner role was guessed; configuration was unchanged or rolled back."
}
if ($remoteExitCode -ne 0 -or $remoteText -notmatch '(?m)^REMOTE_RESULT=CONFIGURED$') {
  throw "Remote Feishu owner-role configuration failed. Production was unchanged or automatically rolled back."
}
foreach ($required in @(
  "SENSITIVE_OPERATOR_CONFIGURED=true",
  "OUTBOUND_PAUSED=true",
  "EMAIL_SENT=false"
)) {
  if ($remoteText -notmatch "(?m)^$([regex]::Escape($required))$") {
    throw "Remote Feishu owner-role configuration returned an incomplete safe-state attestation."
  }
}

Write-Host "[OK] Exactly one existing Feishu operator was assigned the complete owner role set."
Write-Host "[OK] Service health and the sensitive-operator readiness signal passed."
Write-Host "[OK] Global outbound remains paused; no email was sent."
