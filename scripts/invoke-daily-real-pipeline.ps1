param(
  [string]$Workspace = "",
  [switch]$RunAgentSmoke
)

$ErrorActionPreference = "Stop"

function Get-EnvMap {
  param([string]$Path)
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line -split '=', 2
    $map[$parts[0].Trim()] = $parts[1].Trim()
  }
  return $map
}

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$logDir = Join-Path $Workspace "outputs\scheduled"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$logPath = Join-Path $logDir "daily-real-pipeline-$stamp.log"

Start-Transcript -LiteralPath $logPath -Force | Out-Null
try {
  Write-Host "== Daily real commercial pipeline =="
  Write-Host "Started: $(Get-Date -Format s)"
  Write-Host "Workspace: $Workspace"
  Write-Host "Safety: no external sending; Feishu write only when FEISHU_CRM_SYNC_ENABLED=true"

  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\backup-production-state.ps1") `
    -Workspace $Workspace `
    -Reason "before-daily-real-pipeline"
  if ($LASTEXITCODE -ne 0) {
    throw "backup-production-state.ps1 failed with exit code $LASTEXITCODE"
  }

  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\run-real-commercial-pipeline.ps1")
  $pipelineExit = $LASTEXITCODE
  Write-Host "run-real-commercial-pipeline exit code: $pipelineExit"
  if ($pipelineExit -ne 0) {
    $crmPath = Join-Path $Workspace "product_data\crm_import.csv"
    $workbookPath = Join-Path $Workspace "outputs\product_launch\commercial_leadgen.xlsx"
    $validation = powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\validate-local-mvp.ps1") `
      -MvpDir (Join-Path $Workspace "product_data") 2>&1
    if ((Test-Path -LiteralPath $crmPath) -and (Test-Path -LiteralPath $workbookPath) -and $LASTEXITCODE -eq 0) {
      Write-Host "[WARN] Pipeline process returned $pipelineExit, but CRM/workbook validation passed; continuing."
    } else {
      Write-Host ($validation -join "`n")
      throw "run-real-commercial-pipeline.ps1 failed with exit code $pipelineExit"
    }
  }

  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\check-agent-stack.ps1") -SkipModelPing -WriteReport
  $checkExit = $LASTEXITCODE
  Write-Host "check-agent-stack exit code: $checkExit"
  if ($checkExit -ne 0) {
    throw "check-agent-stack.ps1 failed with exit code $checkExit"
  }

  if ($RunAgentSmoke) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\run-real-commercial-pipeline.ps1") -RunAgentSmoke
    if ($LASTEXITCODE -ne 0) {
      throw "agent smoke failed with exit code $LASTEXITCODE"
    }
  }

  $envMap = Get-EnvMap (Join-Path $Workspace ".env")
  if ($envMap.FEISHU_CRM_SYNC_ENABLED -eq "true") {
    if ($envMap.FEISHU_CRM_WRITE_TEST_PASSED -ne "true") {
      throw "FEISHU_CRM_SYNC_ENABLED=true but FEISHU_CRM_WRITE_TEST_PASSED is not true. Run one-row write test first."
    }
    $syncMode = if ([string]::IsNullOrWhiteSpace($envMap.FEISHU_CRM_SYNC_MODE)) { "OverwriteAll" } else { $envMap.FEISHU_CRM_SYNC_MODE }
    Write-Host "Feishu CRM sync enabled; mode=$syncMode"
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\sync-feishu-crm.ps1") -Mode $syncMode -ConfirmWrite
    $syncExit = $LASTEXITCODE
    Write-Host "sync-feishu-crm exit code: $syncExit"
    if ($syncExit -ne 0) {
      throw "sync-feishu-crm.ps1 failed with exit code $syncExit"
    }
  } else {
    Write-Host "Feishu CRM sync disabled; set FEISHU_CRM_SYNC_ENABLED=true only after manual write test passes."
  }

  Write-Host "[OK] Daily real pipeline complete."
} finally {
  Write-Host "Finished: $(Get-Date -Format s)"
  Stop-Transcript | Out-Null
  Write-Host "[OK] Log: $logPath"
}

exit 0
