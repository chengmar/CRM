param(
  [string]$Workspace = "",
  [switch]$SkipModelPing,
  [switch]$WriteReport
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$HermesExe = "C:\Users\your-user\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe"
$Results = New-Object System.Collections.Generic.List[object]

function Add-Result {
  param(
    [string]$Name,
    [string]$Status,
    [string]$Detail = ""
  )
  $Results.Add([pscustomobject]@{
    name = $Name
    status = $Status
    detail = ($Detail -replace 'sk-[A-Za-z0-9_-]+', 'sk-REDACTED')
  }) | Out-Null
  $tag = if ($Status -eq "OK") { "[OK]" } elseif ($Status -eq "WARN") { "[WARN]" } else { "[FAIL]" }
  Write-Host "$tag $Name $Detail"
}

function Test-CommandExists {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) {
    Add-Result $Name "OK" $cmd.Source
    return $true
  }
  Add-Result $Name "FAIL" "not found"
  return $false
}

Write-Host "== Export AI Agent Stack Check =="
Write-Host "Workspace: $Workspace"
Write-Host ""

foreach ($cmd in @("git", "curl", "node", "python", "docker", "wsl", "openclaw")) {
  Test-CommandExists $cmd | Out-Null
}

try {
  $dockerInfo = docker info --format "{{.ServerVersion}}" 2>$null
  if ($LASTEXITCODE -eq 0) {
    Add-Result "Docker daemon" "OK" $dockerInfo
  } else {
    Add-Result "Docker daemon" "WARN" "not reachable; run scripts\start-local-agent-services.ps1 -StartDockerDesktop"
  }
} catch {
  Add-Result "Docker daemon" "WARN" $_.Exception.Message
}

if (Test-Path -LiteralPath $HermesExe) {
  Add-Result "hermes.exe" "OK" $HermesExe
} elseif (Test-CommandExists "hermes") {
  Add-Result "hermes" "OK" "available on PATH"
} else {
  Add-Result "hermes" "FAIL" "not found"
}

Write-Host ""
Write-Host "== Versions =="

try {
  $hv = if (Test-Path -LiteralPath $HermesExe) {
    & $HermesExe --version 2>&1 | Select-Object -First 1
  } else {
    hermes --version 2>&1 | Select-Object -First 1
  }
  Add-Result "Hermes version" "OK" ([string]$hv)
} catch {
  Add-Result "Hermes version" "FAIL" $_.Exception.Message
}

try {
  $ov = openclaw --version 2>&1 | Select-Object -First 1
  Add-Result "OpenClaw version" "OK" ([string]$ov)
} catch {
  Add-Result "OpenClaw version" "FAIL" $_.Exception.Message
}

try {
  $hgStatus = if (Test-Path -LiteralPath $HermesExe) {
    & $HermesExe gateway status 2>&1
  } else {
    hermes gateway status 2>&1
  }
  $hgText = ($hgStatus -join "`n")
  if ($hgText -match "Gateway process running|Status:\s+.*running|Gateway Service.*running") {
    Add-Result "Hermes gateway status" "OK" "running"
  } elseif ($hgText -match "Gateway is not running") {
    Add-Result "Hermes gateway status" "WARN" "not running; run scripts\start-local-agent-services.ps1 -StartHermesGateway"
  } else {
    Add-Result "Hermes gateway status" "WARN" (($hgStatus | Select-Object -Last 5) -join " ")
  }
} catch {
  Add-Result "Hermes gateway status" "WARN" $_.Exception.Message
}

Write-Host ""
Write-Host "== Config / Gateway =="

try {
  $envPath = Join-Path $Workspace ".env"
  if (Test-Path -LiteralPath $envPath) {
    $envText = Get-Content -Raw -LiteralPath $envPath
    $hasRelay = $envText -match "api\.aiwelink\.cc"
    $hasKey = $envText -match "sk-[A-Za-z0-9_-]{20,}"
    $hasSafety = $envText -match "EXTERNAL_SEND_REQUIRES_CONFIRMATION=true"
    if ($hasRelay -and $hasKey -and $hasSafety) {
      Add-Result "Private .env" "OK" "relay/key present; external send confirmation enabled"
    } else {
      Add-Result "Private .env" "WARN" "missing relay, key, or safety flag"
    }
  } else {
    Add-Result "Private .env" "WARN" "missing; create from .env.example"
  }
} catch {
  Add-Result "Private .env" "WARN" $_.Exception.Message
}

try {
  $out = openclaw config validate 2>&1
  if ($LASTEXITCODE -eq 0) {
    Add-Result "OpenClaw config" "OK" (($out | Select-Object -First 1) -join " ")
  } else {
    Add-Result "OpenClaw config" "FAIL" (($out | Select-Object -First 4) -join " ")
  }
} catch {
  Add-Result "OpenClaw config" "FAIL" $_.Exception.Message
}

try {
  $status = openclaw gateway status 2>&1
  $statusText = ($status -join "`n")
  if ($statusText -match "Connectivity probe:\s+ok") {
    Add-Result "OpenClaw gateway status" "OK" "connectivity probe ok"
  } elseif ($statusText -match "Warm-up|pre-warm|timeout") {
    Add-Result "OpenClaw gateway status" "WARN" "gateway may be warming up; retry in 1-2 minutes"
  } else {
    Add-Result "OpenClaw gateway status" "WARN" (($status | Select-Object -Last 5) -join " ")
  }
} catch {
  Add-Result "OpenClaw gateway status" "FAIL" $_.Exception.Message
}

Write-Host ""
Write-Host "== Local MVP =="

try {
  $localMvpDir = Join-Path $Workspace "local_mvp_test_20260709"
  $validate = powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\validate-local-mvp.ps1") `
    -MvpDir $localMvpDir 2>&1
  if ($LASTEXITCODE -eq 0) {
    Add-Result "Local MVP validation" "OK" "leads/crm/workbook inputs valid"
  } else {
    Add-Result "Local MVP validation" "FAIL" (($validate | Select-Object -Last 8) -join " ")
  }
} catch {
  Add-Result "Local MVP validation" "FAIL" $_.Exception.Message
}

$expectedFiles = @(
  "local_mvp_test_20260709\input_brief.example.yaml",
  "local_mvp_test_20260709\company_profile_template.md",
  "local_mvp_test_20260709\leads.csv",
  "local_mvp_test_20260709\crm_import.csv",
  "outputs\export_leadgen_mvp_20260709\export_leadgen_mvp_20260709.xlsx",
  "HERMES_LOCAL_TEST_RUNBOOK.md",
  "LOCAL_HERMES_PREFLIGHT_STATUS.md",
  "MANUAL_ACTIONS.md",
  "PRODUCT_LAUNCH_STATUS.md",
  "COMMERCIAL_DEPLOYMENT_INPUTS.md",
  "scripts\install-local-scheduled-tasks.ps1",
  "scripts\invoke-daily-real-pipeline.ps1",
  "scripts\run-real-commercial-pipeline.ps1",
  "scripts\start-local-agent-services.ps1",
  "scripts\uninstall-local-scheduled-tasks.ps1"
)

foreach ($rel in $expectedFiles) {
  $path = Join-Path $Workspace $rel
  if (Test-Path -LiteralPath $path) {
    Add-Result "File: $rel" "OK" ""
  } else {
    Add-Result "File: $rel" "FAIL" "missing"
  }
}

Write-Host ""
Write-Host "== Real Business Test =="

$realDir = Join-Path $Workspace "product_data"
if (Test-Path -LiteralPath $realDir) {
  try {
    $validateReal = powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\validate-local-mvp.ps1") -MvpDir $realDir 2>&1
    if ($LASTEXITCODE -eq 0) {
      Add-Result "Product data validation" "OK" "leads/crm/workbook inputs valid"
    } else {
      Add-Result "Product data validation" "FAIL" (($validateReal | Select-Object -Last 8) -join " ")
    }
  } catch {
    Add-Result "Product data validation" "FAIL" $_.Exception.Message
  }
} else {
  Add-Result "Product data directory" "FAIL" "missing"
}

$realExpectedFiles = @(
  "case_inputs\overseas_cases_202606\overseas_cases_summary.md",
  "case_inputs\overseas_cases_202606\extracted_structured.json",
  "product_data\input_brief.yaml",
  "product_data\leads.csv",
  "product_data\crm_import.csv",
  "product_data\manual_verification_queue.csv",
  "outputs\product_launch\commercial_leadgen.xlsx"
)

foreach ($rel in $realExpectedFiles) {
  $path = Join-Path $Workspace $rel
  if (Test-Path -LiteralPath $path) {
    Add-Result "Real file: $rel" "OK" ""
  } else {
    Add-Result "Real file: $rel" "FAIL" "missing"
  }
}

try {
  $task = Get-ScheduledTask -TaskName "Export AI Agent - Daily Real Pipeline" -ErrorAction SilentlyContinue
  if ($task) {
    $taskInfo = Get-ScheduledTaskInfo -TaskName "Export AI Agent - Daily Real Pipeline"
    Add-Result "Daily scheduled task" "OK" "state=$($task.State); next=$($taskInfo.NextRunTime); lastResult=$($taskInfo.LastTaskResult)"
  } else {
    Add-Result "Daily scheduled task" "WARN" "not installed; run scripts\install-local-scheduled-tasks.ps1"
  }
} catch {
  Add-Result "Daily scheduled task" "WARN" $_.Exception.Message
}

try {
  $briefCheck = powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\validate-real-brief.ps1") `
    -BriefPath (Join-Path $realDir "input_brief.yaml") `
    -AllowPlaceholder 2>&1
  $briefText = ($briefCheck -join " ")
  if ($briefText -match "still contains placeholder") {
    Add-Result "Real company brief" "WARN" "company identity/commercial placeholders remain"
  } elseif ($LASTEXITCODE -eq 0) {
    Add-Result "Real company brief" "OK" "required commercial fields filled"
  } else {
    Add-Result "Real company brief" "FAIL" (($briefCheck | Select-Object -Last 8) -join " ")
  }
} catch {
  Add-Result "Real company brief" "WARN" $_.Exception.Message
}

Write-Host ""
Write-Host "== Model Pings =="

if ($SkipModelPing) {
  Add-Result "Model ping" "WARN" "skipped by -SkipModelPing"
} else {
  try {
    $reply = if (Test-Path -LiteralPath $HermesExe) {
      & $HermesExe -z "只回复两个字母：OK" 2>&1
    } else {
      hermes -z "只回复两个字母：OK" 2>&1
    }
    $replyText = ($reply -join "`n").Trim()
    if ($replyText -match "OK") {
      Add-Result "Hermes model ping" "OK" "reply contains OK"
    } else {
      Add-Result "Hermes model ping" "WARN" $replyText
    }
  } catch {
    Add-Result "Hermes model ping" "FAIL" $_.Exception.Message
  }

  try {
    $oc = openclaw agent --local --agent export-local-test --message "只回复两个字母：OK" --json --timeout 120 2>&1
    $ocText = ($oc -join "`n")
    if ($LASTEXITCODE -eq 0 -and $ocText -match '"text"\s*:\s*"OK"') {
      Add-Result "OpenClaw export-local-test ping" "OK" "reply OK"
    } else {
      Add-Result "OpenClaw export-local-test ping" "WARN" (($oc | Select-Object -Last 10) -join " ")
    }
  } catch {
    Add-Result "OpenClaw export-local-test ping" "FAIL" $_.Exception.Message
  }
}

Write-Host ""
Write-Host "== Summary =="
$failCount = @($Results | Where-Object { $_.status -eq "FAIL" }).Count
$warnCount = @($Results | Where-Object { $_.status -eq "WARN" }).Count
Write-Host "Failures: $failCount"
Write-Host "Warnings:  $warnCount"

if ($WriteReport) {
  $reportDir = Join-Path $Workspace ("outputs\agent_stack_check_" + (Get-Date -Format "yyyyMMdd_HHmmss"))
  New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
  $reportPath = Join-Path $reportDir "summary.json"
  $Results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  Write-Host "[OK] Report written: $reportPath"
}

if ($failCount -gt 0) {
  exit 1
}

exit 0
