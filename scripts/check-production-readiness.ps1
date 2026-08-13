param(
  [string]$Workspace = "",
  [string]$PackagePath = ""
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$emailLaunchPolicyScript = Join-Path $PSScriptRoot "email-staged-launch-policy.ps1"
if (-not (Test-Path -LiteralPath $emailLaunchPolicyScript)) {
  throw "Email staged-launch policy script is missing."
}
. $emailLaunchPolicyScript

$results = New-Object System.Collections.Generic.List[object]

function Add-Check {
  param(
    [string]$Area,
    [string]$Status,
    [string]$Detail
  )
  $safeDetail = $Detail -replace 'sk-[A-Za-z0-9_-]+', 'sk-REDACTED'
  $results.Add([pscustomobject]@{ area = $Area; status = $Status; detail = $safeDetail }) | Out-Null
  $tag = if ($Status -eq "OK") { "[OK]" } elseif ($Status -eq "WARN") { "[WARN]" } else { "[BLOCKED]" }
  Write-Host "$tag $Area $safeDetail"
}

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

Write-Host "== Production readiness check =="
Write-Host "Workspace: $Workspace"

$envPath = Join-Path $Workspace ".env"
$envMap = Get-EnvMap $envPath
if ($envMap.Count -eq 0) {
  Add-Check "Private .env" "BLOCKED" "missing"
} else {
  if (-not [string]::IsNullOrWhiteSpace([string]$envMap.OPENAI_BASE_URL) -and
      -not [string]::IsNullOrWhiteSpace([string]$envMap.OPENAI_API_KEY) -and
      -not [string]::IsNullOrWhiteSpace([string]$envMap.OPENAI_MODEL)) {
    Add-Check "Model API" "OK" "base URL, credential, and model configured"
  } else {
    Add-Check "Model API" "BLOCKED" "missing OPENAI_BASE_URL, OPENAI_API_KEY, or OPENAI_MODEL"
  }

  if ($envMap.EXTERNAL_SEND_REQUIRES_CONFIRMATION -eq "true" -and $envMap.REQUIRE_HUMAN_APPROVAL_BEFORE_SEND -eq "true") {
    Add-Check "External send safety" "OK" "human approval required"
  } else {
    Add-Check "External send safety" "BLOCKED" "approval safety flags must remain true"
  }

  if ($envMap.OUTREACH_APPROVAL_REQUIRED -eq "true") {
    Add-Check "Outbound approval requirement" "OK" "approval queue required before dispatch"
  } else {
    Add-Check "Outbound approval requirement" "BLOCKED" "OUTREACH_APPROVAL_REQUIRED must be true"
  }

  $feishuMissing = @("FEISHU_APP_ID", "FEISHU_APP_SECRET", "CRM_SPREADSHEET_TOKEN", "CRM_SHEET_ID") |
    Where-Object { [string]::IsNullOrWhiteSpace($envMap[$_]) }
  if ($feishuMissing.Count -eq 0) {
    Add-Check "Feishu CRM" "OK" "app and sheet identifiers present"
  } else {
    Add-Check "Feishu CRM" "BLOCKED" ("missing " + ($feishuMissing -join ", "))
  }

  if ($envMap.FEISHU_CRM_SYNC_ENABLED -eq "true") {
    if ($envMap.FEISHU_CRM_WRITE_TEST_PASSED -eq "true") {
      Add-Check "Feishu CRM write activation" "OK" "daily sync enabled after write test"
    } else {
      Add-Check "Feishu CRM write activation" "BLOCKED" "daily sync enabled before FEISHU_CRM_WRITE_TEST_PASSED=true"
    }
  } else {
    Add-Check "Feishu CRM write activation" "WARN" "daily sync disabled until one-row write test is approved and passed"
  }

  if ($envMap.EMAIL_OUTREACH_ENABLED -eq "true") {
    $emailLaunchPolicy = Get-EnterpriseEmailLaunchPolicy -Map $envMap
    $emailPolicyDetail = Format-EnterpriseEmailLaunchPolicy -Policy $emailLaunchPolicy
    if (-not $emailLaunchPolicy.configured) {
      Add-Check "Email outreach" "BLOCKED" $emailPolicyDetail
    } elseif ($emailLaunchPolicy.launch_mode -eq "staged_controlled_ramp") {
      Add-Check "Email outreach" "WARN" ("ready for controlled staged deployment and operation; " + $emailPolicyDetail)
    } else {
      Add-Check "Email outreach" "OK" ("ready at configured limits; " + $emailPolicyDetail)
    }
  } else {
    Add-Check "Email outreach" "WARN" "disabled, safe for pre-production"
  }
}

$briefPath = Join-Path $Workspace "product_data\input_brief.yaml"
if (Test-Path -LiteralPath $briefPath) {
  $brief = powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\validate-real-brief.ps1") `
    -BriefPath $briefPath 2>&1
  if ($LASTEXITCODE -eq 0) {
    Add-Check "Company brief" "OK" "required company/commercial fields filled"
  } else {
    Add-Check "Company brief" "BLOCKED" (($brief | Select-Object -Last 12) -join " ")
  }
} else {
  Add-Check "Company brief" "BLOCKED" "input_brief.yaml missing"
}

try {
  $mvp = powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\validate-local-mvp.ps1") `
    -MvpDir (Join-Path $Workspace "product_data") 2>&1
  if ($LASTEXITCODE -eq 0) {
    Add-Check "Real leadgen outputs" "OK" "CRM/workbook inputs valid"
  } else {
    Add-Check "Real leadgen outputs" "BLOCKED" (($mvp | Select-Object -Last 8) -join " ")
  }
} catch {
  Add-Check "Real leadgen outputs" "BLOCKED" $_.Exception.Message
}

try {
  $dispatch = powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\invoke-outbound-dispatch.ps1") -Mode Plan 2>&1
  if ($LASTEXITCODE -eq 0) {
    Add-Check "Outbound dispatch plan" "OK" "plan mode passed without sending"
  } else {
    Add-Check "Outbound dispatch plan" "BLOCKED" (($dispatch | Select-Object -Last 8) -join " ")
  }
} catch {
  Add-Check "Outbound dispatch plan" "BLOCKED" $_.Exception.Message
}

try {
  $hermesExe = "C:\Users\your-user\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe"
  $hg = & $hermesExe gateway status 2>&1
  $hgText = ($hg -join "`n")
  if ($hgText -match "Gateway process running|Status:\s+.*running|Gateway Service.*running") {
    Add-Check "Hermes gateway" "OK" "running"
  } else {
    Add-Check "Hermes gateway" "BLOCKED" (($hg | Select-Object -Last 5) -join " ")
  }
} catch {
  Add-Check "Hermes gateway" "BLOCKED" $_.Exception.Message
}

try {
  $oc = openclaw gateway status 2>&1
  $ocText = ($oc -join "`n")
  if ($ocText -match "Connectivity probe:\s+ok") {
    Add-Check "OpenClaw gateway" "OK" "connectivity probe ok"
  } elseif ($ocText -match "Port 18789 is already in use|Listening:\s+127\.0\.0\.1:18789") {
    try {
      $health = curl.exe -s http://127.0.0.1:18789/health 2>$null
      if ($health -match '"ok"\s*:\s*true|"status"\s*:\s*"live"') {
        Add-Check "OpenClaw gateway" "OK" "listening on 127.0.0.1:18789; health live"
      } else {
        Add-Check "OpenClaw gateway" "WARN" (($oc | Select-Object -Last 5) -join " ")
      }
    } catch {
      Add-Check "OpenClaw gateway" "WARN" (($oc | Select-Object -Last 5) -join " ")
    }
  } else {
    Add-Check "OpenClaw gateway" "WARN" (($oc | Select-Object -Last 5) -join " ")
  }
} catch {
  Add-Check "OpenClaw gateway" "WARN" $_.Exception.Message
}

try {
  $task = Get-ScheduledTask -TaskName "Export AI Agent - Daily Real Pipeline" -ErrorAction SilentlyContinue
  if ($task) {
    $taskInfo = Get-ScheduledTaskInfo -TaskName "Export AI Agent - Daily Real Pipeline"
    if ($taskInfo.LastTaskResult -eq 0) {
      Add-Check "Daily scheduled task" "OK" "next=$($taskInfo.NextRunTime)"
    } else {
      Add-Check "Daily scheduled task" "WARN" "lastResult=$($taskInfo.LastTaskResult); next=$($taskInfo.NextRunTime)"
    }
  } else {
    Add-Check "Daily scheduled task" "WARN" "not installed"
  }
} catch {
  Add-Check "Daily scheduled task" "WARN" $_.Exception.Message
}

if ([string]::IsNullOrWhiteSpace($PackagePath)) {
  $latest = Get-ChildItem -LiteralPath (Join-Path $Workspace "dist") -Filter "export-ai-agent-deployment-*.zip" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($latest) { $PackagePath = $latest.FullName }
}

if (-not [string]::IsNullOrWhiteSpace($PackagePath) -and (Test-Path -LiteralPath $PackagePath)) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($PackagePath)
    $privateEnv = $zip.Entries | Where-Object { $_.FullName -eq ".env" -or ($_.FullName -like ".env.*" -and $_.FullName -ne ".env.example") }
    if ($privateEnv) {
      Add-Check "Deployment package" "BLOCKED" "private env found in package"
    } else {
      Add-Check "Deployment package" "OK" "latest package excludes private env"
    }
    $zip.Dispose()
  } catch {
    Add-Check "Deployment package" "WARN" $_.Exception.Message
  }
} else {
  Add-Check "Deployment package" "WARN" "no package found"
}

Write-Host ""
$blocked = @($results | Where-Object { $_.status -eq "BLOCKED" }).Count
$warn = @($results | Where-Object { $_.status -eq "WARN" }).Count
Write-Host "Blocked: $blocked"
Write-Host "Warnings: $warn"

$reportDir = Join-Path $Workspace "outputs\production_readiness"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$reportPath = Join-Path $reportDir ("readiness-" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".json")
$results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Host "[OK] Report written: $reportPath"

if ($blocked -gt 0) {
  exit 1
}

exit 0
