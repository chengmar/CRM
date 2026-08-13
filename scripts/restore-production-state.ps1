param(
  [string]$Workspace = "",
  [string]$BackupPath = "",
  [string]$RestoreTo = "",
  [switch]$ConfirmRestore,
  [switch]$ManageAgentService
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($BackupPath)) {
  $latest = Get-ChildItem -LiteralPath (Join-Path $Workspace "outputs\backups") -Filter "production-state-backup-*.zip" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $latest) { throw "No production-state-backup-*.zip found." }
  $BackupPath = $latest.FullName
}
if ([string]::IsNullOrWhiteSpace($RestoreTo)) {
  $RestoreTo = $Workspace
}

$BackupPath = (Resolve-Path -LiteralPath $BackupPath).Path
if (-not (Test-Path -LiteralPath $RestoreTo)) {
  New-Item -ItemType Directory -Force -Path $RestoreTo | Out-Null
}
$RestoreTo = (Resolve-Path -LiteralPath $RestoreTo).Path

$scratchRoot = Join-Path $Workspace "outputs\restore_preview"
New-Item -ItemType Directory -Force -Path $scratchRoot | Out-Null
$scratchRoot = (Resolve-Path -LiteralPath $scratchRoot).Path
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$extractDir = Join-Path $scratchRoot "restore-$stamp"

$allowedPaths = @(
  ".env.example",
  "NEXT_PRODUCTION_INPUTS.md",
  "PRODUCTION_ACCEPTANCE.md",
  "FEISHU_CRM_SYNC.md",
  "outputs\acceptance",
  "outputs\production_readiness",
  "outputs\outbound_readiness",
  "outputs\outbound_dispatch",
  "outputs\ops_health",
  "outputs\production_status",
  "outputs\fresh_install_acceptance",
  "outputs\package_smoke",
  "agent_service\data\agent.db"
)

function Assert-UnderRoot {
  param(
    [string]$Path,
    [string]$Root
  )
  $full = [System.IO.Path]::GetFullPath($Path)
  $rootFull = [System.IO.Path]::GetFullPath($Root)
  if (-not $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path escapes root. path=$full root=$rootFull"
  }
  return $full
}

if (Test-Path -LiteralPath $extractDir) {
  $resolvedExtract = (Resolve-Path -LiteralPath $extractDir).Path
  if (-not $resolvedExtract.StartsWith($scratchRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove extraction dir outside scratch root: $resolvedExtract"
  }
  Remove-Item -LiteralPath $extractDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
Expand-Archive -LiteralPath $BackupPath -DestinationPath $extractDir -Force

$manifestPath = Join-Path $extractDir "backup_manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "Backup manifest missing: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$businessDataDir = [string]$manifest.business_data_dir
if (-not [string]::IsNullOrWhiteSpace($businessDataDir)) {
  if ([System.IO.Path]::IsPathRooted($businessDataDir) -or $businessDataDir -match '(^|[\\/])\.\.([\\/]|$)') {
    throw "Backup manifest contains an unsafe business_data_dir."
  }
  $allowedPaths += $businessDataDir
}
Write-Host "== Production state restore =="
Write-Host "Backup: $BackupPath"
Write-Host "Backup created: $($manifest.created_at)"
Write-Host "Reason: $($manifest.reason)"
Write-Host "Restore target: $RestoreTo"
Write-Host "Mode: $(if ($ConfirmRestore) { 'RESTORE' } else { 'PREVIEW' })"

$items = New-Object System.Collections.Generic.List[object]
foreach ($rel in $allowedPaths) {
  $src = Join-Path $extractDir $rel
  $dst = Join-Path $RestoreTo $rel
  if (Test-Path -LiteralPath $src) {
    $dstFull = Assert-UnderRoot -Path $dst -Root $RestoreTo
    $items.Add([pscustomobject]@{ rel = $rel; source = $src; destination = $dstFull }) | Out-Null
  }
}

foreach ($item in $items) {
  Write-Host "[PLAN] $($item.rel) -> $($item.destination)"
}

if (-not $ConfirmRestore) {
  Write-Host "[OK] Preview only. Re-run with -ConfirmRestore to restore these paths."
  exit 0
}

$restoresAgentDb = @($items | Where-Object { $_.rel -eq "agent_service\data\agent.db" }).Count -gt 0
$agentServiceWasActive = $false
if ($restoresAgentDb -and (Get-Command systemctl -ErrorAction SilentlyContinue)) {
  & systemctl is-active --quiet export-ai-agent-service 2>$null
  $agentServiceWasActive = $LASTEXITCODE -eq 0
  if ($agentServiceWasActive -and -not $ManageAgentService) {
    throw "Agent service is active. Re-run with -ManageAgentService so restore can stop and restart it safely."
  }
  if ($agentServiceWasActive) {
    & systemctl stop export-ai-agent-service
    if ($LASTEXITCODE -ne 0) { throw "Failed to stop export-ai-agent-service." }
    Write-Host "[OK] Agent service stopped for database restore."
  }
}

try {
  if ($RestoreTo -eq $Workspace) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\backup-production-state.ps1") -Workspace $Workspace -Reason "before-restore"
    if ($LASTEXITCODE -ne 0) { throw "Pre-restore backup failed." }
  }

  foreach ($item in $items) {
    $srcInfo = Get-Item -LiteralPath $item.source
    $dst = $item.destination
    Assert-UnderRoot -Path $dst -Root $RestoreTo | Out-Null
    if (Test-Path -LiteralPath $dst) {
      Remove-Item -LiteralPath $dst -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    if ($srcInfo.PSIsContainer) {
      Copy-Item -LiteralPath $item.source -Destination $dst -Recurse -Force
    } else {
      Copy-Item -LiteralPath $item.source -Destination $dst -Force
    }
    Write-Host "[OK] Restored $($item.rel)"
  }

  if ($restoresAgentDb -and $RestoreTo -eq $Workspace) {
    $restoredDb = Join-Path $Workspace "agent_service\data\agent.db"
    $compiledCli = Join-Path $Workspace "agent_service\dist\cli.js"
    if (-not (Test-Path -LiteralPath $compiledCli)) {
      throw "Cannot verify restored Agent database because compiled CLI is missing: $compiledCli"
    }
    $previousDbPath = $env:AGENT_DB_PATH
    $previousNodeNoWarnings = $env:NODE_NO_WARNINGS
    try {
      $env:AGENT_DB_PATH = $restoredDb
      $env:NODE_NO_WARNINGS = "1"
      & node $compiledCli verify-db
      if ($LASTEXITCODE -ne 0) { throw "Restored Agent database verification failed." }
    } finally {
      $env:AGENT_DB_PATH = $previousDbPath
      $env:NODE_NO_WARNINGS = $previousNodeNoWarnings
    }
    Write-Host "[OK] Restored Agent database integrity and schema verified."
  }

  Write-Host "[OK] Restore complete."
} finally {
  if ($agentServiceWasActive) {
    & systemctl start export-ai-agent-service
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Restore finished but export-ai-agent-service could not be restarted."
    } else {
      Write-Host "[OK] Agent service restarted."
    }
  }
}
exit 0
