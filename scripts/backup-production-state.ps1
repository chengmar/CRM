param(
  [string]$Workspace = "",
  [string]$OutputDir = "",
  [string]$Reason = "manual",
  [int]$KeepLatest = 30
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $Workspace "outputs\backups"
}

$businessDataDir = "customer_business_data"
$envPath = Join-Path $Workspace ".env"
if (Test-Path -LiteralPath $envPath) {
  $envText = Get-Content -LiteralPath $envPath -Raw -Encoding UTF8
  $match = [regex]::Match($envText, '(?m)^BUSINESS_DATA_DIR=(.*)$')
  if ($match.Success) { $businessDataDir = $match.Groups[1].Value.Trim().Trim('"').Trim("'") }
}
if ([System.IO.Path]::IsPathRooted($businessDataDir) -or $businessDataDir -match '(^|[\\/])\.\.([\\/]|$)') {
  throw "BUSINESS_DATA_DIR must be a safe relative path."
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$resolvedOutputDir = (Resolve-Path -LiteralPath $OutputDir).Path
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$stage = Join-Path $resolvedOutputDir "state-backup-stage-$stamp"
$zipPath = Join-Path $resolvedOutputDir "production-state-backup-$stamp.zip"

function Join-RelPath {
  param(
    [string]$Base,
    [string]$Rel
  )
  $normalized = $Rel -replace '[\\/]', [System.IO.Path]::DirectorySeparatorChar
  return (Join-Path $Base $normalized)
}

function Copy-RelPath {
  param([string]$Rel)
  $src = Join-RelPath $Workspace $Rel
  if (-not (Test-Path -LiteralPath $src)) { return }
  $item = Get-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue
  if (-not $item) {
    Write-Warning "Backup source disappeared or is not readable, skipped: $Rel"
    return
  }
  $dst = Join-RelPath $stage $Rel
  $parent = Split-Path -Parent $dst
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  if ($item.PSIsContainer) {
    Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
  } else {
    Copy-Item -LiteralPath $src -Destination $dst -Force
  }
}

function Copy-PackageSmokeReports {
  $src = Join-Path $Workspace "outputs\package_smoke"
  if (-not (Test-Path -LiteralPath $src)) { return }
  $dst = Join-Path $stage "outputs\package_smoke"
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  Get-ChildItem -LiteralPath $src -Filter "package-smoke-*.json" -File -ErrorAction SilentlyContinue |
    ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $dst $_.Name) -Force
    }
}

if (Test-Path -LiteralPath $stage) {
  $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
  if (-not $resolvedStage.StartsWith($resolvedOutputDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean stage outside backup dir: $resolvedStage"
  }
  Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$paths = @(
  ".env.example",
  "NEXT_PRODUCTION_INPUTS.md",
  "PRODUCTION_ACCEPTANCE.md",
  "FEISHU_CRM_SYNC.md",
  $businessDataDir,
  "outputs\acceptance",
  "outputs\production_readiness",
  "outputs\outbound_readiness",
  "outputs\outbound_dispatch",
  "outputs\ops_health",
  "outputs\production_status",
  "outputs\fresh_install_acceptance"
)

$agentDbSource = Join-Path $Workspace "agent_service\data\agent.db"
$agentDbRel = "agent_service\data\agent.db"
if (Test-Path -LiteralPath $agentDbSource) {
  $agentDbDestination = Join-RelPath $stage $agentDbRel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $agentDbDestination) | Out-Null
  $serviceDir = Join-Path $Workspace "agent_service"
  $compiledCli = Join-Path $serviceDir "dist\cli.js"
  $previousDbPath = $env:AGENT_DB_PATH
  $previousAgentMode = $env:AGENT_MODE
  $previousOutboundEnabled = $env:OUTBOUND_ENABLED
  $previousNodeNoWarnings = $env:NODE_NO_WARNINGS
  try {
    $env:AGENT_DB_PATH = $agentDbSource
    $env:AGENT_MODE = "dry_run"
    $env:OUTBOUND_ENABLED = "false"
    $env:NODE_NO_WARNINGS = "1"
    Push-Location $serviceDir
    try {
      if (Test-Path -LiteralPath $compiledCli) {
        $dbBackupOutput = & node $compiledCli backup-db $agentDbDestination 2>&1
      } else {
        $dbBackupOutput = & npm run cli -- backup-db $agentDbDestination 2>&1
      }
      if ($LASTEXITCODE -ne 0) {
        throw "Agent database snapshot failed: $($dbBackupOutput -join ' | ')"
      }
    } finally {
      Pop-Location
    }
  } finally {
    $env:AGENT_DB_PATH = $previousDbPath
    $env:AGENT_MODE = $previousAgentMode
    $env:OUTBOUND_ENABLED = $previousOutboundEnabled
    $env:NODE_NO_WARNINGS = $previousNodeNoWarnings
  }
  $paths += $agentDbRel
  Write-Host "[OK] Consistent Agent SQLite snapshot created."
}

foreach ($rel in $paths) {
  if ($rel -eq $agentDbRel) { continue }
  Copy-RelPath $rel
}
Copy-PackageSmokeReports

$manifest = [pscustomobject]@{
  created_at = (Get-Date -Format s)
  workspace = $Workspace
  reason = $Reason
  business_data_dir = $businessDataDir
  included_paths = @($paths + "outputs\package_smoke\package-smoke-*.json")
  excluded = @(".env", "private API keys and credentials")
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stage "backup_manifest.json") -Encoding UTF8

$secretHits = Get-ChildItem -LiteralPath $stage -Recurse -File |
  Where-Object { $_.Extension -notin @(".xlsx", ".png", ".jpg", ".jpeg", ".node", ".dll", ".so", ".dylib", ".exe", ".bin", ".db", ".sqlite", ".sqlite3") } |
  Select-String -Pattern 'sk-[A-Za-z0-9_-]{20,}' -ErrorAction SilentlyContinue
if ($secretHits) {
  $secretHits | ForEach-Object { Write-Host "[FAIL] Secret-like token found in backup stage: $($_.Path):$($_.LineNumber)" }
  throw "Refusing to write backup with secret-like tokens."
}

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -Force
Remove-Item -LiteralPath $stage -Recurse -Force
Write-Host "[OK] Production state backup written: $zipPath"
Write-Host "[OK] Private .env excluded."

if ($KeepLatest -gt 0) {
  $old = Get-ChildItem -LiteralPath $resolvedOutputDir -Filter "production-state-backup-*.zip" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $KeepLatest
  foreach ($file in $old) {
    Remove-Item -LiteralPath $file.FullName -Force
    Write-Host "[OK] Removed old backup: $($file.FullName)"
  }
}

exit 0
