param(
  [string]$Workspace = "",
  [string]$EnvPath = "",
  [string]$SpecsDir = "",
  [switch]$ConfirmUpload
)

$ErrorActionPreference = "Stop"

function Stop-Upload {
  param([string]$Step, [int]$ExitCode)
  [Console]::Out.WriteLine("UPLOAD_STATUS=FAIL")
  [Console]::Out.WriteLine("FAILED_STEP=$Step")
  [Console]::Out.WriteLine("FAILED_EXIT_CODE=$ExitCode")
  exit $ExitCode
}

function Get-PrivateEnvMap {
  param([string]$Path)
  $map = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line -split '=', 2
    $name = $parts[0].Trim()
    if (-not [string]::IsNullOrWhiteSpace($name)) {
      $map[$name] = $parts[1].Trim().Trim('"').Trim("'")
    }
  }
  return $map
}

if (-not $ConfirmUpload) {
  Stop-Upload -Step "CONFIRMATION_REQUIRED" -ExitCode 2
}

try {
  $Workspace = if ([string]::IsNullOrWhiteSpace($Workspace)) {
    (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
  } else {
    (Resolve-Path -LiteralPath $Workspace).Path
  }
  if ([string]::IsNullOrWhiteSpace($EnvPath)) { $EnvPath = Join-Path $Workspace ".env" }
  if ([string]::IsNullOrWhiteSpace($SpecsDir)) {
    $SpecsDir = Join-Path $Workspace "config\production-research-specs-expanded-20260721"
  }
  $SpecsDir = (Resolve-Path -LiteralPath $SpecsDir).Path
} catch {
  Stop-Upload -Step "LOCAL_PATHS" -ExitCode 2
}

$allowedRoot = [IO.Path]::GetFullPath((Join-Path $Workspace "config")).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if (-not ($SpecsDir + [IO.Path]::DirectorySeparatorChar).StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
  Stop-Upload -Step "LOCAL_SPEC_SCOPE" -ExitCode 2
}
if (-not (Test-Path -LiteralPath $EnvPath -PathType Leaf)) {
  Stop-Upload -Step "LOCAL_PRIVATE_CONFIG" -ExitCode 2
}

try {
  $jsonFiles = @(Get-ChildItem -LiteralPath $SpecsDir -File -Filter "*.json")
  if ($jsonFiles.Count -ne 6) { throw "invalid count" }
  $manifestPath = Join-Path $SpecsDir "manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "missing manifest" }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$manifest.runLabel -ne "expanded" -or [int]$manifest.targetTotal -ne 500 -or
      $manifest.externalSendAuthorized -ne $false) {
    throw "invalid manifest policy"
  }
  $specFiles = @($jsonFiles | Where-Object Name -ne "manifest.json")
  if ($specFiles.Count -ne 5) { throw "invalid spec count" }
  $actionIds = New-Object Collections.Generic.List[string]
  $launchKeys = New-Object Collections.Generic.List[string]
  $targetTotal = 0
  foreach ($file in $specFiles) {
    $spec = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    $actionId = [string]$spec.actionId
    $launchKey = [string]$spec.launchKey
    if (-not $actionId.EndsWith(":expanded", [StringComparison]::Ordinal)) { throw "invalid action id" }
    if (-not $launchKey.ToLowerInvariant().Contains("expanded")) { throw "invalid launch key" }
    if ([string]$spec.brief.transport -ne "NONE") { throw "invalid transport" }
    if ([int]$spec.campaign.targetCount -ne [int]$spec.brief.targetCount) { throw "target mismatch" }
    $targetTotal += [int]$spec.campaign.targetCount
    $actionIds.Add($actionId)
    $launchKeys.Add($launchKey)
  }
  if ($targetTotal -ne 500) { throw "invalid target total" }
  if (@($actionIds | Sort-Object -Unique).Count -ne 5 -or @($launchKeys | Sort-Object -Unique).Count -ne 5) {
    throw "duplicate identifiers"
  }
  $manifestRows = @($manifest.campaigns | ForEach-Object { "$($_.file):$([int]$_.targetCount)" } | Sort-Object)
  $specRows = @($specFiles | ForEach-Object {
    $spec = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    "$($_.Name):$([int]$spec.campaign.targetCount)"
  } | Sort-Object)
  if (($manifestRows -join "`n") -ne ($specRows -join "`n")) { throw "manifest mismatch" }
} catch {
  Stop-Upload -Step "LOCAL_SPEC_VALIDATION" -ExitCode 3
}

try {
  $envMap = Get-PrivateEnvMap -Path $EnvPath
} catch {
  Stop-Upload -Step "LOCAL_PRIVATE_CONFIG" -ExitCode 2
}
foreach ($name in @("VPS_IP", "VPS_SSH_USER")) {
  if ([string]::IsNullOrWhiteSpace([string]$envMap[$name])) {
    Stop-Upload -Step "LOCAL_PRIVATE_CONFIG" -ExitCode 2
  }
}

$remote = "$($envMap.VPS_SSH_USER)@$($envMap.VPS_IP)"
if ([string]::IsNullOrWhiteSpace([string]$envMap.VPS_SSH_KEY_PATH) -or
    -not (Test-Path -LiteralPath $envMap.VPS_SSH_KEY_PATH -PathType Leaf) -or
    -not (Get-Command ssh -ErrorAction SilentlyContinue) -or
    -not (Get-Command scp -ErrorAction SilentlyContinue)) {
  Stop-Upload -Step "LOCAL_SSH_KEY_REQUIRED" -ExitCode 2
}

$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$nonce = [guid]::NewGuid().ToString("N")
$archivePath = Join-Path $temporaryRoot "export-agent-expanded-$nonce.zip"
$remoteArchive = "/tmp/export-agent-expanded-$nonce.zip"
$remoteStageName = ".incoming-expanded-$nonce"

try {
  Compress-Archive -Path (Join-Path $SpecsDir "*") -DestinationPath $archivePath -CompressionLevel Optimal -Force
  $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()

  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $copyTarget = $remote + ":" + $remoteArchive
    $null = & scp -q -i $envMap.VPS_SSH_KEY_PATH -o BatchMode=yes -o IdentitiesOnly=yes `
      -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o LogLevel=ERROR `
      $archivePath $copyTarget 2>$null
    $copyExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($copyExitCode -ne 0) { Stop-Upload -Step "REMOTE_UPLOAD" -ExitCode $copyExitCode }

  $remoteScript = @'
set -euo pipefail
archive='__ARCHIVE__'
expected='__HASH__'
private_root="$HOME/export-ai-agent/private"
stage="$private_root/__STAGE_NAME__"
destination="$private_root/production-research-specs-expanded-20260721"
backup="$destination.previous.__NONCE__"
lock_file="$private_root/.research-spec-upload.lock"
cleanup() {
  rm -f -- "$archive"
  if [[ "$stage" == "$private_root"/.incoming-expanded-* && -d "$stage" ]]; then rm -rf -- "$stage"; fi
}
trap cleanup EXIT
mkdir -p "$private_root"
chmod 700 "$private_root"
command -v flock >/dev/null
exec 9>"$lock_file"
chmod 600 "$lock_file"
flock -x 9
chmod 600 "$archive"
actual=$(sha256sum "$archive" | awk '{print $1}')
[[ "$actual" == "$expected" ]]
mkdir -m 700 "$stage"
python3 - "$archive" "$stage" <<'PY'
import json
import pathlib
import sys
import zipfile

archive = pathlib.Path(sys.argv[1])
stage = pathlib.Path(sys.argv[2])
with zipfile.ZipFile(archive) as package:
    names = package.namelist()
    if len(names) != 6 or any(pathlib.PurePosixPath(name).is_absolute() or ".." in pathlib.PurePosixPath(name).parts for name in names):
        raise SystemExit(11)
    package.extractall(stage)
files = sorted(stage.glob("*.json"))
if len(files) != 6:
    raise SystemExit(12)
manifest = json.loads((stage / "manifest.json").read_text(encoding="utf-8-sig"))
specs = [json.loads(path.read_text(encoding="utf-8-sig")) for path in files if path.name != "manifest.json"]
if manifest.get("runLabel") != "expanded" or manifest.get("targetTotal") != 500 or manifest.get("externalSendAuthorized") is not False or len(specs) != 5:
    raise SystemExit(13)
if sum(int(spec["campaign"]["targetCount"]) for spec in specs) != 500:
    raise SystemExit(14)
action_ids = [str(spec["actionId"]) for spec in specs]
launch_keys = [str(spec["launchKey"]) for spec in specs]
if len(set(action_ids)) != 5 or len(set(launch_keys)) != 5:
    raise SystemExit(15)
if any(not value.endswith(":expanded") for value in action_ids):
    raise SystemExit(16)
if any("expanded" not in value.lower() for value in launch_keys):
    raise SystemExit(17)
if any(spec["brief"].get("transport") != "NONE" for spec in specs):
    raise SystemExit(18)
manifest_rows = {(str(row.get("file")), int(row.get("targetCount", -1))) for row in manifest.get("campaigns", [])}
spec_rows = {(path.name, int(spec["campaign"]["targetCount"])) for path, spec in zip((path for path in files if path.name != "manifest.json"), specs)}
if manifest_rows != spec_rows:
    raise SystemExit(19)
PY
for spec in "$stage"/*.json; do
  [[ "$(basename "$spec")" == "manifest.json" ]] && continue
  (cd "$HOME/export-ai-agent/agent_service" && node --input-type=module -e \
    "import('./dist/acquisition/autonomous-research-launch.js').then(({readAutonomousResearchLaunchSpec})=>readAutonomousResearchLaunchSpec(process.argv[1]))" \
    "$spec") >/dev/null
done
find "$stage" -maxdepth 1 -type f -exec chmod 600 {} +
chmod 700 "$stage"
if [[ -e "$destination" ]]; then
  mv "$destination" "$backup"
fi
if ! mv "$stage" "$destination"; then
  if [[ -d "$backup" && ! -e "$destination" ]]; then mv "$backup" "$destination"; fi
  exit 20
fi
trap - EXIT
rm -f -- "$archive"
printf 'REMOTE_UPLOAD_STATUS=PASS\n'
'@
  $remoteScript = $remoteScript.Replace("__ARCHIVE__", $remoteArchive).Replace("__STAGE_NAME__", $remoteStageName).Replace("__HASH__", $archiveHash).Replace("__NONCE__", $nonce)

  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $remoteOutput = $remoteScript | & ssh -i $envMap.VPS_SSH_KEY_PATH -o BatchMode=yes `
      -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 `
      -o LogLevel=ERROR $remote "bash -s" 2>$null
    $remoteExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($remoteExitCode -ne 0) { Stop-Upload -Step "REMOTE_ACTIVATION" -ExitCode $remoteExitCode }
  if ((@($remoteOutput) | ForEach-Object { ([string]$_).Trim() }) -notcontains "REMOTE_UPLOAD_STATUS=PASS") {
    Stop-Upload -Step "REMOTE_OUTPUT_VALIDATION" -ExitCode 65
  }
} catch {
  Stop-Upload -Step "LOCAL_ARCHIVE" -ExitCode 4
} finally {
  if (Test-Path -LiteralPath $archivePath) {
    $resolvedArchive = [IO.Path]::GetFullPath($archivePath)
    if ($resolvedArchive.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedArchive -Force
    }
  }
}

[Console]::Out.WriteLine("UPLOAD_STATUS=PASS")
[Console]::Out.WriteLine("SPEC_COUNT=5")
[Console]::Out.WriteLine("TARGET_TOTAL=500")
[Console]::Out.WriteLine("EXTERNAL_SEND_AUTHORIZED=false")
exit 0
