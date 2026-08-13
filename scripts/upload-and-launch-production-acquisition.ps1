param(
  [string]$Workspace = "",
  [string]$EnvPath = "",
  [switch]$ConfirmUpload,
  [switch]$ConfirmLaunch
)

$ErrorActionPreference = "Stop"

function Stop-Launch {
  param([string]$Step, [int]$ExitCode)
  [Console]::Out.WriteLine("PRODUCTION_ACQUISITION_STATUS=FAIL")
  [Console]::Out.WriteLine("FAILED_STEP=$Step")
  exit $ExitCode
}

function Get-PrivateEnvMap {
  param([string]$Path)
  $map = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line -split '=', 2
    $name = $parts[0].Trim()
    if ($name) { $map[$name] = $parts[1].Trim().Trim('"').Trim("'") }
  }
  return $map
}

if (-not $ConfirmUpload) { Stop-Launch -Step "UPLOAD_CONFIRMATION_REQUIRED" -ExitCode 2 }
if (-not $ConfirmLaunch) { Stop-Launch -Step "LAUNCH_CONFIRMATION_REQUIRED" -ExitCode 2 }

try {
  $Workspace = if ($Workspace) {
    (Resolve-Path -LiteralPath $Workspace).Path
  } else {
    (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
  }
  if (-not $EnvPath) { $EnvPath = Join-Path $Workspace ".env" }
  $specsDir = (Resolve-Path -LiteralPath (
    Join-Path $Workspace "config\production-acquisition-specs-20260721"
  )).Path
} catch {
  Stop-Launch -Step "LOCAL_PATHS" -ExitCode 2
}

$expectedNames = @(
  "manifest.json",
  "indonesia-sample-product-20260721.json",
  "malaysia-sample-product-20260721.json",
  "mexico-sample-product-20260721.json",
  "philippines-sample-product-20260721.json",
  "vietnam-sample-product-20260721.json"
)

try {
  $files = @(Get-ChildItem -LiteralPath $specsDir -File -Filter "*.json" | Sort-Object Name)
  if (($files.Name -join "`n") -ne (($expectedNames | Sort-Object) -join "`n")) {
    throw "unexpected production acquisition files"
  }
  $manifest = Get-Content -LiteralPath (Join-Path $specsDir "manifest.json") -Raw -Encoding UTF8 |
    ConvertFrom-Json
  if (
    [string]$manifest.planId -ne "demo_manufacturer-outbound-20260721" -or
    [int]$manifest.targetTotal -ne 500 -or
    @($manifest.campaigns).Count -ne 5
  ) {
    throw "invalid manifest"
  }

  $specFiles = @($files | Where-Object Name -ne "manifest.json")
  $targetTotal = 0
  $launchKeys = New-Object Collections.Generic.List[string]
  $actionIds = New-Object Collections.Generic.List[string]
  foreach ($file in $specFiles) {
    $spec = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    $target = [int]$spec.campaign.targetCount
    $targetTotal += $target
    $launchKeys.Add([string]$spec.launchKey)
    $actionIds.Add([string]$spec.actionId)
    $providers = @($spec.brief.providerBudget.allowedProviders | Sort-Object) -join ","
    if (
      [string]$spec.brief.transport -ne "SMTP" -or
      [int]$spec.brief.targetCount -ne $target -or
      [int]$spec.limits.total -ne $target -or
      [int]$spec.limits.daily -le 0 -or
      [int]$spec.limits.hourly -le 0 -or
      [string]$spec.sellerKnowledge.profile.sender.email -ne "sales@example.com" -or
      @($spec.sellerKnowledge.privateCases).Count -ne 0 -or
      $providers -ne "bouncer,local-public-web,searxng" -or
      [string]$spec.authorization.source -ne "THREAD_EXPLICIT_AUTHORIZATION"
    ) {
      throw "invalid production acquisition spec"
    }
  }
  if (
    $targetTotal -ne 500 -or
    @($launchKeys | Sort-Object -Unique).Count -ne 5 -or
    @($actionIds | Sort-Object -Unique).Count -ne 5
  ) {
    throw "invalid aggregate launch authority"
  }
} catch {
  Stop-Launch -Step "LOCAL_SPEC_VALIDATION" -ExitCode 3
}

if (-not (Test-Path -LiteralPath $EnvPath -PathType Leaf)) {
  Stop-Launch -Step "LOCAL_PRIVATE_CONFIG" -ExitCode 2
}
try {
  $envMap = Get-PrivateEnvMap -Path $EnvPath
} catch {
  Stop-Launch -Step "LOCAL_PRIVATE_CONFIG" -ExitCode 2
}
foreach ($name in @("VPS_IP", "VPS_SSH_USER", "VPS_SSH_KEY_PATH")) {
  if (-not [string]$envMap[$name]) { Stop-Launch -Step "LOCAL_PRIVATE_CONFIG" -ExitCode 2 }
}
if (
  -not (Test-Path -LiteralPath $envMap.VPS_SSH_KEY_PATH -PathType Leaf) -or
  -not (Get-Command ssh -ErrorAction SilentlyContinue) -or
  -not (Get-Command scp -ErrorAction SilentlyContinue)
) {
  Stop-Launch -Step "LOCAL_SSH_KEY_REQUIRED" -ExitCode 2
}

$remote = "$($envMap.VPS_SSH_USER)@$($envMap.VPS_IP)"
$sshOptions = @(
  "-i", $envMap.VPS_SSH_KEY_PATH,
  "-o", "BatchMode=yes",
  "-o", "IdentitiesOnly=yes",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "ConnectTimeout=15",
  "-o", "LogLevel=ERROR"
)
$nonce = [guid]::NewGuid().ToString("N")
$archivePath = Join-Path ([IO.Path]::GetTempPath()) "production-acquisition-$nonce.zip"
$remoteArchive = "/tmp/production-acquisition-$nonce.zip"

try {
  Compress-Archive -Path (Join-Path $specsDir "*") -DestinationPath $archivePath `
    -CompressionLevel Optimal -Force
  $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()

  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $null = & scp -q @sshOptions $archivePath "${remote}:$remoteArchive" 2>$null
    $copyExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($copyExitCode -ne 0) { Stop-Launch -Step "REMOTE_UPLOAD" -ExitCode $copyExitCode }

  $remoteScript = @'
set -euo pipefail
cd "$HOME/export-ai-agent"
archive='__ARCHIVE__'
expected_hash='__HASH__'
nonce='__NONCE__'
private_root="$HOME/export-ai-agent/private"
stage="$private_root/.incoming-production-acquisition-$nonce"
destination="$private_root/production-acquisition-specs-20260721"
names=(
  manifest.json
  indonesia-sample-product-20260721.json
  malaysia-sample-product-20260721.json
  mexico-sample-product-20260721.json
  philippines-sample-product-20260721.json
  vietnam-sample-product-20260721.json
)
step=1
cleanup() {
  status=$?
  unlink "$archive" 2>/dev/null || true
  if [[ -d "$stage" ]]; then
    for name in "${names[@]}"; do unlink "$stage/$name" 2>/dev/null || true; done
    rmdir "$stage" 2>/dev/null || true
  fi
  if [[ $status -ne 0 ]]; then printf 'FAILED_REMOTE_STEP=%s\n' "$step"; fi
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$private_root" backups
chmod 700 "$private_root" backups
chmod 600 "$archive"
[[ "$(sha256sum "$archive" | awk '{print $1}')" == "$expected_hash" ]]
[[ ! -e "$stage" ]]
mkdir -m 700 "$stage"

step=2
python3 - "$archive" "$stage" <<'PY'
import json
import pathlib
import sys
import zipfile

archive = pathlib.Path(sys.argv[1])
stage = pathlib.Path(sys.argv[2])
expected = {
    "manifest.json",
    "indonesia-sample-product-20260721.json",
    "malaysia-sample-product-20260721.json",
    "mexico-sample-product-20260721.json",
    "philippines-sample-product-20260721.json",
    "vietnam-sample-product-20260721.json",
}
with zipfile.ZipFile(archive) as package:
    names = set(package.namelist())
    if names != expected or any(
        pathlib.PurePosixPath(name).is_absolute() or
        ".." in pathlib.PurePosixPath(name).parts
        for name in names
    ):
        raise SystemExit(11)
    package.extractall(stage)

manifest = json.loads((stage / "manifest.json").read_text(encoding="utf-8-sig"))
if (
    manifest.get("planId") != "demo_manufacturer-outbound-20260721" or
    int(manifest.get("targetTotal", -1)) != 500 or
    len(manifest.get("campaigns", [])) != 5
):
    raise SystemExit(12)

specs = []
for path in sorted(stage.glob("*.json")):
    if path.name == "manifest.json":
        continue
    spec = json.loads(path.read_text(encoding="utf-8-sig"))
    specs.append(spec)
    if spec["brief"].get("transport") != "SMTP":
        raise SystemExit(13)
    if spec["sellerKnowledge"]["profile"]["sender"].get("email") != "sales@example.com":
        raise SystemExit(14)
    if spec["sellerKnowledge"].get("privateCases"):
        raise SystemExit(15)
    if int(spec["limits"].get("total", -1)) != int(spec["campaign"].get("targetCount", -2)):
        raise SystemExit(16)
if len(specs) != 5 or sum(int(spec["campaign"]["targetCount"]) for spec in specs) != 500:
    raise SystemExit(17)
if len({spec["launchKey"] for spec in specs}) != 5 or len({spec["actionId"] for spec in specs}) != 5:
    raise SystemExit(18)
PY
find "$stage" -maxdepth 1 -type f -exec chmod 600 {} +

step=3
for spec in "$stage"/*.json; do
  [[ "$(basename "$spec")" == manifest.json ]] && continue
  (cd agent_service && node --input-type=module -e \
    "import('./dist/acquisition/autonomous-pilot-launch.js').then(({readAutonomousPilotLaunchSpec})=>readAutonomousPilotLaunchSpec(process.argv[1]))" \
    "$spec") >/dev/null
done

step=4
if [[ -d "$destination" ]]; then
  for name in "${names[@]}"; do
    [[ -f "$destination/$name" ]]
    cmp -s "$stage/$name" "$destination/$name"
  done
  for name in "${names[@]}"; do unlink "$stage/$name"; done
  rmdir "$stage"
else
  mv "$stage" "$destination"
fi
chmod 700 "$destination"

step=5
pause="$(cd agent_service && node --input-type=module <<'NODE'
import { DatabaseSync } from 'node:sqlite';
import { config } from './dist/config.js';
const db = new DatabaseSync(config.AGENT_DB_PATH, { readOnly: true });
process.stdout.write(String(db.prepare("SELECT value FROM settings WHERE key='outbound_paused'").get()?.value ?? ''));
db.close();
NODE
)"
[[ "$pause" == true ]]

backup="backups/pre-production-acquisition-$nonce.sqlite"
(cd agent_service && node dist/cli.js backup-db "../$backup") >/dev/null
chmod 600 "$backup"
backup_ok="$(node --input-type=module - "$backup" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const quick = db.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
const fk = db.prepare('PRAGMA foreign_key_check').all().length;
const version = Number(db.prepare('PRAGMA user_version').get().user_version);
db.close();
process.stdout.write(String(quick.length === 1 && quick[0] === 'ok' && fk === 0 && version === 18));
NODE
)"
[[ "$backup_ok" == true ]]

step=6
for spec in "$destination"/*.json; do
  [[ "$(basename "$spec")" == manifest.json ]] && continue
  (cd agent_service && node dist/cli.js launch-autonomous-pilot --confirm-launch --spec "$spec") >/dev/null
done

step=7
(cd agent_service && node --input-type=module <<'NODE'
import { DatabaseSync } from 'node:sqlite';
import { config } from './dist/config.js';
const db = new DatabaseSync(config.AGENT_DB_PATH, { readOnly: true });
const authorization = db.prepare(`
  SELECT count(DISTINCT campaign_id) AS campaigns,
         coalesce(sum(total_limit), 0) AS total_limit
  FROM campaign_send_authorizations
  WHERE action_id LIKE 'demo_manufacturer-outbound-20260721:%'
`).get();
const sent = Number(db.prepare("SELECT count(*) AS count FROM outbound_messages WHERE status='SENT'").get().count);
const paused = String(db.prepare("SELECT value FROM settings WHERE key='outbound_paused'").get()?.value ?? '');
const jobs = Number(db.prepare(`
  SELECT count(*) AS count FROM jobs
  WHERE job_type='DISCOVER_CAMPAIGN'
    AND json_extract(payload_json, '$.sendAuthorizationId') IS NOT NULL
`).get().count);
db.close();
if (Number(authorization.campaigns) !== 5 || Number(authorization.total_limit) !== 500 || jobs < 5 || sent !== 0 || paused !== 'true') {
  process.exit(21);
}
console.log('PRODUCTION_ACQUISITION_STATUS=PASS');
console.log('AUTHORIZED_CAMPAIGNS=5');
console.log('AUTHORIZED_TOTAL_LIMIT=500');
console.log('DISCOVERY_JOBS=' + jobs);
console.log('SENT_MESSAGES=0');
console.log('OUTBOUND_PAUSED=true');
NODE
)

trap - EXIT
unlink "$archive"
'@
  $remoteScript = $remoteScript.Replace("__ARCHIVE__", $remoteArchive).
    Replace("__HASH__", $archiveHash).
    Replace("__NONCE__", $nonce)
  $encoded = [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes(($remoteScript -replace "`r", "") + "`n")
  )

  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $remoteOutput = & ssh @sshOptions $remote "printf '%s' '$encoded' | base64 -d | bash" 2>$null
    $remoteExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  foreach ($line in @($remoteOutput)) {
    if ([string]$line -match '^(?:PRODUCTION_ACQUISITION_STATUS|AUTHORIZED_CAMPAIGNS|AUTHORIZED_TOTAL_LIMIT|DISCOVERY_JOBS|SENT_MESSAGES|OUTBOUND_PAUSED|FAILED_REMOTE_STEP)=') {
      [Console]::Out.WriteLine([string]$line)
    }
  }
  if ($remoteExitCode -ne 0) { Stop-Launch -Step "REMOTE_LAUNCH" -ExitCode $remoteExitCode }
  if (@($remoteOutput) -notcontains "PRODUCTION_ACQUISITION_STATUS=PASS") {
    Stop-Launch -Step "REMOTE_OUTPUT_VALIDATION" -ExitCode 65
  }
} catch {
  Stop-Launch -Step "PRODUCTION_ACQUISITION" -ExitCode 4
} finally {
  if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
    Remove-Item -LiteralPath $archivePath -Force
  }
}
