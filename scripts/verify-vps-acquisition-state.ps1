param(
  [string]$Workspace = "",
  [string]$EnvPath = ""
)

$ErrorActionPreference = "Stop"

function Stop-Verification {
  param(
    [string]$Step,
    [int]$ExitCode
  )

  [Console]::Out.WriteLine("VERIFY_STATUS=FAIL")
  [Console]::Out.WriteLine("FAILED_STEP=$Step")
  [Console]::Out.WriteLine("FAILED_EXIT_CODE=$ExitCode")
  exit $ExitCode
}

function Get-PrivateEnvMap {
  param([string]$Path)

  $result = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line -split '=', 2
    $name = $parts[0].Trim()
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    $result[$name] = $parts[1].Trim().Trim('"').Trim("'")
  }
  return $result
}

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  try {
    $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
  } catch {
    Stop-Verification -Step "LOCAL_WORKINSTALLATION_CONSTRAINT" -ExitCode 2
  }
} else {
  try {
    $Workspace = (Resolve-Path -LiteralPath $Workspace).Path
  } catch {
    Stop-Verification -Step "LOCAL_WORKINSTALLATION_CONSTRAINT" -ExitCode 2
  }
}

if ([string]::IsNullOrWhiteSpace($EnvPath)) {
  $EnvPath = Join-Path $Workspace ".env"
}
if (-not (Test-Path -LiteralPath $EnvPath -PathType Leaf)) {
  Stop-Verification -Step "LOCAL_PRIVATE_CONFIG" -ExitCode 2
}

try {
  $envMap = Get-PrivateEnvMap -Path $EnvPath
} catch {
  Stop-Verification -Step "LOCAL_PRIVATE_CONFIG" -ExitCode 2
}

foreach ($requiredName in @("VPS_IP", "VPS_SSH_USER")) {
  if ([string]::IsNullOrWhiteSpace([string]$envMap[$requiredName])) {
    Stop-Verification -Step "LOCAL_PRIVATE_CONFIG" -ExitCode 2
  }
}

$remote = "$($envMap.VPS_SSH_USER)@$($envMap.VPS_IP)"
if ([string]::IsNullOrWhiteSpace([string]$envMap.VPS_SSH_KEY_PATH) -or
    -not (Test-Path -LiteralPath $envMap.VPS_SSH_KEY_PATH -PathType Leaf)) {
  Stop-Verification -Step "LOCAL_SSH_KEY_REQUIRED" -ExitCode 2
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  Stop-Verification -Step "LOCAL_SSH_CLIENT" -ExitCode 2
}
$nativeCommand = "ssh"
$nativeArguments = @(
  "-i", $envMap.VPS_SSH_KEY_PATH,
  "-o", "BatchMode=yes",
  "-o", "IdentitiesOnly=yes",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "ConnectTimeout=15",
  "-o", "LogLevel=ERROR"
)

function Get-SpecDirectoryFingerprint {
  param([string]$Path)
  $files = @(Get-ChildItem -LiteralPath $Path -File -Filter "*.json" | Sort-Object Name)
  if ($files.Count -ne 6) { throw "invalid spec directory" }
  $entries = foreach ($file in $files) {
    $fileHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
    "$($file.Name):$fileHash"
  }
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($entries -join "`n"))
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return (($algorithm.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $algorithm.Dispose()
  }
}

$baseSpecDir = Join-Path $Workspace "config\production-research-specs-20260721"
$expandedSpecDir = Join-Path $Workspace "config\production-research-specs-expanded-20260721"
try {
  $baseSpecFingerprint = Get-SpecDirectoryFingerprint -Path $baseSpecDir
  $expandedSpecFingerprint = Get-SpecDirectoryFingerprint -Path $expandedSpecDir
} catch {
  Stop-Verification -Step "LOCAL_SPEC_DIRECTORIES" -ExitCode 2
}

$remoteQuery = @'
set -euo pipefail
cd "$HOME/export-ai-agent"

service_active="$(systemctl is-active export-ai-agent-service.service 2>/dev/null || true)"
service_enabled="$(systemctl is-enabled export-ai-agent-service.service 2>/dev/null || true)"
backup_active="$(systemctl is-active export-ai-agent-backup.timer 2>/dev/null || true)"
backup_enabled="$(systemctl is-enabled export-ai-agent-backup.timer 2>/dev/null || true)"
daily_active="$(systemctl is-active export-ai-agent-daily.timer 2>/dev/null || true)"
daily_enabled="$(systemctl is-enabled export-ai-agent-daily.timer 2>/dev/null || true)"
printf 'SERVICE_ACTIVE=%s\n' "${service_active:-unknown}"
printf 'SERVICE_ENABLED=%s\n' "${service_enabled:-unknown}"
printf 'BACKUP_TIMER_ACTIVE=%s\n' "${backup_active:-unknown}"
printf 'BACKUP_TIMER_ENABLED=%s\n' "${backup_enabled:-unknown}"
printf 'DAILY_TIMER_ACTIVE=%s\n' "${daily_active:-unknown}"
printf 'DAILY_TIMER_ENABLED=%s\n' "${daily_enabled:-unknown}"

service_pid="$(systemctl show export-ai-agent-service.service -p MainPID --value 2>/dev/null || true)"
process_config_current=false
process_code_current=false
if [[ "$service_pid" =~ ^[1-9][0-9]*$ && -d "/proc/$service_pid" ]]; then
  process_started="$(stat -c %Y "/proc/$service_pid")"
  config_modified="$(stat -c %Y .env)"
  code_modified="$(stat -c %Y agent_service/dist/search/discovery.js)"
  process_cwd="$(readlink -f "/proc/$service_pid/cwd")"
  expected_cwd="$(readlink -f agent_service)"
  if [[ "$process_started" -ge "$config_modified" ]]; then process_config_current=true; fi
  if [[ "$process_started" -ge "$code_modified" && "$process_cwd" == "$expected_cwd" ]]; then process_code_current=true; fi
fi
printf 'PROCESS_CONFIG_CURRENT=%s\n' "$process_config_current"
printf 'PROCESS_CODE_CURRENT=%s\n' "$process_code_current"

runtime_budget="$(cd agent_service && node --input-type=module -e "import('./dist/config.js').then(({config})=>process.stdout.write(String(config.MAX_PAGES_PER_CAMPAIGN)))")"
case "$runtime_budget" in
  ''|*[!0-9]*) exit 41 ;;
esac
printf 'RUNTIME_PAGE_BUDGET=%s\n' "$runtime_budget"
database_path="$(cd agent_service && node --input-type=module -e "import('./dist/config.js').then(({config})=>process.stdout.write(String(config.AGENT_DB_PATH)))")"
if [[ -z "$database_path" ]]; then
  exit 42
fi

if ! grep -Eq 'fitScore[[:space:]]*>=' agent_service/dist/search/discovery.js &&
   grep -Fq 'fitScore: analysis.fitScore' agent_service/dist/search/discovery.js; then
  printf 'BROAD_ICP_FIT_RANK_ONLY=true\n'
else
  printf 'BROAD_ICP_FIT_RANK_ONLY=false\n'
fi
if grep -Fq 'const BROAD_ICP_PRODUCT_MATCH_MIN = 1;' agent_service/dist/search/discovery.js; then
  printf 'BROAD_ICP_PRODUCT_MIN_1=true\n'
else
  printf 'BROAD_ICP_PRODUCT_MIN_1=false\n'
fi
if grep -Fq 'const qualified = evidence.length >= 1 &&' agent_service/dist/search/discovery.js &&
   grep -Fq 'matchedProducts.length >= BROAD_ICP_PRODUCT_MATCH_MIN;' agent_service/dist/search/discovery.js; then
  printf 'BROAD_ICP_PUBLIC_EVIDENCE_GATE=true\n'
else
  printf 'BROAD_ICP_PUBLIC_EVIDENCE_GATE=false\n'
fi
qualified_evidence_count="$(grep -Fc 'const qualified = evidence.length >= 1 &&' agent_service/dist/search/discovery.js || true)"
fallback_product_count="$(grep -Fc 'productMatches.length >= BROAD_ICP_PRODUCT_MATCH_MIN;' agent_service/dist/search/discovery.js || true)"
llm_product_count="$(grep -Fc 'matchedProducts.length >= BROAD_ICP_PRODUCT_MATCH_MIN;' agent_service/dist/search/discovery.js || true)"
if [[ "$qualified_evidence_count" -ge 2 &&
      "$fallback_product_count" -ge 1 && "$llm_product_count" -ge 1 ]] &&
   ! grep -Eq 'fitScore[[:space:]]*>=' agent_service/dist/search/discovery.js &&
   ! grep -Fq 'intentScore >= 6 ||' agent_service/dist/search/discovery.js &&
   ! grep -Fq '(productMatches.length >= BROAD_ICP_PRODUCT_MATCH_MIN && buyerMatches.length >= 1)' agent_service/dist/search/discovery.js; then
  printf 'BROAD_ICP_NO_INTENT_REQUIRED=true\n'
else
  printf 'BROAD_ICP_NO_INTENT_REQUIRED=false\n'
fi

python3 - "$database_path" <<'PY'
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

database = Path(sys.argv[1]).resolve()
connection = sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)
try:
    connection.execute("PRAGMA query_only=ON")
    print(f"DB_SCHEMA={connection.execute('PRAGMA user_version').fetchone()[0]}")
    quick = connection.execute("PRAGMA quick_check").fetchone()[0]
    print(f"DB_QUICK_CHECK={quick}")
    print(f"DB_FOREIGN_KEY_VIOLATIONS={len(connection.execute('PRAGMA foreign_key_check').fetchall())}")

    def setting(name):
        row = connection.execute("SELECT value FROM settings WHERE key=?", (name,)).fetchone()
        return str(row[0]).strip().lower() if row else "missing"

    def count(table):
        return connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]

    print(f"OUTBOUND_PAUSED={setting('outbound_paused')}")
    print(f"DAILY_RESEARCH_ENABLED={setting('daily_research_enabled')}")
    print(f"CAMPAIGN_COUNT={count('campaigns')}")
    print(f"CAMPAIGN_TARGET_TOTAL={connection.execute('SELECT coalesce(sum(target_count),0) FROM campaigns').fetchone()[0]}")
    print(f"LEAD_COUNT={count('leads')}")
    print(f"CONTACT_COUNT={count('contacts')}")
    print(f"OUTBOUND_MESSAGE_COUNT={count('outbound_messages')}")
    print(f"CAMPAIGN_SEND_AUTH_COUNT={count('campaign_send_authorizations')}")
    print(f"MESSAGE_SEND_AUTH_COUNT={count('campaign_message_authorizations')}")
    print(f"AUTHORIZED_CAMPAIGN_COUNT={connection.execute('SELECT count(DISTINCT campaign_id) FROM campaign_send_authorizations').fetchone()[0]}")
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    active_authorization_predicate = """
        csa.external_send_authorized=1
        AND csa.authorized_actor_type='HUMAN'
        AND csa.transport='SMTP'
        AND csa.total_limit>0
        AND csa.daily_limit BETWEEN 1 AND csa.total_limit
        AND csa.hourly_limit BETWEEN 1 AND csa.daily_limit
        AND csa.maximum_sequence_index=0
        AND csa.valid_from<=?
        AND csa.expires_at>?
        AND cb.current_version_id=csa.version_id
        AND cb.external_send_authorized=1
        AND cv.id=csa.version_id
        AND cv.brief_id=csa.brief_id
        AND cv.brief_hash=csa.brief_hash
        AND upper(json_extract(cv.brief_json, '$.transport'))='SMTP'
        AND ca.id=csa.campaign_approval_id
        AND ca.brief_id=csa.brief_id
        AND ca.version_id=csa.version_id
        AND ca.brief_hash=csa.brief_hash
        AND ca.scope='EXTERNAL_SEND'
        AND ca.approved_actor_type='HUMAN'
        AND NOT EXISTS (
            SELECT 1 FROM campaign_send_authorization_revocations revocation
            WHERE revocation.campaign_send_authorization_id=csa.id
        )
    """
    active_authorized_campaigns = connection.execute(
        f"""SELECT count(DISTINCT csa.campaign_id)
            FROM campaign_send_authorizations csa
            JOIN campaign_briefs cb ON cb.id=csa.brief_id
            JOIN campaign_versions cv ON cv.id=csa.version_id
            JOIN campaign_approvals ca ON ca.id=csa.campaign_approval_id
            WHERE {active_authorization_predicate}""",
        (now, now),
    ).fetchone()[0]
    print(f"ACTIVE_AUTHORIZED_CAMPAIGN_COUNT={active_authorized_campaigns}")
    invalid_campaign_authorizations = connection.execute(
        """SELECT count(*)
           FROM campaign_send_authorizations csa
           JOIN campaign_briefs cb ON cb.id=csa.brief_id
           JOIN campaign_versions cv ON cv.id=csa.version_id
           JOIN campaign_approvals ca ON ca.id=csa.campaign_approval_id
           WHERE csa.external_send_authorized<>1
              OR csa.authorized_actor_type<>'HUMAN'
              OR csa.transport<>'SMTP'
              OR csa.total_limit<=0
              OR csa.daily_limit NOT BETWEEN 1 AND csa.total_limit
              OR csa.hourly_limit NOT BETWEEN 1 AND csa.daily_limit
              OR csa.maximum_sequence_index<>0
              OR csa.expires_at<=csa.valid_from
              OR cv.brief_id<>csa.brief_id
              OR cv.brief_hash<>csa.brief_hash
              OR coalesce(upper(json_extract(cv.brief_json, '$.transport')), '')<>'SMTP'
              OR ca.brief_id<>csa.brief_id
              OR ca.version_id<>csa.version_id
              OR ca.brief_hash<>csa.brief_hash
              OR ca.scope<>'EXTERNAL_SEND'
              OR ca.approved_actor_type<>'HUMAN'"""
    ).fetchone()[0]
    print(f"INVALID_CAMPAIGN_SEND_AUTH_COUNT={invalid_campaign_authorizations}")
    invalid_message_authorizations = connection.execute(
        """SELECT count(*)
           FROM campaign_message_authorizations cma
           JOIN campaign_send_authorizations csa ON csa.id=cma.campaign_send_authorization_id
           JOIN outbound_messages om ON om.id=cma.outbound_message_id
           JOIN message_versions mv ON mv.id=cma.message_version_id
           WHERE cma.send_authorized<>1
              OR cma.decision<>'AUTO_SEND_ELIGIBLE'
              OR cma.evaluated_by<>'SYSTEM'
              OR cma.policy_hash<>csa.policy_hash
              OR cma.review_hash<>mv.review_hash
              OR cma.content_hash<>mv.content_hash
              OR coalesce(om.current_version_id, '')<>mv.id
              OR om.campaign_id<>csa.campaign_id"""
    ).fetchone()[0]
    print(f"INVALID_MESSAGE_SEND_AUTH_COUNT={invalid_message_authorizations}")
    expanded_predicate = "json_extract(payload_json,'$.launchKey') LIKE '%expanded%'"
    expanded_campaigns = f"SELECT DISTINCT json_extract(payload_json,'$.campaignId') FROM jobs WHERE {expanded_predicate}"
    print(f"EXPANDED_JOB_COUNT={connection.execute(f'SELECT count(*) FROM jobs WHERE {expanded_predicate}').fetchone()[0]}")
    for status in ("QUEUED", "RUNNING", "COMPLETED", "FAILED"):
        value = connection.execute(
            f"SELECT count(*) FROM jobs WHERE {expanded_predicate} AND status=?", (status,)
        ).fetchone()[0]
        print(f"EXPANDED_JOB_{status}={value}")
    print(f"EXPANDED_LEAD_COUNT={connection.execute(f'SELECT count(*) FROM leads WHERE campaign_id IN ({expanded_campaigns})').fetchone()[0]}")
    print(f"EXPANDED_CONTACT_COUNT={connection.execute(f'SELECT count(*) FROM contacts WHERE lead_id IN (SELECT id FROM leads WHERE campaign_id IN ({expanded_campaigns}))').fetchone()[0]}")
    expanded_contacts = f"SELECT * FROM contacts WHERE lead_id IN (SELECT id FROM leads WHERE campaign_id IN ({expanded_campaigns}))"
    email_count = connection.execute(
        f"SELECT count(*) FROM ({expanded_contacts}) WHERE trim(coalesce(email,''))<>''"
    ).fetchone()[0]
    print(f"EXPANDED_CONTACT_WITH_EMAIL_COUNT={email_count}")
    for tier in ("A", "B", "C"):
        value = connection.execute(
            f"SELECT count(*) FROM ({expanded_contacts}) WHERE recipient_tier=?", (tier,)
        ).fetchone()[0]
        print(f"EXPANDED_TIER_{tier}_COUNT={value}")
    print(f"EXPANDED_OUTBOUND_COUNT={connection.execute(f'SELECT count(*) FROM outbound_messages WHERE campaign_id IN ({expanded_campaigns})').fetchone()[0]}")
finally:
    connection.close()
PY

if [[ -d private ]]; then
  printf 'PRIVATE_ROOT_PRESENT=true\n'
  printf 'PRIVATE_ROOT_MODE=%s\n' "$(stat -c %a private)"
else
  printf 'PRIVATE_ROOT_PRESENT=false\n'
  printf 'PRIVATE_ROOT_MODE=NA\n'
fi
if [[ -d "$HOME/export-ai-agent.previous" ]]; then
  printf 'OLD_PREVIOUS_RELEASE_PRESENT=true\n'
else
  printf 'OLD_PREVIOUS_RELEASE_PRESENT=false\n'
fi
if [[ -d "$HOME/export-ai-agent.rollback-state" ]]; then
  printf 'OLD_ROLLBACK_STATE_PRESENT=true\n'
else
  printf 'OLD_ROLLBACK_STATE_PRESENT=false\n'
fi
old_home_zip_count="$(find "$HOME" -maxdepth 1 -type f -name 'export-ai-agent-deployment-*.zip' | wc -l | tr -d ' ')"
printf 'OLD_HOME_PACKAGE_COUNT=%s\n' "$old_home_zip_count"
active_manifest_count="$(find private -type f -name manifest.json ! -path '*.previous.*' | wc -l | tr -d ' ')"
backup_manifest_count="$(find private -type f -name manifest.json -path '*.previous.*' | wc -l | tr -d ' ')"
expanded_label_count=0
while IFS= read -r -d '' manifest; do
  if python3 - "$manifest" <<'PY'
import json
import pathlib
import sys
try:
    value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
    valid = value.get("runLabel") == "expanded"
except Exception:
    valid = False
raise SystemExit(0 if valid else 1)
PY
  then
    expanded_label_count=$((expanded_label_count + 1))
  fi
done < <(find private -type f -name manifest.json ! -path '*.previous.*' -print0)
printf 'PRIVATE_ACTIVE_MANIFEST_COUNT=%s\n' "$active_manifest_count"
printf 'PRIVATE_BACKUP_MANIFEST_COUNT=%s\n' "$backup_manifest_count"
printf 'PRIVATE_EXPANDED_LABEL_COUNT=%s\n' "$expanded_label_count"
private_scan_ok=false
if python3 - <<'PY'
import hashlib
import json
import pathlib
import stat

counts = {"policy": 0, "five": 0, "target": 0, "action": 0, "transport": 0}
base_matches = []
expanded_matches = []

def directory_fingerprint(root):
    files = sorted(root.glob("*.json"), key=lambda path: path.name)
    if len(files) != 6:
        return ""
    material = "\n".join(f"{path.name}:{hashlib.sha256(path.read_bytes()).hexdigest()}" for path in files)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()

for manifest_path in pathlib.Path("private").rglob("manifest.json"):
    if ".previous." in manifest_path.as_posix():
        continue
    try:
        fingerprint = directory_fingerprint(manifest_path.parent)
        if fingerprint == "__BASE_SPEC_FINGERPRINT__":
            base_matches.append(manifest_path.parent)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        if manifest.get("runLabel") != "expanded":
            continue
        specs = [json.loads(path.read_text(encoding="utf-8-sig")) for path in manifest_path.parent.glob("*.json") if path.name != "manifest.json"]
        if manifest.get("targetTotal") == 500 and manifest.get("externalSendAuthorized") is False:
            counts["policy"] += 1
        if len(specs) == 5:
            counts["five"] += 1
        if len(specs) == 5 and sum(int(spec["campaign"]["targetCount"]) for spec in specs) == 500:
            counts["target"] += 1
        if len(specs) == 5 and len({str(spec["actionId"]) for spec in specs}) == 5 and all(str(spec["actionId"]).endswith(":expanded") for spec in specs):
            counts["action"] += 1
        if len(specs) == 5 and all(spec["brief"].get("transport") == "NONE" for spec in specs):
            counts["transport"] += 1
        if fingerprint == "__EXPANDED_SPEC_FINGERPRINT__" and (
            manifest.get("targetTotal") == 500
            and manifest.get("externalSendAuthorized") is False
            and len(specs) == 5
            and sum(int(spec["campaign"]["targetCount"]) for spec in specs) == 500
            and len({str(spec["actionId"]) for spec in specs}) == 5
            and all(str(spec["actionId"]).endswith(":expanded") for spec in specs)
            and all(spec["brief"].get("transport") == "NONE" for spec in specs)
        ):
            expanded_matches.append(manifest_path.parent)
    except Exception:
        pass
print(f"PRIVATE_EXPANDED_POLICY_COUNT={counts['policy']}")
print(f"PRIVATE_EXPANDED_FIVE_SPEC_COUNT={counts['five']}")
print(f"PRIVATE_EXPANDED_TARGET_COUNT={counts['target']}")
print(f"PRIVATE_EXPANDED_ACTION_COUNT={counts['action']}")
print(f"PRIVATE_EXPANDED_TRANSPORT_COUNT={counts['transport']}")
print(f"PRIVATE_BASE_FINGERPRINT_MATCH_COUNT={len(base_matches)}")
print(f"PRIVATE_EXPANDED_FINGERPRINT_MATCH_COUNT={len(expanded_matches)}")
all_manifest_directories = {path.parent.resolve() for path in pathlib.Path("private").rglob("manifest.json")}
current_directories = {path.resolve() for path in base_matches + expanded_matches}
print(f"PRIVATE_OLD_SPEC_DIR_COUNT={len(all_manifest_directories - current_directories)}")

def emit(label, matches):
    if not matches:
        print(f"{label}_PRESENT=false")
        print(f"{label}_DIR_MODE=NA")
        print(f"{label}_FILE_COUNT=0")
        print(f"{label}_BAD_FILE_MODE_COUNT=0")
        return
    try:
        selected = max(matches, key=lambda path: (path / "manifest.json").stat().st_mtime_ns)
        files = [item for item in selected.iterdir() if item.is_file()]
        print(f"{label}_PRESENT=true")
        print(f"{label}_DIR_MODE={stat.S_IMODE(selected.stat().st_mode):o}")
        print(f"{label}_FILE_COUNT={len(files)}")
        print(f"{label}_BAD_FILE_MODE_COUNT={sum(stat.S_IMODE(item.stat().st_mode) != 0o600 for item in files)}")
    except Exception:
        print(f"{label}_PRESENT=false")
        print(f"{label}_DIR_MODE=NA")
        print(f"{label}_FILE_COUNT=0")
        print(f"{label}_BAD_FILE_MODE_COUNT=0")

emit("PRIVATE_BASE", base_matches)
emit("PRIVATE_EXPANDED", expanded_matches)
PY
then
  private_scan_ok=true
fi
printf 'PRIVATE_SCAN_OK=%s\n' "$private_scan_ok"
'@
$remoteQuery = $remoteQuery.Replace("__BASE_SPEC_FINGERPRINT__", $baseSpecFingerprint)
$remoteQuery = $remoteQuery.Replace("__EXPANDED_SPEC_FINGERPRINT__", $expandedSpecFingerprint)

$previousPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  $rawOutput = $remoteQuery | & $nativeCommand @nativeArguments $remote "bash -s" 2>$null
  $remoteExitCode = $LASTEXITCODE
} catch {
  $rawOutput = @()
  $remoteExitCode = 255
} finally {
  $ErrorActionPreference = $previousPreference
}
if ($remoteExitCode -ne 0) {
  Stop-Verification -Step "REMOTE_STATE_QUERY" -ExitCode $remoteExitCode
}

$allowedKeys = @(
  "SERVICE_ACTIVE",
  "SERVICE_ENABLED",
  "BACKUP_TIMER_ACTIVE",
  "BACKUP_TIMER_ENABLED",
  "DAILY_TIMER_ACTIVE",
  "DAILY_TIMER_ENABLED",
  "PROCESS_CONFIG_CURRENT",
  "PROCESS_CODE_CURRENT",
  "RUNTIME_PAGE_BUDGET",
  "BROAD_ICP_FIT_RANK_ONLY",
  "BROAD_ICP_PRODUCT_MIN_1",
  "BROAD_ICP_PUBLIC_EVIDENCE_GATE",
  "BROAD_ICP_NO_INTENT_REQUIRED",
  "DB_SCHEMA",
  "DB_QUICK_CHECK",
  "DB_FOREIGN_KEY_VIOLATIONS",
  "OUTBOUND_PAUSED",
  "DAILY_RESEARCH_ENABLED",
  "CAMPAIGN_COUNT",
  "CAMPAIGN_TARGET_TOTAL",
  "LEAD_COUNT",
  "CONTACT_COUNT",
  "OUTBOUND_MESSAGE_COUNT",
  "CAMPAIGN_SEND_AUTH_COUNT",
  "MESSAGE_SEND_AUTH_COUNT",
  "AUTHORIZED_CAMPAIGN_COUNT",
  "ACTIVE_AUTHORIZED_CAMPAIGN_COUNT",
  "INVALID_CAMPAIGN_SEND_AUTH_COUNT",
  "INVALID_MESSAGE_SEND_AUTH_COUNT",
  "EXPANDED_JOB_COUNT",
  "EXPANDED_JOB_QUEUED",
  "EXPANDED_JOB_RUNNING",
  "EXPANDED_JOB_COMPLETED",
  "EXPANDED_JOB_FAILED",
  "EXPANDED_LEAD_COUNT",
  "EXPANDED_CONTACT_COUNT",
  "EXPANDED_CONTACT_WITH_EMAIL_COUNT",
  "EXPANDED_TIER_A_COUNT",
  "EXPANDED_TIER_B_COUNT",
  "EXPANDED_TIER_C_COUNT",
  "EXPANDED_OUTBOUND_COUNT",
  "PRIVATE_ROOT_PRESENT",
  "PRIVATE_ROOT_MODE",
  "OLD_PREVIOUS_RELEASE_PRESENT",
  "OLD_ROLLBACK_STATE_PRESENT",
  "OLD_HOME_PACKAGE_COUNT",
  "PRIVATE_ACTIVE_MANIFEST_COUNT",
  "PRIVATE_BACKUP_MANIFEST_COUNT",
  "PRIVATE_EXPANDED_LABEL_COUNT",
  "PRIVATE_EXPANDED_POLICY_COUNT",
  "PRIVATE_EXPANDED_FIVE_SPEC_COUNT",
  "PRIVATE_EXPANDED_TARGET_COUNT",
  "PRIVATE_EXPANDED_ACTION_COUNT",
  "PRIVATE_EXPANDED_TRANSPORT_COUNT",
  "PRIVATE_BASE_FINGERPRINT_MATCH_COUNT",
  "PRIVATE_EXPANDED_FINGERPRINT_MATCH_COUNT",
  "PRIVATE_OLD_SPEC_DIR_COUNT",
  "PRIVATE_SCAN_OK",
  "PRIVATE_BASE_PRESENT",
  "PRIVATE_BASE_DIR_MODE",
  "PRIVATE_BASE_FILE_COUNT",
  "PRIVATE_BASE_BAD_FILE_MODE_COUNT",
  "PRIVATE_EXPANDED_PRESENT",
  "PRIVATE_EXPANDED_DIR_MODE",
  "PRIVATE_EXPANDED_FILE_COUNT",
  "PRIVATE_EXPANDED_BAD_FILE_MODE_COUNT"
)
$allowedKeySet = @{}
foreach ($key in $allowedKeys) { $allowedKeySet[$key] = $true }

$state = @{}
foreach ($item in @($rawOutput)) {
  $line = ([string]$item).Trim()
  if ($line -notmatch '^([A-Z0-9_]+)=([A-Za-z0-9._-]+)$') { continue }
  $key = $Matches[1]
  $value = $Matches[2]
  if (-not $allowedKeySet.ContainsKey($key)) { continue }
  if ($state.ContainsKey($key)) {
    Stop-Verification -Step "REMOTE_OUTPUT_PARSE" -ExitCode 65
  }
  $state[$key] = $value
}

foreach ($key in $allowedKeys) {
  if (-not $state.ContainsKey($key)) {
    Stop-Verification -Step "REMOTE_OUTPUT_PARSE" -ExitCode 65
  }
}

$numericKeys = @(
  "RUNTIME_PAGE_BUDGET",
  "DB_SCHEMA",
  "DB_FOREIGN_KEY_VIOLATIONS",
  "CAMPAIGN_COUNT",
  "CAMPAIGN_TARGET_TOTAL",
  "LEAD_COUNT",
  "CONTACT_COUNT",
  "OUTBOUND_MESSAGE_COUNT",
  "CAMPAIGN_SEND_AUTH_COUNT",
  "MESSAGE_SEND_AUTH_COUNT",
  "AUTHORIZED_CAMPAIGN_COUNT",
  "ACTIVE_AUTHORIZED_CAMPAIGN_COUNT",
  "INVALID_CAMPAIGN_SEND_AUTH_COUNT",
  "INVALID_MESSAGE_SEND_AUTH_COUNT",
  "OLD_HOME_PACKAGE_COUNT",
  "PRIVATE_OLD_SPEC_DIR_COUNT",
  "PRIVATE_BASE_FINGERPRINT_MATCH_COUNT",
  "PRIVATE_EXPANDED_FINGERPRINT_MATCH_COUNT",
  "PRIVATE_BASE_FILE_COUNT",
  "PRIVATE_BASE_BAD_FILE_MODE_COUNT",
  "PRIVATE_EXPANDED_FILE_COUNT",
  "PRIVATE_EXPANDED_BAD_FILE_MODE_COUNT"
)
foreach ($key in $numericKeys) {
  if ([string]$state[$key] -notmatch '^\d+$') {
    Stop-Verification -Step "REMOTE_OUTPUT_PARSE" -ExitCode 65
  }
}

foreach ($key in $allowedKeys) {
  [Console]::Out.WriteLine("$key=$($state[$key])")
}

$assertions = @(
  [pscustomobject]@{ Step = "ASSERT_SERVICE"; Passed = $state.SERVICE_ACTIVE -eq "active" -and $state.SERVICE_ENABLED -eq "enabled" },
  [pscustomobject]@{ Step = "ASSERT_BACKUP_TIMER"; Passed = $state.BACKUP_TIMER_ACTIVE -eq "active" -and $state.BACKUP_TIMER_ENABLED -eq "enabled" },
  [pscustomobject]@{ Step = "ASSERT_DAILY_TIMER"; Passed = $state.DAILY_TIMER_ACTIVE -ne "active" -and $state.DAILY_TIMER_ENABLED -ne "enabled" },
  [pscustomobject]@{ Step = "ASSERT_RUNNING_PROCESS"; Passed = $state.PROCESS_CONFIG_CURRENT -eq "true" -and $state.PROCESS_CODE_CURRENT -eq "true" },
  [pscustomobject]@{ Step = "ASSERT_RUNTIME_BUDGET"; Passed = $state.RUNTIME_PAGE_BUDGET -eq "1600" },
  [pscustomobject]@{ Step = "ASSERT_BROAD_ICP"; Passed = $state.BROAD_ICP_FIT_RANK_ONLY -eq "true" -and
      $state.BROAD_ICP_PRODUCT_MIN_1 -eq "true" -and
      $state.BROAD_ICP_PUBLIC_EVIDENCE_GATE -eq "true" -and
      $state.BROAD_ICP_NO_INTENT_REQUIRED -eq "true" },
  [pscustomobject]@{ Step = "ASSERT_DATABASE"; Passed = [int]$state.DB_SCHEMA -ge 18 -and
      $state.DB_QUICK_CHECK -eq "ok" -and
      $state.DB_FOREIGN_KEY_VIOLATIONS -eq "0" },
  [pscustomobject]@{ Step = "ASSERT_RUNTIME_SWITCHES"; Passed = $state.OUTBOUND_PAUSED -in @("true", "false") -and
      $state.DAILY_RESEARCH_ENABLED -eq "false" },
  [pscustomobject]@{ Step = "ASSERT_PRESERVED_COUNTS"; Passed = [int]$state.CAMPAIGN_COUNT -ge 5 -and
      [int]$state.LEAD_COUNT -ge 9 -and
      [int]$state.CONTACT_COUNT -ge 6 },
  [pscustomobject]@{ Step = "ASSERT_AUTHORIZATION_LEDGER"; Passed =
      [int]$state.ACTIVE_AUTHORIZED_CAMPAIGN_COUNT -ge 5 -and
      [int]$state.AUTHORIZED_CAMPAIGN_COUNT -ge [int]$state.ACTIVE_AUTHORIZED_CAMPAIGN_COUNT -and
      [int]$state.CAMPAIGN_SEND_AUTH_COUNT -ge [int]$state.AUTHORIZED_CAMPAIGN_COUNT -and
      $state.INVALID_CAMPAIGN_SEND_AUTH_COUNT -eq "0" -and
      $state.INVALID_MESSAGE_SEND_AUTH_COUNT -eq "0" -and
      [int]$state.MESSAGE_SEND_AUTH_COUNT -le [int]$state.OUTBOUND_MESSAGE_COUNT -and
      $state.EXPANDED_OUTBOUND_COUNT -eq "0" },
  [pscustomobject]@{ Step = "ASSERT_PRIVATE_ROOT"; Passed = $state.PRIVATE_ROOT_PRESENT -eq "true" -and
      $state.PRIVATE_ROOT_MODE -eq "700" },
  [pscustomobject]@{ Step = "ASSERT_PRIVATE_SCAN"; Passed = $state.PRIVATE_SCAN_OK -eq "true" },
  [pscustomobject]@{ Step = "ASSERT_PRIVATE_BASE"; Passed = $state.PRIVATE_BASE_PRESENT -eq "true" -and
      $state.PRIVATE_BASE_FINGERPRINT_MATCH_COUNT -eq "1" -and
      $state.PRIVATE_BASE_DIR_MODE -eq "700" -and
      $state.PRIVATE_BASE_FILE_COUNT -eq "6" -and
      $state.PRIVATE_BASE_BAD_FILE_MODE_COUNT -eq "0" },
  [pscustomobject]@{ Step = "ASSERT_PRIVATE_EXPANDED"; Passed = $state.PRIVATE_EXPANDED_PRESENT -eq "true" -and
      $state.PRIVATE_EXPANDED_FINGERPRINT_MATCH_COUNT -eq "1" -and
      $state.PRIVATE_EXPANDED_DIR_MODE -eq "700" -and
      $state.PRIVATE_EXPANDED_FILE_COUNT -eq "6" -and
      $state.PRIVATE_EXPANDED_BAD_FILE_MODE_COUNT -eq "0" }
)

foreach ($assertion in $assertions) {
  if (-not [bool]$assertion.Passed) {
    Stop-Verification -Step ([string]$assertion.Step) -ExitCode 1
  }
}

[Console]::Out.WriteLine("VERIFY_STATUS=PASS")
exit 0
