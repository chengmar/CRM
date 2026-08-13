param(
  [string]$Workspace = "",
  [int]$MaxArtifactAgeHours = 72,
  [switch]$SkipProductionStatusCheck
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$results = New-Object System.Collections.Generic.List[object]

function Add-Check {
  param(
    [string]$Area,
    [string]$Status,
    [string]$Detail
  )
  $safe = $Detail -replace 'sk-[A-Za-z0-9_-]{12,}', 'sk-REDACTED'
  $safe = $safe -replace '(?i)(password|secret|token|api_key)\s*[:=]\s*[^,\s;]+', '$1=REDACTED'
  $results.Add([pscustomobject]@{ area = $Area; status = $Status; detail = $safe }) | Out-Null
  $tag = if ($Status -eq "OK") { "[OK]" } elseif ($Status -eq "WARN") { "[WARN]" } else { "[BLOCKED]" }
  Write-Host "$tag $Area $safe"
}

function Get-LatestFile {
  param(
    [string]$Dir,
    [string]$Filter
  )
  if (-not (Test-Path -LiteralPath $Dir)) { return $null }
  return Get-ChildItem -LiteralPath $Dir -Filter $Filter -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}

function Test-FreshFile {
  param(
    [System.IO.FileInfo]$File,
    [string]$Name,
    [int]$MaxAgeHours,
    [switch]$WarnOnly
  )
  if (-not $File) {
    Add-Check $Name "BLOCKED" "missing"
    return
  }
  $ageHours = ((Get-Date) - $File.LastWriteTime).TotalHours
  $detail = "file=$($File.FullName); age_hours=$([math]::Round($ageHours, 2))"
  if ($ageHours -le $MaxAgeHours) {
    Add-Check $Name "OK" $detail
  } elseif ($WarnOnly) {
    Add-Check $Name "WARN" $detail
  } else {
    Add-Check $Name "BLOCKED" $detail
  }
}

Write-Host "== Production operations health =="
Write-Host "Workspace: $Workspace"
Write-Host "Max artifact age hours: $MaxArtifactAgeHours"

$dataDir = Join-Path $Workspace "product_data"
$outputDir = Join-Path $Workspace "outputs\product_launch"

$requiredFiles = @(
  "product_data\input_brief.yaml",
  "product_data\leads.csv",
  "product_data\crm_import.csv",
  "product_data\manual_verification_queue.csv",
  "product_data\outreach_approval_queue.csv",
  "product_data\outbound_messages.csv",
  "product_data\do_not_contact.csv",
  "outputs\product_launch\commercial_leadgen.xlsx",
  "scripts\run-production-acceptance.ps1",
  "scripts\audit-commercial-completion.ps1",
  "scripts\check-production-readiness.ps1",
  "scripts\check-outbound-readiness.ps1",
  "scripts\backup-production-state.ps1",
  "scripts\deploy-to-vps.ps1",
  "scripts\test-deployment-package.ps1",
  "scripts\test-vps-deployment-scripts.ps1",
  "scripts\export-production-status.ps1",
  "scripts\restore-production-state.ps1",
  "scripts\manage-outreach-queue.ps1",
  "scripts\test-crm-state-preservation.ps1",
  "scripts\test-email-auth.ps1",
  "scripts\validate-outbound-approval.ps1",
  "scripts\build-outbound-messages.ps1",
  "scripts\invoke-outbound-dispatch.ps1",
  "scripts\sync-feishu-crm.ps1",
  "scripts\manage-production-switches.ps1",
  "scripts\run-vps-production-acceptance.ps1",
  "scripts\run-agent-product-acceptance.ps1",
  "scripts\test-agent-service-persistence.ps1",
  "scripts\activate-vps-release.sh",
  "scripts\install-agent-service-systemd.sh",
  "scripts\install-agent-support-services.sh",
  "scripts\install-vps-systemd-timer.sh",
  "infra\support-services.compose.yml",
  "agent_service\package.json",
  "agent_service\src\app.ts",
  "agent_service\src\db.ts",
  "NEXT_PRODUCTION_INPUTS.md",
  "PRODUCTION_LAUNCH_INPUTS.md",
  "PRODUCTION_ACCEPTANCE.md"
)

$missingRequired = @()
foreach ($rel in $requiredFiles) {
  $path = Join-Path $Workspace $rel
  if (-not (Test-Path -LiteralPath $path)) { $missingRequired += $rel }
}
if ($missingRequired.Count -eq 0) {
  Add-Check "Required production files" "OK" "all required files present"
} else {
  Add-Check "Required production files" "BLOCKED" ("missing " + ($missingRequired -join ", "))
}

try {
  $crmRows = @(Import-Csv -LiteralPath (Join-Path $dataDir "crm_import.csv") -Encoding UTF8)
  $emptyDrafts = @($crmRows | Where-Object { [string]::IsNullOrWhiteSpace($_.email_draft) -or [string]::IsNullOrWhiteSpace($_.whatsapp_opener) }).Count
  $blankSources = @($crmRows | Where-Object { [string]::IsNullOrWhiteSpace($_.source_url) }).Count
  if ($crmRows.Count -gt 0 -and $emptyDrafts -eq 0 -and $blankSources -eq 0) {
    Add-Check "CRM operational data" "OK" "rows=$($crmRows.Count); empty_drafts=$emptyDrafts; blank_sources=$blankSources"
  } else {
    Add-Check "CRM operational data" "BLOCKED" "rows=$($crmRows.Count); empty_drafts=$emptyDrafts; blank_sources=$blankSources"
  }
} catch {
  Add-Check "CRM operational data" "BLOCKED" $_.Exception.Message
}

try {
  $manualRows = @(Import-Csv -LiteralPath (Join-Path $dataDir "manual_verification_queue.csv") -Encoding UTF8)
  $unsafeManual = @($manualRows | Where-Object { $_."Send Status" -ne "DO_NOT_SEND_YET" }).Count
  $approvalRows = @(Import-Csv -LiteralPath (Join-Path $dataDir "outreach_approval_queue.csv") -Encoding UTF8)
  $messages = @(Import-Csv -LiteralPath (Join-Path $dataDir "outbound_messages.csv") -Encoding UTF8)
  $sentWithoutSentAt = @($messages | Where-Object { $_.send_status -eq "SENT" -and [string]::IsNullOrWhiteSpace($_.sent_at) }).Count
  if ($unsafeManual -eq 0 -and $approvalRows.Count -gt 0 -and $messages.Count -gt 0 -and $sentWithoutSentAt -eq 0) {
    Add-Check "Outbound operational queues" "OK" "manual=$($manualRows.Count); approval=$($approvalRows.Count); messages=$($messages.Count); sent_without_sent_at=$sentWithoutSentAt"
  } else {
    Add-Check "Outbound operational queues" "BLOCKED" "unsafe_manual=$unsafeManual; approval=$($approvalRows.Count); messages=$($messages.Count); sent_without_sent_at=$sentWithoutSentAt"
  }
} catch {
  Add-Check "Outbound operational queues" "BLOCKED" $_.Exception.Message
}

$latestAcceptance = Get-LatestFile (Join-Path $Workspace "outputs\acceptance") "production-acceptance-*.json"
if ($latestAcceptance) {
  try {
    $acceptance = Get-Content -LiteralPath $latestAcceptance.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($acceptance.failed -eq 0) {
      Add-Check "Latest acceptance report" "OK" "failed=0; warnings=$($acceptance.warnings); file=$($latestAcceptance.FullName)"
    } else {
      Add-Check "Latest acceptance report" "BLOCKED" "failed=$($acceptance.failed); file=$($latestAcceptance.FullName)"
    }
  } catch {
    Add-Check "Latest acceptance report" "BLOCKED" $_.Exception.Message
  }
} else {
  Add-Check "Latest acceptance report" "WARN" "no acceptance report found"
}

Test-FreshFile -File $latestAcceptance -Name "Acceptance report freshness" -MaxAgeHours $MaxArtifactAgeHours -WarnOnly
Test-FreshFile -File (Get-LatestFile $outputDir "commercial_leadgen.xlsx") -Name "Workbook freshness" -MaxAgeHours $MaxArtifactAgeHours -WarnOnly

$latestAgentProduct = Get-LatestFile (Join-Path $Workspace "outputs\agent_product_acceptance") "agent-product-acceptance-*.json"
if ($latestAgentProduct) {
  try {
    $agentProduct = Get-Content -LiteralPath $latestAgentProduct.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($agentProduct.failed -eq 0) {
      Add-Check "Agent product acceptance" "OK" "failed=0; passed=$($agentProduct.passed); file=$($latestAgentProduct.FullName)"
    } else {
      Add-Check "Agent product acceptance" "BLOCKED" "failed=$($agentProduct.failed); file=$($latestAgentProduct.FullName)"
    }
  } catch {
    Add-Check "Agent product acceptance" "BLOCKED" $_.Exception.Message
  }
} else {
  Add-Check "Agent product acceptance" "BLOCKED" "no Agent product acceptance report found"
}
Test-FreshFile -File $latestAgentProduct -Name "Agent product acceptance freshness" -MaxAgeHours $MaxArtifactAgeHours

$agentDb = Join-Path $Workspace "agent_service\data\agent.db"
$agentCli = Join-Path $Workspace "agent_service\dist\cli.js"
if ((Test-Path -LiteralPath $agentDb) -and (Test-Path -LiteralPath $agentCli)) {
  $previousDbPath = $env:AGENT_DB_PATH
  $previousNodeNoWarnings = $env:NODE_NO_WARNINGS
  try {
    $env:AGENT_DB_PATH = $agentDb
    $env:NODE_NO_WARNINGS = "1"
    $dbOutput = & node $agentCli verify-db 2>&1
    if ($LASTEXITCODE -eq 0) {
      Add-Check "Agent database health" "OK" "schema current; integrity check passed"
    } else {
      Add-Check "Agent database health" "BLOCKED" (($dbOutput | Select-Object -Last 5) -join " | ")
    }
  } catch {
    Add-Check "Agent database health" "BLOCKED" $_.Exception.Message
  } finally {
    $env:AGENT_DB_PATH = $previousDbPath
    $env:NODE_NO_WARNINGS = $previousNodeNoWarnings
  }
} else {
  Add-Check "Agent database health" "BLOCKED" "agent database or compiled CLI is missing"
}

$latestBackup = Get-LatestFile (Join-Path $Workspace "outputs\backups") "production-state-backup-*.zip"
if ($latestBackup) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $backupZip = [System.IO.Compression.ZipFile]::OpenRead($latestBackup.FullName)
    try {
      $manifest = $backupZip.Entries | Where-Object { $_.FullName -eq "backup_manifest.json" } | Select-Object -First 1
      $privateEnv = @($backupZip.Entries | Where-Object { $_.FullName -eq ".env" -or ($_.FullName -like ".env.*" -and $_.FullName -ne ".env.example") }).Count
      if ($manifest -and $privateEnv -eq 0) {
        $agentDbEntry = $backupZip.Entries | Where-Object { ($_.FullName -replace '\\','/') -eq "agent_service/data/agent.db" } | Select-Object -First 1
        if ($agentDbEntry) {
          Add-Check "Latest production backup" "OK" "backup=$($latestBackup.FullName); private_env=0; agent_db=yes"
        } else {
          Add-Check "Latest production backup" "BLOCKED" "manifest present but Agent SQLite snapshot is missing"
        }
      } else {
        Add-Check "Latest production backup" "BLOCKED" "manifest_present=$([bool]$manifest); private_env=$privateEnv"
      }
    } finally {
      $backupZip.Dispose()
    }
  } catch {
    Add-Check "Latest production backup" "BLOCKED" $_.Exception.Message
  }
} else {
  Add-Check "Latest production backup" "WARN" "no backup found"
}
Test-FreshFile -File $latestBackup -Name "Production backup freshness" -MaxAgeHours $MaxArtifactAgeHours -WarnOnly

$latestPackageSmoke = Get-LatestFile (Join-Path $Workspace "outputs\package_smoke") "package-smoke-*.json"
if ($latestPackageSmoke) {
  try {
    $smoke = Get-Content -LiteralPath $latestPackageSmoke.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($smoke.blocked -eq 0) {
      Add-Check "Latest package smoke test" "OK" "blocked=0; warnings=$($smoke.warnings); file=$($latestPackageSmoke.FullName)"
    } else {
      Add-Check "Latest package smoke test" "BLOCKED" "blocked=$($smoke.blocked); file=$($latestPackageSmoke.FullName)"
    }
  } catch {
    Add-Check "Latest package smoke test" "BLOCKED" $_.Exception.Message
  }
} else {
  Add-Check "Latest package smoke test" "WARN" "no package smoke report found"
}
Test-FreshFile -File $latestPackageSmoke -Name "Package smoke freshness" -MaxAgeHours $MaxArtifactAgeHours -WarnOnly

if ($SkipProductionStatusCheck) {
  Add-Check "Latest production status" "WARN" "skipped by -SkipProductionStatusCheck"
} else {
  $latestStatus = Get-LatestFile (Join-Path $Workspace "outputs\production_status") "production-status-*.json"
  if ($latestStatus) {
    try {
      $statusReport = Get-Content -LiteralPath $latestStatus.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($statusReport.launch_state -ne "NOT_READY_CHECK_REPORTS") {
        Add-Check "Latest production status" "OK" "state=$($statusReport.launch_state); file=$($latestStatus.FullName)"
      } else {
        Add-Check "Latest production status" "BLOCKED" "state=$($statusReport.launch_state); file=$($latestStatus.FullName)"
      }
    } catch {
      Add-Check "Latest production status" "BLOCKED" $_.Exception.Message
    }
  } else {
    Add-Check "Latest production status" "WARN" "no production status report found"
  }
  Test-FreshFile -File $latestStatus -Name "Production status freshness" -MaxAgeHours $MaxArtifactAgeHours -WarnOnly
}

try {
  $taskInfo = Get-ScheduledTaskInfo -TaskName "Export AI Agent - Daily Real Pipeline"
  if ($taskInfo.LastTaskResult -eq 0) {
    Add-Check "Scheduled task result" "OK" "last_result=0; next=$($taskInfo.NextRunTime)"
  } else {
    Add-Check "Scheduled task result" "WARN" "last_result=$($taskInfo.LastTaskResult); next=$($taskInfo.NextRunTime)"
  }
} catch {
  Add-Check "Scheduled task result" "WARN" $_.Exception.Message
}

$latestPackage = Get-LatestFile (Join-Path $Workspace "dist") "export-ai-agent-deployment-*.zip"
if ($latestPackage) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($latestPackage.FullName)
    try {
      $privateEnv = @($zip.Entries | Where-Object { $_.FullName -eq ".env" -or ($_.FullName -like ".env.*" -and $_.FullName -ne ".env.example") }).Count
      $packageRequired = @(
        "NEXT_PRODUCTION_INPUTS.md",
        "PRODUCTION_ACCEPTANCE.md",
        "scripts/check-production-ops.ps1",
        "scripts/backup-production-state.ps1",
        "scripts/deploy-to-vps.ps1",
        "scripts/test-deployment-package.ps1",
        "scripts/test-vps-deployment-scripts.ps1",
        "scripts/export-production-status.ps1",
        "scripts/restore-production-state.ps1",
        "scripts/manage-outreach-queue.ps1",
        "scripts/test-crm-state-preservation.ps1",
        "scripts/run-production-acceptance.ps1",
        "scripts/build-outbound-messages.ps1",
        "scripts/invoke-outbound-dispatch.ps1",
        "scripts/sync-feishu-crm.ps1",
        "scripts/validate-commercial-launch-inputs.ps1",
        "scripts/run-vps-production-acceptance.ps1",
        "scripts/run-agent-product-acceptance.ps1",
        "scripts/test-agent-service-persistence.ps1",
        "scripts/activate-vps-release.sh",
        "scripts/install-agent-service-systemd.sh",
        "scripts/install-agent-support-services.sh",
        "infra/support-services.compose.yml",
        "agent_service/package.json",
        "agent_service/src/app.ts",
        "scripts/install-vps-systemd-timer.sh",
        "workbook_build/node_modules/@oai/artifact-tool/package.json",
        "product_data/outbound_messages.csv"
      )
      $missingInPackage = @()
      foreach ($rel in $packageRequired) {
        $hit = $zip.Entries | Where-Object { ($_.FullName -replace '\\','/') -eq $rel } | Select-Object -First 1
        if (-not $hit) { $missingInPackage += $rel }
      }
      if ($privateEnv -eq 0 -and $missingInPackage.Count -eq 0) {
        Add-Check "Deployment package integrity" "OK" "package=$($latestPackage.FullName); private_env=0"
      } else {
        Add-Check "Deployment package integrity" "BLOCKED" "private_env=$privateEnv; missing=$($missingInPackage -join ', ')"
      }
    } finally {
      $zip.Dispose()
    }
  } catch {
    Add-Check "Deployment package integrity" "BLOCKED" $_.Exception.Message
  }
} else {
  Add-Check "Deployment package integrity" "BLOCKED" "no deployment package found"
}

Test-FreshFile -File $latestPackage -Name "Deployment package freshness" -MaxAgeHours $MaxArtifactAgeHours -WarnOnly

try {
  $drive = Get-PSDrive -Name ((Get-Item -LiteralPath $Workspace).PSDrive.Name)
  $freeGb = [math]::Round($drive.Free / 1GB, 2)
  if ($freeGb -ge 2) {
    Add-Check "Disk free space" "OK" "free_gb=$freeGb"
  } else {
    Add-Check "Disk free space" "WARN" "free_gb=$freeGb"
  }
} catch {
  Add-Check "Disk free space" "WARN" $_.Exception.Message
}

$reportDir = Join-Path $Workspace "outputs\ops_health"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$reportPath = Join-Path $reportDir ("ops-health-" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".json")
$summary = [pscustomobject]@{
  generated_at = (Get-Date -Format s)
  workspace = $Workspace
  max_artifact_age_hours = $MaxArtifactAgeHours
  blocked = @($results | Where-Object { $_.status -eq "BLOCKED" }).Count
  warnings = @($results | Where-Object { $_.status -eq "WARN" }).Count
  results = $results
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Host ""
Write-Host "Blocked: $($summary.blocked)"
Write-Host "Warnings: $($summary.warnings)"
Write-Host "[OK] Report written: $reportPath"

if ($summary.blocked -gt 0) {
  exit 1
}
exit 0
