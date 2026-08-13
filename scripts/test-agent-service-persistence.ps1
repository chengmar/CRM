param(
  [string]$Workspace = "",
  [string]$ServiceName = "export-ai-agent-service"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$serviceDir = Join-Path $Workspace "agent_service"
$cliPath = Join-Path $serviceDir "dist\cli.js"
if (-not (Test-Path -LiteralPath $cliPath)) {
  throw "Compiled Agent CLI is missing: $cliPath"
}
if (-not (Get-Command systemctl -ErrorAction SilentlyContinue)) {
  throw "systemctl is required for the VPS persistence test"
}

$isRoot = ((& id -u) -join "").Trim() -eq "0"
$systemctlPrefix = @()
if (-not $isRoot) {
  if (-not (Get-Command sudo -ErrorAction SilentlyContinue)) {
    throw "Run as root or configure passwordless sudo for the persistence test"
  }
  & sudo -n true
  if ($LASTEXITCODE -ne 0) { throw "Passwordless sudo is required for the persistence test" }
  $systemctlPrefix = @("sudo", "-n")
}

function Invoke-Systemctl {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  if ($systemctlPrefix.Count -gt 0) {
    $sudoCommand = $systemctlPrefix[0]
    & $sudoCommand $systemctlPrefix[1] systemctl @Arguments
  } else {
    & systemctl @Arguments
  }
}

$health = Invoke-RestMethod -Uri "http://127.0.0.1:18790/health" -TimeoutSec 5
if (-not $health.ok) { throw "Agent health check is not OK before restart" }
if ($health.outboundEnabled -and -not $health.outboundPaused) {
  throw "Refusing persistence restart test while real outbound is enabled and unpaused"
}

$jobId = ""
$previousNodeNoWarnings = $env:NODE_NO_WARNINGS
$env:NODE_NO_WARNINGS = "1"
try {
  Push-Location $serviceDir
  try {
    $createdText = (& node $cliPath enqueue-persistence-probe 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "Could not create persistence probe: $createdText" }
    $created = $createdText | ConvertFrom-Json
    $jobId = [string]$created.jobId
    if ([string]::IsNullOrWhiteSpace($jobId)) { throw "Persistence probe did not return a job ID" }
  } finally {
    Pop-Location
  }

  Invoke-Systemctl restart "$ServiceName.service"
  if ($LASTEXITCODE -ne 0) { throw "Failed to restart $ServiceName.service" }

  $healthy = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
      $after = Invoke-RestMethod -Uri "http://127.0.0.1:18790/health" -TimeoutSec 3
      if ($after.ok) {
        $healthy = $true
        break
      }
    } catch {
      # Wait for systemd restart.
    }
  }
  if (-not $healthy) { throw "Agent did not become healthy after restart" }

  Push-Location $serviceDir
  try {
    $readText = (& node $cliPath get-persistence-probe $jobId 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "Persistence probe was not readable after restart: $readText" }
    $read = $readText | ConvertFrom-Json
    if ([string]$read.job.status -ne "QUEUED") {
      throw "Persistence probe status changed unexpectedly: $($read.job.status)"
    }
  } finally {
    Pop-Location
  }

  Write-Host "[OK] SQLite job survived a systemd restart: $jobId"
} finally {
  if (-not [string]::IsNullOrWhiteSpace($jobId)) {
    Push-Location $serviceDir
    try {
      & node $cliPath delete-persistence-probe $jobId | Out-Null
    } finally {
      Pop-Location
    }
  }
  $env:NODE_NO_WARNINGS = $previousNodeNoWarnings
}

exit 0
