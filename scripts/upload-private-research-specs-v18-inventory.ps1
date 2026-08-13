param(
  [string]$Workspace = "",
  [string]$EnvPath = "",
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
  if ([string]::IsNullOrWhiteSpace($EnvPath)) {
    $EnvPath = Join-Path $Workspace ".env"
  }
  $SpecsDir = (Resolve-Path -LiteralPath (
    Join-Path $Workspace "config\production-research-specs-v18-inventory-20260722"
  )).Path
} catch {
  Stop-Upload -Step "LOCAL_PATHS" -ExitCode 2
}

$expectedSpecsDir = [IO.Path]::GetFullPath(
  (Join-Path $Workspace "config\production-research-specs-v18-inventory-20260722")
)
if (-not $SpecsDir.Equals($expectedSpecsDir, [StringComparison]::OrdinalIgnoreCase)) {
  Stop-Upload -Step "LOCAL_SPEC_SCOPE" -ExitCode 2
}
if (-not (Test-Path -LiteralPath $EnvPath -PathType Leaf)) {
  Stop-Upload -Step "LOCAL_PRIVATE_CONFIG" -ExitCode 2
}

try {
  $jsonFiles = @(Get-ChildItem -LiteralPath $SpecsDir -File -Filter "*.json")
  if ($jsonFiles.Count -ne 6) { throw "invalid JSON file count" }
  $manifestPath = Join-Path $SpecsDir "manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "missing manifest" }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (
    [string]$manifest.runLabel -ne "v18-inventory" -or
    [int]$manifest.targetTotal -ne 500 -or
    $manifest.externalSendAuthorized -ne $false
  ) {
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
    $budget = $spec.brief.providerBudget
    $providers = @($budget.allowedProviders) -join ","
    if (
      $actionId.Length -gt 160 -or
      -not $actionId.EndsWith(":authorized:research-only:v18-inventory", [StringComparison]::Ordinal)
    ) {
      throw "invalid action id"
    }
    if (-not $launchKey.ToLowerInvariant().Contains("v18-inventory")) {
      throw "invalid launch key"
    }
    if ([string]$spec.brief.transport -ne "NONE") { throw "invalid transport" }
    if (
      [string]$budget.mode -ne "CAPPED" -or
      $providers -ne "searxng,local-public-web" -or
      [int]$budget.maxUnits -ne 2000 -or
      [decimal]$budget.maxAmountUsd -ne 0
    ) {
      throw "invalid provider budget"
    }
    if ([int]$spec.campaign.targetCount -ne [int]$spec.brief.targetCount) {
      throw "target mismatch"
    }
    $targetTotal += [int]$spec.campaign.targetCount
    $actionIds.Add($actionId)
    $launchKeys.Add($launchKey)
  }
  if ($targetTotal -ne 500) { throw "invalid target total" }
  if (
    @($actionIds | Sort-Object -Unique).Count -ne 5 -or
    @($launchKeys | Sort-Object -Unique).Count -ne 5
  ) {
    throw "duplicate identifiers"
  }

  $manifestRows = @($manifest.campaigns | ForEach-Object {
    "$($_.file):$([int]$_.targetCount)"
  } | Sort-Object)
  $specRows = @($specFiles | ForEach-Object {
    $spec = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    "$($_.Name):$([int]$spec.campaign.targetCount)"
  } | Sort-Object)
  if (($manifestRows -join "`n") -ne ($specRows -join "`n")) {
    throw "manifest mismatch"
  }
} catch {
  Stop-Upload -Step "LOCAL_SPEC_VALIDATION" -ExitCode 3
}

try {
  $envMap = Get-PrivateEnvMap -Path $EnvPath
} catch {
  Stop-Upload -Step "LOCAL_PRIVATE_CONFIG" -ExitCode 2
}
foreach ($name in @("VPS_IP", "VPS_SSH_USER", "VPS_SSH_KEY_PATH")) {
  if ([string]::IsNullOrWhiteSpace([string]$envMap[$name])) {
    Stop-Upload -Step "LOCAL_PRIVATE_CONFIG" -ExitCode 2
  }
}
if (
  -not (Test-Path -LiteralPath $envMap.VPS_SSH_KEY_PATH -PathType Leaf) -or
  -not (Get-Command ssh -ErrorAction SilentlyContinue) -or
  -not (Get-Command scp -ErrorAction SilentlyContinue)
) {
  Stop-Upload -Step "LOCAL_SSH_KEY_REQUIRED" -ExitCode 2
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
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$nonce = [guid]::NewGuid().ToString("N")
$archivePath = Join-Path $temporaryRoot "export-agent-v18-inventory-$nonce.zip"
$remoteArchive = "/tmp/export-agent-v18-inventory-$nonce.zip"

try {
  Compress-Archive -Path (Join-Path $SpecsDir "*") -DestinationPath $archivePath `
    -CompressionLevel Optimal -Force
  $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()

  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $copyTarget = $remote + ":" + $remoteArchive
    $null = & scp -q @sshOptions $archivePath $copyTarget 2>$null
    $copyExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($copyExitCode -ne 0) {
    Stop-Upload -Step "REMOTE_UPLOAD" -ExitCode $copyExitCode
  }

  $remoteScript = @'
set -euo pipefail
archive='__ARCHIVE__'
expected='__HASH__'
private_root="$HOME/export-ai-agent/private"
stage="$private_root/.incoming-v18-inventory-__NONCE__"
destination="$private_root/production-research-specs-v18-inventory-20260722"
backup="$private_root/production-research-specs-v18-inventory-20260722.previous.__NONCE__"
step=1
cleanup_failed_upload() {
  status=$?
  if [[ "$status" -eq 0 ]]; then return; fi
  for name in \
    manifest.json \
    indonesia-sample-product-20260721.json \
    malaysia-sample-product-20260721.json \
    mexico-sample-product-20260721.json \
    philippines-sample-product-20260721.json \
    vietnam-sample-product-20260721.json; do
    [[ -f "$stage/$name" ]] && unlink "$stage/$name" || true
  done
  [[ -d "$stage" ]] && rmdir "$stage" 2>/dev/null || true
  [[ -f "$archive" ]] && unlink "$archive" || true
  if [[ ! -e "$destination" && -d "$backup" ]]; then
    mv "$backup" "$destination" || true
  fi
  printf 'FAILED_REMOTE_STEP=%s\n' "$step"
  exit "$status"
}
trap cleanup_failed_upload EXIT
mkdir -p "$private_root"
chmod 700 "$private_root"
chmod 600 "$archive"
step=2
actual=$(sha256sum "$archive" | awk '{print $1}')
[[ "$actual" == "$expected" ]]
[[ ! -e "$stage" ]]
if [[ -d "$destination" ]]; then
  [[ "$(find "$destination" -mindepth 1 -maxdepth 1 -type f -name '*.json' | wc -l)" == 6 ]]
  [[ -z "$(find "$destination" -mindepth 1 -maxdepth 1 ! -type f -print -quit)" ]]
  [[ ! -e "$backup" ]]
  mv "$destination" "$backup"
else
  [[ ! -e "$destination" ]]
fi
step=3
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
    if len(names) != 6 or any(
        pathlib.PurePosixPath(name).is_absolute() or
        ".." in pathlib.PurePosixPath(name).parts
        for name in names
    ):
        raise SystemExit(11)
    package.extractall(stage)

files = sorted(stage.glob("*.json"))
if len(files) != 6:
    raise SystemExit(12)
manifest = json.loads((stage / "manifest.json").read_text(encoding="utf-8-sig"))
pairs = [
    (path, json.loads(path.read_text(encoding="utf-8-sig")))
    for path in files if path.name != "manifest.json"
]
if (
    manifest.get("runLabel") != "v18-inventory" or
    int(manifest.get("targetTotal", -1)) != 500 or
    manifest.get("externalSendAuthorized") is not False or
    len(pairs) != 5
):
    raise SystemExit(13)
if sum(int(spec["campaign"]["targetCount"]) for _, spec in pairs) != 500:
    raise SystemExit(14)

launch_keys = [str(spec["launchKey"]) for _, spec in pairs]
action_ids = [str(spec["actionId"]) for _, spec in pairs]
if len(set(launch_keys)) != 5 or len(set(action_ids)) != 5:
    raise SystemExit(15)
if any("v18-inventory" not in key.lower() for key in launch_keys):
    raise SystemExit(16)
if any(
    len(action_id) > 160 or
    not action_id.endswith(":authorized:research-only:v18-inventory")
    for action_id in action_ids
):
    raise SystemExit(20)

for _, spec in pairs:
    brief = spec["brief"]
    budget = brief["providerBudget"]
    if brief.get("transport") != "NONE":
        raise SystemExit(17)
    if (
        budget.get("mode") != "CAPPED" or
        budget.get("allowedProviders") != ["searxng", "local-public-web"] or
        int(budget.get("maxUnits", -1)) != 2000 or
        float(budget.get("maxAmountUsd", -1)) != 0
    ):
        raise SystemExit(18)

manifest_rows = {
    (str(row.get("file")), int(row.get("targetCount", -1)))
    for row in manifest.get("campaigns", [])
}
spec_rows = {
    (path.name, int(spec["campaign"]["targetCount"]))
    for path, spec in pairs
}
if manifest_rows != spec_rows:
    raise SystemExit(19)
PY
step=4
for spec in "$stage"/*.json; do
  [[ "$(basename "$spec")" == "manifest.json" ]] && continue
  (cd "$HOME/export-ai-agent/agent_service" && node --input-type=module -e \
    "import('./dist/acquisition/autonomous-research-launch.js').then(({readAutonomousResearchLaunchSpec})=>readAutonomousResearchLaunchSpec(process.argv[1]))" \
    "$spec") >/dev/null
done
step=5
find "$stage" -maxdepth 1 -type f -exec chmod 600 {} +
chmod 700 "$stage"
step=6
mv "$stage" "$destination"
unlink "$archive"
trap - EXIT
printf 'REMOTE_UPLOAD_STATUS=PASS\n'
'@
  $remoteScript = $remoteScript.Replace("__ARCHIVE__", $remoteArchive).
    Replace("__HASH__", $archiveHash).
    Replace("__NONCE__", $nonce)
  $normalizedScript = ($remoteScript -replace "`r", "") + "`n"
  $encodedScript = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($normalizedScript))
  $remoteCommand = "printf '%s' '$encodedScript' | base64 -d | bash"

  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $remoteOutput = & ssh @sshOptions $remote $remoteCommand 2>$null
    $remoteExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($remoteExitCode -ne 0) {
    $failedRemoteStep = @($remoteOutput | Where-Object {
      [string]$_ -match '^FAILED_REMOTE_STEP=[1-6]$'
    } | Select-Object -Last 1)
    if ($failedRemoteStep.Count -eq 1) {
      [Console]::Out.WriteLine([string]$failedRemoteStep[0])
    }
    Stop-Upload -Step "REMOTE_ACTIVATION" -ExitCode $remoteExitCode
  }
  if ((@($remoteOutput) | ForEach-Object { ([string]$_).Trim() }) -notcontains
    "REMOTE_UPLOAD_STATUS=PASS") {
    Stop-Upload -Step "REMOTE_OUTPUT_VALIDATION" -ExitCode 65
  }
} catch {
  Stop-Upload -Step "LOCAL_ARCHIVE" -ExitCode 4
} finally {
  if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
    $resolvedArchive = [IO.Path]::GetFullPath($archivePath)
    if ($resolvedArchive.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedArchive -Force
    }
  }
}

[Console]::Out.WriteLine("UPLOAD_STATUS=PASS")
[Console]::Out.WriteLine("SPEC_COUNT=5")
[Console]::Out.WriteLine("TARGET_TOTAL=500")
[Console]::Out.WriteLine("TRANSPORT=NONE")
[Console]::Out.WriteLine("PAID_BUDGET_USD=0")
[Console]::Out.WriteLine("EXTERNAL_SEND_AUTHORIZED=false")
exit 0
