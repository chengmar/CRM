param(
  [string]$Workspace = "",
  [string]$EnvPath = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $Workspace = (Resolve-Path -LiteralPath $Workspace).Path
}
if ([string]::IsNullOrWhiteSpace($EnvPath)) { $EnvPath = Join-Path $Workspace ".env" }

$envMap = @{}
foreach ($line in Get-Content -LiteralPath $EnvPath -Encoding UTF8) {
  if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
  $parts = $line -split '=', 2
  $envMap[$parts[0].Trim()] = $parts[1].Trim()
}

foreach ($key in @("VPS_IP", "VPS_SSH_USER")) {
  if ([string]::IsNullOrWhiteSpace($envMap[$key])) { throw "Missing $key in private env" }
}

$remote = "$($envMap.VPS_SSH_USER)@$($envMap.VPS_IP)"
$useKey = -not [string]::IsNullOrWhiteSpace($envMap.VPS_SSH_KEY_PATH)
if ($useKey) {
  if (-not (Test-Path -LiteralPath $envMap.VPS_SSH_KEY_PATH)) { throw "VPS_SSH_KEY_PATH does not exist" }
  if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { throw "ssh not found" }
  if (-not (Get-Command scp -ErrorAction SilentlyContinue)) { throw "scp not found" }
  $baseArgs = @("-i", $envMap.VPS_SSH_KEY_PATH, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new")
  $copyArgs = @($baseArgs)
} else {
  if ([string]::IsNullOrWhiteSpace($envMap.VPS_SSH_PASSWORD)) { throw "Missing VPS SSH key or password" }
  if (-not (Get-Command plink -ErrorAction SilentlyContinue)) { throw "plink not found" }
  if (-not (Get-Command pscp -ErrorAction SilentlyContinue)) { throw "pscp not found" }
  $baseArgs = @("-ssh", "-batch", "-pw", $envMap.VPS_SSH_PASSWORD, "-no-antispoof")
  $copyArgs = @("-batch", "-pw", $envMap.VPS_SSH_PASSWORD)
  if (-not [string]::IsNullOrWhiteSpace($envMap.VPS_SSH_HOSTKEY)) {
    $baseArgs += @("-hostkey", $envMap.VPS_SSH_HOSTKEY)
    $copyArgs += @("-hostkey", $envMap.VPS_SSH_HOSTKEY)
  }
}

function Invoke-Remote {
  param([string]$Command)
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = if ($useKey) {
      & ssh @baseArgs $remote $Command 2>&1
    } else {
      & plink @baseArgs $remote $Command 2>&1
    }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($exitCode -ne 0) {
    $safe = ($output | ForEach-Object { [string]$_ }) -join "`n"
    if (-not [string]::IsNullOrWhiteSpace($envMap.VPS_SSH_PASSWORD)) {
      $safe = $safe -replace [regex]::Escape($envMap.VPS_SSH_PASSWORD), "REDACTED"
    }
    throw "Remote command failed: $safe"
  }
  return $output
}

Write-Host "== VPS Agent inspection =="
Invoke-Remote @'
set -euo pipefail
cd "$HOME/export-ai-agent"
echo "SERVICE=$(systemctl is-active export-ai-agent-service.service)"
echo "SERVICE_ENABLED=$(systemctl is-enabled export-ai-agent-service.service)"
echo "BACKUP_TIMER=$(systemctl is-active export-ai-agent-backup.timer)"
echo "ENV_MODE=$(stat -c %a .env)"
echo "HEALTH=$(curl -fsS http://127.0.0.1:18790/health)"
echo "READINESS=$(curl -fsS http://127.0.0.1:18790/readiness)"
'@

Invoke-Remote @'
set -euo pipefail
count=$(curl -fsS 'http://127.0.0.1:8888/search?q=sample+product+supplier&format=json' | grep -o '"url"' | wc -l)
echo "SEARXNG_RESULTS=$count"
journalctl -u export-ai-agent-service.service --since '-20 minutes' --no-pager | grep -E 'Feishu command channel connected|Agent HTTP service started|failed to start|fatal' | tail -n 10 || true
'@

$latest = (Invoke-Remote @'
cd "$HOME/export-ai-agent"
find outputs/vps_acceptance -maxdepth 1 -name 'vps-acceptance-*.json' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-
'@ | Select-Object -Last 1).Trim()
if ([string]::IsNullOrWhiteSpace($latest)) { throw "No VPS acceptance report found" }

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("vps-acceptance-" + [guid]::NewGuid().ToString("N") + ".json")
try {
  $arguments = @($copyArgs + @("${remote}:export-ai-agent/$latest", $temp))
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $copyOutput = if ($useKey) {
      & scp @arguments 2>&1
    } else {
      & pscp @arguments 2>&1
    }
    $copyExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($copyExit -ne 0) {
    $safe = ($copyOutput | ForEach-Object { [string]$_ }) -join "`n"
    if (-not [string]::IsNullOrWhiteSpace($envMap.VPS_SSH_PASSWORD)) {
      $safe = $safe -replace [regex]::Escape($envMap.VPS_SSH_PASSWORD), "REDACTED"
    }
    throw "Acceptance report download failed: $safe"
  }
  $report = Get-Content -LiteralPath $temp -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host "VPS_ACCEPTANCE_FILE=$latest"
  Write-Host "VPS_ACCEPTANCE_FAILED=$($report.failed)"
  Write-Host "VPS_ACCEPTANCE_WARNINGS=$($report.warnings)"
  foreach ($item in $report.results) { Write-Host "$($item.status) $($item.name)" }
} finally {
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
}
