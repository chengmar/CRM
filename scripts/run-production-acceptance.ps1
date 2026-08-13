param(
  [string]$Workspace = "",
  [switch]$SkipModelPing,
  [switch]$AllowFeishuTestWrite,
  [switch]$SkipPackageRebuild
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$results = New-Object System.Collections.Generic.List[object]
$startedAt = Get-Date
$reportDir = Join-Path $Workspace "outputs\acceptance"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$reportPath = Join-Path $reportDir "production-acceptance-$stamp.json"

function Redact-Text {
  param([string]$Text)
  if ($null -eq $Text) { return "" }
  $safe = $Text -replace 'sk-[A-Za-z0-9_-]{12,}', 'sk-REDACTED'
  $safe = $safe -replace '(?i)(app_secret|FEISHU_APP_SECRET|OPENAI_API_KEY|SMTP_PASSWORD|IMAP_PASSWORD)\s*[:=]\s*[^,\s;]+', '$1=REDACTED'
  return $safe
}

function Add-Result {
  param(
    [string]$Name,
    [string]$Status,
    [string]$Detail,
    [int]$ExitCode = 0
  )
  $safeDetail = Redact-Text $Detail
  $results.Add([pscustomobject]@{
    name = $Name
    status = $Status
    exit_code = $ExitCode
    detail = $safeDetail
  }) | Out-Null
  $tag = if ($Status -eq "PASS") { "[PASS]" } elseif ($Status -eq "WARN") { "[WARN]" } else { "[FAIL]" }
  Write-Host "$tag $Name $safeDetail"
}

function Invoke-CheckedCommand {
  param(
    [string]$Name,
    [string]$Command,
    [int[]]$AllowedExitCodes = @(0),
    [switch]$WarningOnly
  )
  Write-Host ""
  Write-Host "== $Name =="
  $output = & powershell -NoProfile -ExecutionPolicy Bypass -Command $Command 2>&1
  $exitCode = $LASTEXITCODE
  $text = Redact-Text (($output | ForEach-Object { [string]$_ }) -join "`n")
  if ($text.Length -gt 5000) {
    $text = $text.Substring($text.Length - 5000)
  }
  if ($AllowedExitCodes -contains $exitCode) {
    Add-Result $Name "PASS" (($text | Select-String -Pattern '.' | Select-Object -Last 6 | ForEach-Object { $_.Line }) -join " | ") $exitCode
  } elseif ($WarningOnly) {
    Add-Result $Name "WARN" (($text | Select-String -Pattern '.' | Select-Object -Last 6 | ForEach-Object { $_.Line }) -join " | ") $exitCode
  } else {
    Add-Result $Name "FAIL" (($text | Select-String -Pattern '.' | Select-Object -Last 12 | ForEach-Object { $_.Line }) -join " | ") $exitCode
  }
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

function Write-AcceptanceReport {
  $script:endedAt = Get-Date
  $script:failed = @($script:results | Where-Object { $_.status -eq "FAIL" }).Count
  $script:warnings = @($script:results | Where-Object { $_.status -eq "WARN" }).Count
  $summary = [pscustomobject]@{
    started_at = $script:startedAt.ToString("s")
    ended_at = $script:endedAt.ToString("s")
    workspace = $script:Workspace
    allow_feishu_test_write = [bool]$script:AllowFeishuTestWrite
    failed = $script:failed
    warnings = $script:warnings
    results = $script:results
  }
  $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $script:reportPath -Encoding UTF8
}

Write-Host "== Production acceptance =="
Write-Host "Workspace: $Workspace"
Write-Host "Started: $($startedAt.ToString('s'))"
Write-Host "Feishu write test: $AllowFeishuTestWrite"
Write-Host "External outreach: disabled unless explicitly configured and approved"

Invoke-CheckedCommand `
  -Name "Local services" `
  -Command "& '$Workspace\scripts\start-local-agent-services.ps1' -StartDockerDesktop"

Invoke-CheckedCommand `
  -Name "Agent product service" `
  -Command "& '$Workspace\scripts\run-agent-product-acceptance.ps1' -Workspace '$Workspace'"

if ($SkipModelPing) {
  Invoke-CheckedCommand `
    -Name "Agent stack" `
    -Command "& '$Workspace\scripts\check-agent-stack.ps1' -SkipModelPing"
} else {
  Invoke-CheckedCommand `
    -Name "Agent stack with model ping" `
    -Command "& '$Workspace\scripts\check-agent-stack.ps1'"
}

Invoke-CheckedCommand `
  -Name "Company brief validation" `
  -Command "& '$Workspace\scripts\validate-real-brief.ps1' -BriefPath '$Workspace\product_data\input_brief.yaml'"

if ($SkipModelPing) {
  Invoke-CheckedCommand `
    -Name "Real commercial pipeline" `
    -Command "& '$Workspace\scripts\run-real-commercial-pipeline.ps1'"
} else {
  Invoke-CheckedCommand `
    -Name "Real commercial pipeline and agent smoke" `
    -Command "& '$Workspace\scripts\run-real-commercial-pipeline.ps1' -RunAgentSmoke"
}

Invoke-CheckedCommand `
  -Name "Local data validation" `
  -Command "& '$Workspace\scripts\validate-local-mvp.ps1' -MvpDir '$Workspace\product_data'"

Invoke-CheckedCommand `
  -Name "CRM state preservation" `
  -Command "& '$Workspace\scripts\test-crm-state-preservation.ps1' -Workspace '$Workspace'"

Invoke-CheckedCommand `
  -Name "VPS deployment scripts" `
  -Command "& '$Workspace\scripts\test-vps-deployment-scripts.ps1' -Workspace '$Workspace'"

try {
  $crmRows = @(Import-Csv -LiteralPath (Join-Path $Workspace "product_data\crm_import.csv") -Encoding UTF8)
  $blankOwners = @($crmRows | Where-Object { [string]::IsNullOrWhiteSpace($_.owner) }).Count
  if ($crmRows.Count -eq 16 -and $blankOwners -eq 0) {
    Add-Result "CRM owner and row count" "PASS" "rows=$($crmRows.Count); blank_owner=$blankOwners"
  } else {
    Add-Result "CRM owner and row count" "FAIL" "rows=$($crmRows.Count); blank_owner=$blankOwners"
  }
} catch {
  Add-Result "CRM owner and row count" "FAIL" $_.Exception.Message
}

try {
  $manualRows = @(Import-Csv -LiteralPath (Join-Path $Workspace "product_data\manual_verification_queue.csv") -Encoding UTF8)
  $unsafeRows = @($manualRows | Where-Object { $_."Send Status" -ne "DO_NOT_SEND_YET" }).Count
  if ($manualRows.Count -gt 0 -and $unsafeRows -eq 0) {
    Add-Result "Manual verification safety" "PASS" "rows=$($manualRows.Count); all DO_NOT_SEND_YET"
  } else {
    Add-Result "Manual verification safety" "FAIL" "rows=$($manualRows.Count); unsafe_send_status=$unsafeRows"
  }
} catch {
  Add-Result "Manual verification safety" "FAIL" $_.Exception.Message
}

try {
  $formulaPath = Join-Path $Workspace "outputs\product_launch\formula_errors.ndjson"
  $formulaText = if (Test-Path -LiteralPath $formulaPath) { Get-Content -LiteralPath $formulaPath -Raw -Encoding UTF8 } else { "" }
  if ($formulaText -match "matched 0 entries") {
    Add-Result "Workbook formula scan" "PASS" "formula_errors.ndjson reports 0 matches"
  } else {
    Add-Result "Workbook formula scan" "FAIL" "formula_errors.ndjson missing clean scan"
  }
} catch {
  Add-Result "Workbook formula scan" "FAIL" $_.Exception.Message
}

Invoke-CheckedCommand `
  -Name "Feishu CRM read-only sync plan" `
  -Command "& '$Workspace\scripts\sync-feishu-crm.ps1' -Mode Plan"

Invoke-CheckedCommand `
  -Name "Outbound channel readiness" `
  -Command "& '$Workspace\scripts\check-outbound-readiness.ps1'"

Invoke-CheckedCommand `
  -Name "Commercial launch input report" `
  -Command "& '$Workspace\scripts\validate-commercial-launch-inputs.ps1' -Workspace '$Workspace'"

Invoke-CheckedCommand `
  -Name "Email SMTP IMAP auth smoke" `
  -Command "& '$Workspace\scripts\test-email-auth.ps1' -Workspace '$Workspace'"

Invoke-CheckedCommand `
  -Name "Outbound dispatch plan" `
  -Command "& '$Workspace\scripts\invoke-outbound-dispatch.ps1' -Mode Plan"

Invoke-CheckedCommand `
  -Name "Outbound send safety refusal" `
  -Command "& '$Workspace\scripts\invoke-outbound-dispatch.ps1' -Mode SendEmail" `
  -AllowedExitCodes @(1)

Invoke-CheckedCommand `
  -Name "WhatsApp send safety refusal" `
  -Command "& '$Workspace\scripts\invoke-outbound-dispatch.ps1' -Mode SendWhatsAppTemplate" `
  -AllowedExitCodes @(1)

if ($AllowFeishuTestWrite) {
  Invoke-CheckedCommand `
    -Name "Feishu CRM one-row write test" `
    -Command "& '$Workspace\scripts\sync-feishu-crm.ps1' -Mode AppendTest -ConfirmWrite"
} else {
  Add-Result "Feishu CRM one-row write test" "WARN" "Skipped. Run with -AllowFeishuTestWrite after explicit approval."
}

Invoke-CheckedCommand `
  -Name "Production readiness" `
  -Command "& '$Workspace\scripts\check-production-readiness.ps1'"

Invoke-CheckedCommand `
  -Name "Production state backup" `
  -Command "& '$Workspace\scripts\backup-production-state.ps1' -Reason 'production-acceptance'"

try {
  $taskInfo = Get-ScheduledTaskInfo -TaskName "Export AI Agent - Daily Real Pipeline"
  if ($taskInfo.LastTaskResult -eq 0) {
    Add-Result "Daily scheduled task" "PASS" "next=$($taskInfo.NextRunTime)"
  } else {
    Add-Result "Daily scheduled task" "FAIL" "lastResult=$($taskInfo.LastTaskResult); next=$($taskInfo.NextRunTime)"
  }
} catch {
  Add-Result "Daily scheduled task" "FAIL" $_.Exception.Message
}

if (-not $SkipPackageRebuild) {
  Invoke-CheckedCommand `
    -Name "Deployment package rebuild" `
    -Command "& '$Workspace\scripts\package-deployment-bundle.ps1' -IncludeRealData"
} else {
  Add-Result "Deployment package rebuild" "WARN" "Skipped by -SkipPackageRebuild"
}

try {
  $latest = Get-ChildItem -LiteralPath (Join-Path $Workspace "dist") -Filter "export-ai-agent-deployment-*.zip" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $latest) {
    throw "No deployment package found."
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($latest.FullName)
  try {
    $privateEnv = $zip.Entries | Where-Object { $_.FullName -eq ".env" -or ($_.FullName -like ".env.*" -and $_.FullName -ne ".env.example") }
    $syncScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/sync-feishu-crm.ps1" } | Select-Object -First 1
    $backupScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/backup-production-state.ps1" } | Select-Object -First 1
    $deployScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/deploy-to-vps.ps1" } | Select-Object -First 1
    $packageTestScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/test-deployment-package.ps1" } | Select-Object -First 1
    $vpsScriptsTest = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/test-vps-deployment-scripts.ps1" } | Select-Object -First 1
    $vpsAcceptanceScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/run-vps-production-acceptance.ps1" } | Select-Object -First 1
    $vpsTimerScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/install-vps-systemd-timer.sh" } | Select-Object -First 1
    $releaseActivationScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/activate-vps-release.sh" } | Select-Object -First 1
    $bitableBootstrapScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/bootstrap-feishu-bitable.ps1" } | Select-Object -First 1
    $agentProductScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/run-agent-product-acceptance.ps1" } | Select-Object -First 1
    $agentPersistenceScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/test-agent-service-persistence.ps1" } | Select-Object -First 1
    $agentSupportInstaller = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/install-agent-support-services.sh" } | Select-Object -First 1
    $agentSupportCompose = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "infra/support-services.compose.yml" } | Select-Object -First 1
    $agentPackage = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "agent_service/package.json" } | Select-Object -First 1
    $agentApp = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "agent_service/src/app.ts" } | Select-Object -First 1
    $statusScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/export-production-status.ps1" } | Select-Object -First 1
    $restoreScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/restore-production-state.ps1" } | Select-Object -First 1
    $queueManagerScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/manage-outreach-queue.ps1" } | Select-Object -First 1
    $crmPreservationScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/test-crm-state-preservation.ps1" } | Select-Object -First 1
    $launchInputsScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/validate-commercial-launch-inputs.ps1" } | Select-Object -First 1
    $acceptanceScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/run-production-acceptance.ps1" } | Select-Object -First 1
    $outboundScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/check-outbound-readiness.ps1" } | Select-Object -First 1
    $opsScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/check-production-ops.ps1" } | Select-Object -First 1
    $commercialAuditScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/audit-commercial-completion.ps1" } | Select-Object -First 1
    $approvalScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/validate-outbound-approval.ps1" } | Select-Object -First 1
    $emailAuthScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/test-email-auth.ps1" } | Select-Object -First 1
    $buildMessagesScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/build-outbound-messages.ps1" } | Select-Object -First 1
    $dispatchScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/invoke-outbound-dispatch.ps1" } | Select-Object -First 1
    $switchScript = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "scripts/manage-production-switches.ps1" } | Select-Object -First 1
    $acceptanceDoc = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "PRODUCTION_ACCEPTANCE.md" } | Select-Object -First 1
    $launchInputsDoc = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "PRODUCTION_LAUNCH_INPUTS.md" } | Select-Object -First 1
    $artifactTool = $zip.Entries | Where-Object { $_.FullName -replace '\\','/' -eq "workbook_build/node_modules/@oai/artifact-tool/package.json" } | Select-Object -First 1
    if ($privateEnv) {
      Add-Result "Deployment package secret exclusion" "FAIL" "private env found in $($latest.FullName)"
    } elseif (-not $syncScript -or -not $backupScript -or -not $deployScript -or -not $packageTestScript -or -not $vpsScriptsTest -or -not $vpsAcceptanceScript -or -not $vpsTimerScript -or -not $releaseActivationScript -or -not $bitableBootstrapScript -or -not $agentProductScript -or -not $agentPersistenceScript -or -not $agentSupportInstaller -or -not $agentSupportCompose -or -not $agentPackage -or -not $agentApp -or -not $statusScript -or -not $restoreScript -or -not $queueManagerScript -or -not $crmPreservationScript -or -not $launchInputsScript -or -not $acceptanceScript -or -not $outboundScript -or -not $opsScript -or -not $commercialAuditScript -or -not $approvalScript -or -not $emailAuthScript -or -not $buildMessagesScript -or -not $dispatchScript -or -not $switchScript -or -not $acceptanceDoc -or -not $launchInputsDoc -or -not $artifactTool) {
      Add-Result "Deployment package contents" "FAIL" "missing Agent service, release activation/persistence, sync, backup, VPS deploy/test/acceptance/timer scripts, package smoke, status report, restore, queue manager, CRM state preservation, launch input validator, acceptance, outbound readiness, ops health, commercial audit, approval queue, email auth smoke, message builder, dispatch, switch script, acceptance doc, launch inputs doc, or packaged workbook dependency in $($latest.FullName)"
    } else {
      Add-Result "Deployment package verification" "PASS" "package=$($latest.FullName); private_env=none; agent_service=yes; release_activation=yes; persistence_test=yes; support_services=yes; sync_script=yes; backup_script=yes; vps_deploy=yes; vps_acceptance=yes; vps_timer=yes; package_smoke=yes; status_script=yes; restore_script=yes; queue_manager=yes; crm_state_preservation=yes; launch_input_validator=yes; acceptance_script=yes; outbound_script=yes; ops_script=yes; commercial_audit=yes; approval_script=yes; email_auth=yes; message_builder=yes; dispatch_script=yes; switch_script=yes; acceptance_doc=yes; launch_inputs_doc=yes; workbook_dependency=yes"
    }
  } finally {
    $zip.Dispose()
  }
} catch {
  Add-Result "Deployment package verification" "FAIL" $_.Exception.Message
}

Invoke-CheckedCommand `
  -Name "Deployment package offline smoke" `
  -Command "& '$Workspace\scripts\test-deployment-package.ps1'"

try {
  $envMap = Get-EnvMap (Join-Path $Workspace ".env")
  $briefText = Get-Content -LiteralPath (Join-Path $Workspace "product_data\input_brief.yaml") -Raw -Encoding UTF8
  $unsafe = @()
  if ($envMap.EXTERNAL_SEND_REQUIRES_CONFIRMATION -ne "true") { $unsafe += "EXTERNAL_SEND_REQUIRES_CONFIRMATION" }
  if ($envMap.REQUIRE_HUMAN_APPROVAL_BEFORE_SEND -ne "true") { $unsafe += "REQUIRE_HUMAN_APPROVAL_BEFORE_SEND" }
  if ($briefText -match '(?m)^\s*send_email:\s*true\s*$') { $unsafe += "brief.send_email" }
  if ($briefText -match '(?m)^\s*write_to_feishu:\s*true\s*$') { $unsafe += "brief.write_to_feishu" }
  if ($unsafe.Count -eq 0) {
    Add-Result "External side-effect safety" "PASS" "send_email/write_to_feishu disabled; human approval flags enabled"
  } else {
    Add-Result "External side-effect safety" "FAIL" ("unsafe flags: " + ($unsafe -join ", "))
  }
} catch {
  Add-Result "External side-effect safety" "FAIL" $_.Exception.Message
}

# Write the current acceptance report before status/ops checks. Those scripts read
# the latest acceptance artifact, so this avoids self-referencing an older failure.
Write-AcceptanceReport

Invoke-CheckedCommand `
  -Name "Production operations health pre-status" `
  -Command "& '$Workspace\scripts\check-production-ops.ps1' -SkipProductionStatusCheck"

Invoke-CheckedCommand `
  -Name "Production status report" `
  -Command "& '$Workspace\scripts\export-production-status.ps1'"

Invoke-CheckedCommand `
  -Name "Production operations health" `
  -Command "& '$Workspace\scripts\check-production-ops.ps1'"

Invoke-CheckedCommand `
  -Name "Commercial completion audit" `
  -Command "& '$Workspace\scripts\audit-commercial-completion.ps1' -Workspace '$Workspace'"

Write-AcceptanceReport

Write-Host ""
Write-Host "== Acceptance summary =="
Write-Host "Failed: $failed"
Write-Host "Warnings: $warnings"
Write-Host "[OK] Report: $reportPath"

if ($failed -gt 0) {
  exit 1
}
exit 0
