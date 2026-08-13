param(
  [string]$Workspace = "",
  [string]$OutputDir = "",
  [int]$MaxArtifactAgeHours = 72,
  [switch]$RequireExternalProduction,
  [switch]$SkipHostScheduledTask
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $Workspace "outputs\commercial_completion"
}

$emailLaunchPolicyScript = Join-Path $PSScriptRoot "email-staged-launch-policy.ps1"
if (-not (Test-Path -LiteralPath $emailLaunchPolicyScript)) {
  throw "Email staged-launch policy script is missing."
}
. $emailLaunchPolicyScript

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$jsonPath = Join-Path $OutputDir "commercial-completion-$stamp.json"
$mdPath = Join-Path $OutputDir "commercial-completion-$stamp.md"
$requirements = New-Object System.Collections.Generic.List[object]

function Add-Requirement {
  param(
    [string]$Area,
    [string]$Requirement,
    [ValidateSet("VERIFIED", "PENDING_USER", "BLOCKED", "WARN")]
    [string]$Status,
    [string]$Detail,
    [string]$Evidence = ""
  )
  $safeDetail = $Detail -replace 'sk-[A-Za-z0-9_-]{12,}', 'sk-REDACTED'
  $safeDetail = $safeDetail -replace '(?i)(password|secret|token|api_key|access_token)\s*[:=]\s*[^,\s;]+', '$1=REDACTED'
  $requirements.Add([pscustomobject]@{
    area = $Area
    requirement = $Requirement
    status = $Status
    detail = $safeDetail
    evidence = $Evidence
  }) | Out-Null
  $tag = if ($Status -eq "VERIFIED") { "[OK]" } elseif ($Status -eq "PENDING_USER") { "[PENDING]" } elseif ($Status -eq "WARN") { "[WARN]" } else { "[BLOCKED]" }
  Write-Host "$tag $Area - $Requirement $safeDetail"
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

function Read-JsonFile {
  param([System.IO.FileInfo]$File)
  if (-not $File) { return $null }
  try {
    return Get-Content -LiteralPath $File.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $null
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

function Present {
  param([string]$Value)
  return -not [string]::IsNullOrWhiteSpace($Value)
}

function Missing-Keys {
  param(
    [hashtable]$Map,
    [string[]]$Keys
  )
  return @($Keys | Where-Object { -not (Present $Map[$_]) })
}

function Acceptance-ResultStatus {
  param(
    [object]$Acceptance,
    [string]$Name
  )
  if (-not $Acceptance -or -not $Acceptance.results) { return "" }
  $hit = @($Acceptance.results | Where-Object { $_.name -eq $Name } | Select-Object -Last 1)
  if ($hit.Count -eq 0) { return "" }
  return [string]$hit[-1].status
}

function Test-Fresh {
  param([System.IO.FileInfo]$File)
  if (-not $File) { return $false }
  return (((Get-Date) - $File.LastWriteTime).TotalHours -le $MaxArtifactAgeHours)
}

function To-Int {
  param(
    [object]$Value,
    [int]$Default = -1
  )
  if ($null -eq $Value) { return $Default }
  if ($Value -is [array]) {
    if ($Value.Count -eq 0) { return $Default }
    $Value = $Value[0]
  }
  $parsed = 0
  if ([int]::TryParse([string]$Value, [ref]$parsed)) { return $parsed }
  return $Default
}

function Get-GradeSummaryText {
  param([object[]]$Rows)
  if ($Rows.Count -eq 0) { return "" }
  return (($Rows | Group-Object grade | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ", ")
}

Write-Host "== Commercial completion audit =="
Write-Host "Workspace: $Workspace"
Write-Host "Require external production: $RequireExternalProduction"

$envPath = Join-Path $Workspace ".env"
$envMap = Get-EnvMap $envPath
$dataDir = Join-Path $Workspace "product_data"
$briefPath = Join-Path $dataDir "input_brief.yaml"

$latestAcceptanceFile = Get-LatestFile (Join-Path $Workspace "outputs\acceptance") "production-acceptance-*.json"
$latestOpsFile = Get-LatestFile (Join-Path $Workspace "outputs\ops_health") "ops-health-*.json"
$latestPackageSmokeFile = Get-LatestFile (Join-Path $Workspace "outputs\package_smoke") "package-smoke-*.json"
$latestStatusFile = Get-LatestFile (Join-Path $Workspace "outputs\production_status") "production-status-*.json"
$latestReadinessFile = Get-LatestFile (Join-Path $Workspace "outputs\production_readiness") "readiness-*.json"
$latestBackupFile = Get-LatestFile (Join-Path $Workspace "outputs\backups") "production-state-backup-*.zip"
$latestPackageFile = Get-LatestFile (Join-Path $Workspace "dist") "export-ai-agent-deployment-*.zip"
$latestVpsAcceptanceFile = Get-LatestFile (Join-Path $Workspace "outputs\vps_acceptance") "vps-acceptance-*.json"
$latestAgentProductFile = Get-LatestFile (Join-Path $Workspace "outputs\agent_product_acceptance") "agent-product-acceptance-*.json"

$latestAcceptance = Read-JsonFile $latestAcceptanceFile
$latestOps = Read-JsonFile $latestOpsFile
$latestPackageSmoke = Read-JsonFile $latestPackageSmokeFile
$latestStatus = Read-JsonFile $latestStatusFile
$latestReadiness = Read-JsonFile $latestReadinessFile
$latestVpsAcceptance = Read-JsonFile $latestVpsAcceptanceFile
$latestAgentProduct = Read-JsonFile $latestAgentProductFile

$latestAcceptanceFailed = To-Int $latestAcceptance.failed
if ($latestAcceptance -and $latestAcceptanceFailed -eq 0 -and (Test-Fresh $latestAcceptanceFile)) {
  Add-Requirement "Local core" "full production acceptance has zero failures" "VERIFIED" "failed=0; warnings=$($latestAcceptance.warnings)" $latestAcceptanceFile.FullName
} else {
  Add-Requirement "Local core" "full production acceptance has zero failures" "BLOCKED" "missing, stale, or failed latest acceptance" $(if ($latestAcceptanceFile) { $latestAcceptanceFile.FullName } else { "" })
}

$latestAgentProductFailed = To-Int $latestAgentProduct.failed
if ($latestAgentProduct -and $latestAgentProductFailed -eq 0 -and (Test-Fresh $latestAgentProductFile)) {
  Add-Requirement "Local core" "Agent product acceptance has zero failures" "VERIFIED" "failed=0; passed=$($latestAgentProduct.passed)" $latestAgentProductFile.FullName
} else {
  Add-Requirement "Local core" "Agent product acceptance has zero failures" "BLOCKED" "missing, stale, or failed Agent product acceptance" $(if ($latestAgentProductFile) { $latestAgentProductFile.FullName } else { "" })
}

$latestOpsBlocked = To-Int $latestOps.blocked
if ($latestOps -and $latestOpsBlocked -eq 0 -and (Test-Fresh $latestOpsFile)) {
  Add-Requirement "Local core" "production operations health is clean" "VERIFIED" "blocked=0; warnings=$($latestOps.warnings)" $latestOpsFile.FullName
} else {
  Add-Requirement "Local core" "production operations health is clean" "BLOCKED" "missing, stale, or blocked latest ops health" $(if ($latestOpsFile) { $latestOpsFile.FullName } else { "" })
}

if ($latestStatus -and $latestStatus.local_ready -eq $true -and $latestStatus.launch_state -ne "NOT_READY_CHECK_REPORTS" -and (Test-Fresh $latestStatusFile)) {
  Add-Requirement "Local core" "production status says local production is ready" "VERIFIED" "state=$($latestStatus.launch_state)" $latestStatusFile.FullName
} else {
  Add-Requirement "Local core" "production status says local production is ready" "BLOCKED" "missing, stale, or not locally ready" $(if ($latestStatusFile) { $latestStatusFile.FullName } else { "" })
}

$latestPackageSmokeBlocked = To-Int $latestPackageSmoke.blocked
if ($latestPackageSmoke -and $latestPackageSmokeBlocked -eq 0 -and (Test-Fresh $latestPackageSmokeFile)) {
  Add-Requirement "Deployment package" "offline package smoke test passes" "VERIFIED" "blocked=0; warnings=$($latestPackageSmoke.warnings)" $latestPackageSmokeFile.FullName
} else {
  Add-Requirement "Deployment package" "offline package smoke test passes" "BLOCKED" "missing, stale, or blocked package smoke" $(if ($latestPackageSmokeFile) { $latestPackageSmokeFile.FullName } else { "" })
}

if ($latestPackageFile) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($latestPackageFile.FullName)
    try {
      $privateEnv = @($zip.Entries | Where-Object { $_.FullName -eq ".env" -or ($_.FullName -like ".env.*" -and $_.FullName -ne ".env.example") }).Count
      $requiredEntries = @(
        "scripts/run-production-acceptance.ps1",
        "scripts/run-vps-production-acceptance.ps1",
        "scripts/run-agent-product-acceptance.ps1",
        "scripts/test-agent-service-persistence.ps1",
        "scripts/activate-vps-release.sh",
        "scripts/bootstrap-feishu-bitable.ps1",
        "scripts/install-agent-service-systemd.sh",
        "scripts/install-agent-support-services.sh",
        "infra/support-services.compose.yml",
        "agent_service/package.json",
        "agent_service/src/app.ts",
        "scripts/test-deployment-package.ps1",
        "scripts/audit-commercial-completion.ps1",
        "scripts/deploy-to-vps.ps1",
        "scripts/invoke-outbound-dispatch.ps1",
        "scripts/sync-feishu-crm.ps1",
        "workbook_build/node_modules/@oai/artifact-tool/package.json"
      )
      $missingEntries = @()
      foreach ($entry in $requiredEntries) {
        $hit = $zip.Entries | Where-Object { ($_.FullName -replace '\\','/') -eq $entry } | Select-Object -First 1
        if (-not $hit) { $missingEntries += $entry }
      }
      if ($privateEnv -eq 0 -and $missingEntries.Count -eq 0) {
        Add-Requirement "Deployment package" "latest package is self-contained and excludes private env" "VERIFIED" "private_env=0; required_entries=present" $latestPackageFile.FullName
      } else {
        Add-Requirement "Deployment package" "latest package is self-contained and excludes private env" "BLOCKED" "private_env=$privateEnv; missing=$($missingEntries -join ', ')" $latestPackageFile.FullName
      }
    } finally {
      $zip.Dispose()
    }
  } catch {
    Add-Requirement "Deployment package" "latest package is self-contained and excludes private env" "BLOCKED" $_.Exception.Message $latestPackageFile.FullName
  }
} else {
  Add-Requirement "Deployment package" "latest package is self-contained and excludes private env" "BLOCKED" "no deployment package found"
}

$crmPath = Join-Path $dataDir "crm_import.csv"
$crmRows = @()
if (Test-Path -LiteralPath $crmPath) {
  $crmRows = @(Import-Csv -LiteralPath $crmPath -Encoding UTF8)
}
$blankOwners = @($crmRows | Where-Object { [string]::IsNullOrWhiteSpace($_.owner) }).Count
$blankDrafts = @($crmRows | Where-Object { [string]::IsNullOrWhiteSpace($_.email_draft) -or [string]::IsNullOrWhiteSpace($_.whatsapp_opener) }).Count
$blankSources = @($crmRows | Where-Object { [string]::IsNullOrWhiteSpace($_.source_url) }).Count
if ($crmRows.Count -eq 16 -and $blankOwners -eq 0 -and $blankDrafts -eq 0 -and $blankSources -eq 0) {
  Add-Requirement "Business data" "real CRM rows, drafts, owner, and source URLs are complete" "VERIFIED" "rows=$($crmRows.Count); grades=$(Get-GradeSummaryText $crmRows); blank_owner=0; blank_drafts=0; blank_sources=0" $crmPath
} else {
  Add-Requirement "Business data" "real CRM rows, drafts, owner, and source URLs are complete" "BLOCKED" "rows=$($crmRows.Count); blank_owner=$blankOwners; blank_drafts=$blankDrafts; blank_sources=$blankSources" $crmPath
}

$manualPath = Join-Path $dataDir "manual_verification_queue.csv"
$manualRows = if (Test-Path -LiteralPath $manualPath) { @(Import-Csv -LiteralPath $manualPath -Encoding UTF8) } else { @() }
$unsafeManual = @($manualRows | Where-Object { $_."Send Status" -ne "DO_NOT_SEND_YET" }).Count
if ($manualRows.Count -gt 0 -and $unsafeManual -eq 0) {
  Add-Requirement "Outbound safety" "manual verification queue prevents unreviewed sends" "VERIFIED" "rows=$($manualRows.Count); unsafe_send_status=0" $manualPath
} else {
  Add-Requirement "Outbound safety" "manual verification queue prevents unreviewed sends" "BLOCKED" "rows=$($manualRows.Count); unsafe_send_status=$unsafeManual" $manualPath
}

$approvalPath = Join-Path $dataDir "outreach_approval_queue.csv"
$approvalRows = if (Test-Path -LiteralPath $approvalPath) { @(Import-Csv -LiteralPath $approvalPath -Encoding UTF8) } else { @() }
$approvedBad = @($approvalRows | Where-Object { $_.approval_status -eq "APPROVED" -and ([string]::IsNullOrWhiteSpace($_.approved_by) -or [string]::IsNullOrWhiteSpace($_.approved_at) -or [string]::IsNullOrWhiteSpace($_.destination)) }).Count
$sentWithoutSentAt = @($approvalRows | Where-Object { $_.approval_status -eq "SENT" -and [string]::IsNullOrWhiteSpace($_.sent_at) }).Count
if ($approvalRows.Count -gt 0 -and $approvedBad -eq 0 -and $sentWithoutSentAt -eq 0) {
  Add-Requirement "Outbound safety" "approval queue is safe for controlled dispatch" "VERIFIED" "rows=$($approvalRows.Count); bad_approved=0; sent_without_sent_at=0" $approvalPath
} else {
  Add-Requirement "Outbound safety" "approval queue is safe for controlled dispatch" "BLOCKED" "rows=$($approvalRows.Count); bad_approved=$approvedBad; sent_without_sent_at=$sentWithoutSentAt" $approvalPath
}

foreach ($resultName in @(
  "Feishu CRM read-only sync plan",
  "Email SMTP IMAP auth smoke",
  "Outbound dispatch plan",
  "Outbound send safety refusal",
  "WhatsApp send safety refusal",
  "CRM state preservation",
  "VPS deployment scripts"
)) {
  $status = Acceptance-ResultStatus $latestAcceptance $resultName
  if ($status -eq "PASS") {
    Add-Requirement "Acceptance gates" "$resultName passed in latest acceptance" "VERIFIED" "status=PASS" $(if ($latestAcceptanceFile) { $latestAcceptanceFile.FullName } else { "" })
  } else {
    Add-Requirement "Acceptance gates" "$resultName passed in latest acceptance" "BLOCKED" "status=$status" $(if ($latestAcceptanceFile) { $latestAcceptanceFile.FullName } else { "" })
  }
}

if ($latestReadiness -and (Test-Fresh $latestReadinessFile)) {
  $readinessRows = @($latestReadiness)
  $readinessBlocked = if ($latestReadiness.PSObject.Properties.Name -contains "blocked") {
    To-Int $latestReadiness.blocked
  } else {
    @($readinessRows | Where-Object { $_.status -eq "BLOCKED" }).Count
  }
  $readinessWarnings = if ($latestReadiness.PSObject.Properties.Name -contains "warnings") {
    To-Int $latestReadiness.warnings 0
  } else {
    @($readinessRows | Where-Object { $_.status -eq "WARN" }).Count
  }
  if ($readinessBlocked -eq 0) {
    Add-Requirement "Readiness" "production readiness check has no blockers" "VERIFIED" "blocked=0; warnings=$readinessWarnings" $latestReadinessFile.FullName
  } else {
    Add-Requirement "Readiness" "production readiness check has no blockers" "BLOCKED" "blocked=$readinessBlocked; warnings=$readinessWarnings" $latestReadinessFile.FullName
  }
} else {
  Add-Requirement "Readiness" "production readiness check has no blockers" "BLOCKED" "missing or stale readiness report" $(if ($latestReadinessFile) { $latestReadinessFile.FullName } else { "" })
}

$briefText = if (Test-Path -LiteralPath $briefPath) { Get-Content -LiteralPath $briefPath -Raw -Encoding UTF8 } else { "" }
$safetyProblems = @()
if ($envMap.EXTERNAL_SEND_REQUIRES_CONFIRMATION -ne "true") { $safetyProblems += "EXTERNAL_SEND_REQUIRES_CONFIRMATION" }
if ($envMap.REQUIRE_HUMAN_APPROVAL_BEFORE_SEND -ne "true") { $safetyProblems += "REQUIRE_HUMAN_APPROVAL_BEFORE_SEND" }
if ($envMap.OUTREACH_APPROVAL_REQUIRED -ne "true") { $safetyProblems += "OUTREACH_APPROVAL_REQUIRED" }
if ($briefText -match '(?m)^\s*send_email:\s*true\s*$') { $safetyProblems += "brief.send_email" }
if ($briefText -match '(?m)^\s*write_to_feishu:\s*true\s*$') { $safetyProblems += "brief.write_to_feishu" }
if ($safetyProblems.Count -eq 0) {
  Add-Requirement "Outbound safety" "external side effects remain guarded by default" "VERIFIED" "all safety switches and brief flags are safe" $briefPath
} else {
  Add-Requirement "Outbound safety" "external side effects remain guarded by default" "BLOCKED" ("unsafe flags: " + ($safetyProblems -join ", ")) $briefPath
}

if ($latestBackupFile) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $backupZip = [System.IO.Compression.ZipFile]::OpenRead($latestBackupFile.FullName)
    try {
      $manifest = $backupZip.Entries | Where-Object { $_.FullName -eq "backup_manifest.json" } | Select-Object -First 1
      $privateEnv = @($backupZip.Entries | Where-Object { $_.FullName -eq ".env" -or ($_.FullName -like ".env.*" -and $_.FullName -ne ".env.example") }).Count
      $agentDbEntry = $backupZip.Entries | Where-Object { ($_.FullName -replace '\\','/') -eq "agent_service/data/agent.db" } | Select-Object -First 1
      if ($manifest -and $agentDbEntry -and $privateEnv -eq 0 -and (Test-Fresh $latestBackupFile)) {
        Add-Requirement "Operations" "production backup includes a consistent Agent database and excludes private env" "VERIFIED" "manifest=yes; agent_db=yes; private_env=0" $latestBackupFile.FullName
      } else {
        Add-Requirement "Operations" "production backup includes a consistent Agent database and excludes private env" "BLOCKED" "manifest=$([bool]$manifest); agent_db=$([bool]$agentDbEntry); private_env=$privateEnv; fresh=$(Test-Fresh $latestBackupFile)" $latestBackupFile.FullName
      }
    } finally {
      $backupZip.Dispose()
    }
  } catch {
    Add-Requirement "Operations" "production backup includes a consistent Agent database and excludes private env" "BLOCKED" $_.Exception.Message $latestBackupFile.FullName
  }
} else {
  Add-Requirement "Operations" "production backup includes a consistent Agent database and excludes private env" "BLOCKED" "no production backup found"
}

if ($SkipHostScheduledTask) {
  Add-Requirement "Operations" "daily local scheduled task is healthy" "WARN" "skipped by -SkipHostScheduledTask"
} elseif (Get-Command Get-ScheduledTaskInfo -ErrorAction SilentlyContinue) {
  try {
    $taskInfo = Get-ScheduledTaskInfo -TaskName "Export AI Agent - Daily Real Pipeline"
    if ($taskInfo.LastTaskResult -eq 0) {
      Add-Requirement "Operations" "daily local scheduled task is healthy" "VERIFIED" "last_result=0; next=$($taskInfo.NextRunTime)"
    } else {
      Add-Requirement "Operations" "daily local scheduled task is healthy" "BLOCKED" "last_result=$($taskInfo.LastTaskResult); next=$($taskInfo.NextRunTime)"
    }
  } catch {
    Add-Requirement "Operations" "daily local scheduled task is healthy" "BLOCKED" $_.Exception.Message
  }
} else {
  Add-Requirement "Operations" "daily local scheduled task is healthy" "WARN" "Get-ScheduledTaskInfo unavailable on this host"
}

$feishuAgentRequired = @("FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_BITABLE_APP_TOKEN", "FEISHU_BITABLE_LEADS_TABLE_ID", "FEISHU_BITABLE_EVENTS_TABLE_ID")
$feishuAgentMissing = Missing-Keys $envMap $feishuAgentRequired
if ($envMap.FEISHU_BOT_ENABLED -ne "true") { $feishuAgentMissing += "FEISHU_BOT_ENABLED=true" }
if (-not (Present $envMap.FEISHU_ALLOWED_USERS) -and -not (Present $envMap.FEISHU_PAIRING_CODE)) { $feishuAgentMissing += "FEISHU_ALLOWED_USERS or FEISHU_PAIRING_CODE" }
if (-not (Present $envMap.FEISHU_ALERT_OPEN_IDS) -and -not (Present $envMap.FEISHU_ALERT_CHAT_ID)) { $feishuAgentMissing += "FEISHU_ALERT_OPEN_IDS or FEISHU_ALERT_CHAT_ID" }
if ($feishuAgentMissing.Count -eq 0) {
  Add-Requirement "External production" "Feishu bot, Bitable CRM, authorization, and inquiry alerts are configured" "VERIFIED" "required control-plane fields present"
} else {
  Add-Requirement "External production" "Feishu bot, Bitable CRM, authorization, and inquiry alerts are configured" "PENDING_USER" ("missing or disabled: " + ($feishuAgentMissing -join ", "))
}

if ((Present $envMap.SERPER_API_KEY) -or (Present $envMap.EXA_API_KEY) -or (Present $envMap.SEARXNG_BASE_URL)) {
  Add-Requirement "External production" "a production lead discovery provider is configured" "VERIFIED" "Serper, Exa, or SearXNG present"
} else {
  Add-Requirement "External production" "a production lead discovery provider is configured" "PENDING_USER" "provide SERPER_API_KEY, EXA_API_KEY, or SEARXNG_BASE_URL"
}
if (Present $envMap.REACHER_BASE_URL) {
  Add-Requirement "External production" "deep mailbox verification is configured" "VERIFIED" "REACHER_BASE_URL present"
} else {
  Add-Requirement "External production" "deep mailbox verification is configured" "PENDING_USER" "provide a working REACHER_BASE_URL"
}

$emailLaunchPolicy = Get-EnterpriseEmailLaunchPolicy -Map $envMap
$emailPolicyDetail = Format-EnterpriseEmailLaunchPolicy -Policy $emailLaunchPolicy
if ($emailLaunchPolicy.configured) {
  Add-Requirement "External production" "production email outreach and reply monitoring are configured" "VERIFIED" $emailPolicyDetail
} else {
  Add-Requirement "External production" "production email outreach and reply monitoring are configured" "PENDING_USER" $emailPolicyDetail
}

$whatsAppRequired = @("WHATSAPP_GRAPH_API_VERSION", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_WEBHOOK_VERIFY_TOKEN", "WHATSAPP_TEMPLATE_NAME", "WHATSAPP_TEMPLATE_LANGUAGE", "WHATSAPP_DAILY_LIMIT")
$whatsAppMissing = Missing-Keys $envMap $whatsAppRequired
if ($envMap.WHATSAPP_OUTREACH_ENABLED -eq "true" -and $envMap.WHATSAPP_BUSINESS_API_ENABLED -eq "true" -and $whatsAppMissing.Count -eq 0) {
  Add-Requirement "External production" "WhatsApp Business API template channel is configured" "VERIFIED" "required WhatsApp fields present; send still requires per-batch approval"
} else {
  $missingWhatsApp = @($whatsAppMissing)
  if ($envMap.WHATSAPP_OUTREACH_ENABLED -ne "true") { $missingWhatsApp += "WHATSAPP_OUTREACH_ENABLED=true" }
  if ($envMap.WHATSAPP_BUSINESS_API_ENABLED -ne "true") { $missingWhatsApp += "WHATSAPP_BUSINESS_API_ENABLED=true" }
  Add-Requirement "Optional channel" "WhatsApp Business API template channel is configured" "WARN" ("optional warm-lead channel not configured: " + ($missingWhatsApp -join ", "))
}

$vpsRequired = @("VPS_IP", "VPS_SSH_USER", "VPS_UBUNTU_VERSION", "VPS_REGION")
$vpsMissing = Missing-Keys $envMap $vpsRequired
if (-not (Present $envMap.VPS_SSH_KEY_PATH) -and -not (Present $envMap.VPS_SSH_PASSWORD)) { $vpsMissing += "VPS_SSH_KEY_PATH or VPS_SSH_PASSWORD" }
$latestVpsAcceptanceFailed = To-Int $latestVpsAcceptance.failed
if ($latestVpsAcceptance -and $latestVpsAcceptanceFailed -eq 0 -and (Test-Fresh $latestVpsAcceptanceFile)) {
  $vpsAgentTests = Acceptance-ResultStatus $latestVpsAcceptance "Agent product service tests"
  $vpsSystemd = Acceptance-ResultStatus $latestVpsAcceptance "Agent systemd service"
  $vpsPersistence = Acceptance-ResultStatus $latestVpsAcceptance "Agent restart persistence"
  if ($vpsAgentTests -eq "PASS" -and $vpsSystemd -eq "PASS" -and $vpsPersistence -eq "PASS") {
    Add-Requirement "External production" "VPS deployment acceptance has passed" "VERIFIED" "failed=0; agent_tests=PASS; systemd=PASS; persistence=PASS; warnings=$($latestVpsAcceptance.warnings)" $latestVpsAcceptanceFile.FullName
  } else {
    Add-Requirement "External production" "VPS deployment acceptance has passed" "BLOCKED" "missing required Agent checks: tests=$vpsAgentTests; systemd=$vpsSystemd; persistence=$vpsPersistence" $latestVpsAcceptanceFile.FullName
  }
} elseif ($vpsMissing.Count -eq 0) {
  Add-Requirement "External production" "VPS deployment acceptance has passed" "PENDING_USER" "VPS inputs present but deployment still requires explicit authorization"
} else {
  Add-Requirement "External production" "VPS deployment acceptance has passed" "PENDING_USER" ("missing: " + ($vpsMissing -join ", "))
}

$blocked = @($requirements | Where-Object { $_.status -eq "BLOCKED" }).Count
$pending = @($requirements | Where-Object { $_.status -eq "PENDING_USER" }).Count
$warnings = @($requirements | Where-Object { $_.status -eq "WARN" }).Count
$verified = @($requirements | Where-Object { $_.status -eq "VERIFIED" }).Count
$externalPending = @($requirements | Where-Object { $_.area -eq "External production" -and $_.status -eq "PENDING_USER" }).Count
$externalBlocked = @($requirements | Where-Object { $_.area -eq "External production" -and $_.status -eq "BLOCKED" }).Count
$localBlocked = @($requirements | Where-Object { $_.area -ne "External production" -and $_.status -eq "BLOCKED" }).Count

$completionState = if ($blocked -eq 0 -and $pending -eq 0) {
  "COMMERCIAL_PRODUCTION_COMPLETE"
} elseif ($localBlocked -eq 0 -and $externalBlocked -eq 0 -and $externalPending -gt 0) {
  "LOCAL_PRODUCTION_READY_EXTERNAL_USER_INPUT_PENDING"
} else {
  "NOT_READY_FIX_BLOCKERS"
}

$summary = [pscustomobject]@{
  generated_at = (Get-Date -Format s)
  workspace = $Workspace
  completion_state = $completionState
  require_external_production = [bool]$RequireExternalProduction
  verified = $verified
  pending_user = $pending
  blocked = $blocked
  warnings = $warnings
  evidence = [pscustomobject]@{
    acceptance = if ($latestAcceptanceFile) { $latestAcceptanceFile.FullName } else { "" }
    agent_product_acceptance = if ($latestAgentProductFile) { $latestAgentProductFile.FullName } else { "" }
    ops_health = if ($latestOpsFile) { $latestOpsFile.FullName } else { "" }
    production_status = if ($latestStatusFile) { $latestStatusFile.FullName } else { "" }
    production_readiness = if ($latestReadinessFile) { $latestReadinessFile.FullName } else { "" }
    package_smoke = if ($latestPackageSmokeFile) { $latestPackageSmokeFile.FullName } else { "" }
    deployment_package = if ($latestPackageFile) { $latestPackageFile.FullName } else { "" }
    production_backup = if ($latestBackupFile) { $latestBackupFile.FullName } else { "" }
    vps_acceptance = if ($latestVpsAcceptanceFile) { $latestVpsAcceptanceFile.FullName } else { "" }
  }
  requirements = $requirements
}
$summary | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

$md = New-Object System.Collections.Generic.List[string]
$md.Add("# Commercial Completion Audit") | Out-Null
$md.Add("") | Out-Null
$md.Add("- Generated at: $($summary.generated_at)") | Out-Null
$md.Add("- Completion state: $($summary.completion_state)") | Out-Null
$md.Add("- Verified: $verified") | Out-Null
$md.Add("- Pending user: $pending") | Out-Null
$md.Add("- Blocked: $blocked") | Out-Null
$md.Add("- Warnings: $warnings") | Out-Null
$md.Add("") | Out-Null
$md.Add("## Evidence") | Out-Null
$md.Add("") | Out-Null
foreach ($prop in $summary.evidence.PSObject.Properties) {
  if (-not [string]::IsNullOrWhiteSpace([string]$prop.Value)) {
    $md.Add("- $($prop.Name): $($prop.Value)") | Out-Null
  }
}
$md.Add("") | Out-Null
$md.Add("## Requirements") | Out-Null
$md.Add("") | Out-Null
$md.Add("| Area | Status | Requirement | Detail | Evidence |") | Out-Null
$md.Add("|---|---|---|---|---|") | Out-Null
foreach ($req in $requirements) {
  $detail = ([string]$req.detail).Replace("|", "/")
  $evidence = ([string]$req.evidence).Replace("|", "/")
  $md.Add("| $($req.area) | $($req.status) | $($req.requirement) | $detail | $evidence |") | Out-Null
}
$md | Set-Content -LiteralPath $mdPath -Encoding UTF8

Write-Host ""
Write-Host "Completion state: $completionState"
Write-Host "Verified: $verified"
Write-Host "Pending user: $pending"
Write-Host "Blocked: $blocked"
Write-Host "Warnings: $warnings"
Write-Host "[OK] Audit JSON: $jsonPath"
Write-Host "[OK] Audit Markdown: $mdPath"

if ($blocked -gt 0) { exit 1 }
if ($RequireExternalProduction -and $pending -gt 0) { exit 1 }
exit 0
