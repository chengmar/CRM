param(
  [string]$Workspace = "",
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $Workspace "outputs\production_status"
}

$emailLaunchPolicyScript = Join-Path $PSScriptRoot "email-staged-launch-policy.ps1"
if (-not (Test-Path -LiteralPath $emailLaunchPolicyScript)) {
  throw "Email staged-launch policy script is missing."
}
. $emailLaunchPolicyScript

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$jsonPath = Join-Path $OutputDir "production-status-$stamp.json"
$mdPath = Join-Path $OutputDir "production-status-$stamp.md"

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

function Present {
  param([string]$Value)
  return -not [string]::IsNullOrWhiteSpace($Value)
}

function Result-Status {
  param($Report, [string]$Name)
  if (-not $Report) { return "MISSING" }
  $result = @($Report.results | Where-Object { $_.name -eq $Name } | Select-Object -First 1)
  if ($result.Count -eq 0) { return "MISSING" }
  return [string]$result[0].status
}

$envMap = Get-EnvMap (Join-Path $Workspace ".env")
$dataDir = Join-Path $Workspace "product_data"

$latestAcceptanceFile = Get-LatestFile (Join-Path $Workspace "outputs\acceptance") "production-acceptance-*.json"
$latestOpsFile = Get-LatestFile (Join-Path $Workspace "outputs\ops_health") "ops-health-*.json"
$latestPackageSmokeFile = Get-LatestFile (Join-Path $Workspace "outputs\package_smoke") "package-smoke-*.json"
$latestPackageFile = Get-LatestFile (Join-Path $Workspace "dist") "export-ai-agent-deployment-*.zip"
$latestBackupFile = Get-LatestFile (Join-Path $Workspace "outputs\backups") "production-state-backup-*.zip"
$latestAgentProductFile = Get-LatestFile (Join-Path $Workspace "outputs\agent_product_acceptance") "agent-product-acceptance-*.json"
$latestVpsAcceptanceFile = Get-LatestFile (Join-Path $Workspace "outputs\vps_acceptance") "vps-acceptance-*.json"
$latestAcceptance = Read-JsonFile $latestAcceptanceFile
$latestOps = Read-JsonFile $latestOpsFile
$latestPackageSmoke = Read-JsonFile $latestPackageSmokeFile
$latestAgentProduct = Read-JsonFile $latestAgentProductFile
$latestVpsAcceptance = Read-JsonFile $latestVpsAcceptanceFile

$crmRows = @()
$gradeSummary = @()
$crmPath = Join-Path $dataDir "crm_import.csv"
if (Test-Path -LiteralPath $crmPath) {
  $crmRows = @(Import-Csv -LiteralPath $crmPath -Encoding UTF8)
  $gradeSummary = @($crmRows | Group-Object grade | Sort-Object Name | ForEach-Object {
    [pscustomobject]@{ grade = $_.Name; count = $_.Count }
  })
}

$approvalRows = @()
$approvalSummary = @()
$approvalPath = Join-Path $dataDir "outreach_approval_queue.csv"
if (Test-Path -LiteralPath $approvalPath) {
  $approvalRows = @(Import-Csv -LiteralPath $approvalPath -Encoding UTF8)
  $approvalSummary = @($approvalRows | Group-Object approval_status | Sort-Object Name | ForEach-Object {
    [pscustomobject]@{ status = $_.Name; count = $_.Count }
  })
}

$messageRows = @()
$messageSummary = @()
$messagePath = Join-Path $dataDir "outbound_messages.csv"
if (Test-Path -LiteralPath $messagePath) {
  $messageRows = @(Import-Csv -LiteralPath $messagePath -Encoding UTF8)
  $messageSummary = @($messageRows | Group-Object send_status | Sort-Object Name | ForEach-Object {
    [pscustomobject]@{ status = $_.Name; count = $_.Count }
  })
}

$feishuWritePassed = $envMap.FEISHU_CRM_WRITE_TEST_PASSED -eq "true"
$feishuSyncEnabled = $envMap.FEISHU_CRM_SYNC_ENABLED -eq "true"
$emailEnabled = $envMap.EMAIL_OUTREACH_ENABLED -eq "true"
$whatsappEnabled = $envMap.WHATSAPP_OUTREACH_ENABLED -eq "true"
$humanApprovalGuards = $envMap.EXTERNAL_SEND_REQUIRES_CONFIRMATION -eq "true" -and
  $envMap.REQUIRE_HUMAN_APPROVAL_BEFORE_SEND -eq "true" -and
  $envMap.OUTREACH_APPROVAL_REQUIRED -eq "true"

$feishuAgentRequired = @("FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_BITABLE_APP_TOKEN", "FEISHU_BITABLE_LEADS_TABLE_ID", "FEISHU_BITABLE_EVENTS_TABLE_ID")
$feishuAgentMissing = @($feishuAgentRequired | Where-Object { -not (Present $envMap[$_]) })
if ($envMap.FEISHU_BOT_ENABLED -ne "true") { $feishuAgentMissing += "FEISHU_BOT_ENABLED=true" }
if (-not (Present $envMap.FEISHU_ALLOWED_USERS) -and -not (Present $envMap.FEISHU_PAIRING_CODE)) { $feishuAgentMissing += "FEISHU_ALLOWED_USERS or FEISHU_PAIRING_CODE" }
$storedFeishuAlert = $false
$cliPath = Join-Path $Workspace "agent_service\dist\cli.js"
if (Test-Path -LiteralPath $cliPath) {
  $previousWarnings = $env:NODE_NO_WARNINGS
  try {
    $env:NODE_NO_WARNINGS = "1"
    $agentStatusJson = (& node $cliPath status 2>$null | Out-String)
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($agentStatusJson)) {
      $agentStatus = $agentStatusJson | ConvertFrom-Json
      $storedFeishuAlert = [bool]$agentStatus.config.feishuAlertDestinationConfigured
    }
  } catch {
    $storedFeishuAlert = $false
  } finally {
    $env:NODE_NO_WARNINGS = $previousWarnings
  }
}
if (-not (Present $envMap.FEISHU_ALERT_OPEN_IDS) -and -not (Present $envMap.FEISHU_ALERT_CHAT_ID) -and -not $storedFeishuAlert) { $feishuAgentMissing += "FEISHU_ALERT_OPEN_IDS or FEISHU_ALERT_CHAT_ID" }
$feishuAgentConfigured = $feishuAgentMissing.Count -eq 0

$searchConfigured = (Present $envMap.SERPER_API_KEY) -or (Present $envMap.EXA_API_KEY) -or (Present $envMap.SEARXNG_BASE_URL)
$reacherConfigured = Present $envMap.REACHER_BASE_URL

$emailLaunchPolicy = Get-EnterpriseEmailLaunchPolicy -Map $envMap
$emailProductionMissing = @($emailLaunchPolicy.blockers)
$emailProductionConfigured = [bool]$emailLaunchPolicy.configured
$whatsAppRequired = @("WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN")
$whatsAppMissing = @($whatsAppRequired | Where-Object { -not (Present $envMap[$_]) })

$acceptanceOk = $latestAcceptance -and [int]$latestAcceptance.failed -eq 0
$emailAuthSmokePassed = (Result-Status $latestAcceptance "Email SMTP IMAP auth smoke") -eq "PASS"
$opsOk = $latestOps -and [int]$latestOps.blocked -eq 0
$packageSmokeOk = $latestPackageSmoke -and [int]$latestPackageSmoke.blocked -eq 0
$agentProductOk = $latestAgentProduct -and [int]$latestAgentProduct.failed -eq 0
$vpsAcceptanceOk = $latestVpsAcceptance -and [int]$latestVpsAcceptance.failed -eq 0 -and
  (Result-Status $latestVpsAcceptance "Agent product service tests") -eq "PASS" -and
  (Result-Status $latestVpsAcceptance "Agent systemd service") -eq "PASS" -and
  (Result-Status $latestVpsAcceptance "Agent restart persistence") -eq "PASS"
$localReady = $acceptanceOk -and $opsOk -and $packageSmokeOk -and $agentProductOk -and $humanApprovalGuards
$externalProductionReady = $feishuAgentConfigured -and $searchConfigured -and $reacherConfigured -and $emailProductionConfigured -and $emailAuthSmokePassed -and $vpsAcceptanceOk

$requiredUserActions = New-Object System.Collections.Generic.List[string]
if (-not $feishuAgentConfigured) { $requiredUserActions.Add("Complete Feishu Agent control plane: " + ($feishuAgentMissing -join ", ")) | Out-Null }
if (-not $searchConfigured) { $requiredUserActions.Add("Configure one lead discovery provider: Serper, Exa, or SearXNG.") | Out-Null }
if (-not $reacherConfigured) { $requiredUserActions.Add("Configure a working Reacher-compatible deep mailbox verifier.") | Out-Null }
if (-not $emailProductionConfigured) { $requiredUserActions.Add("Complete production email setup: " + ($emailProductionMissing -join ", ")) | Out-Null }
if ($emailProductionConfigured -and -not $emailAuthSmokePassed) { $requiredUserActions.Add("Run production acceptance and pass the no-send SMTP/IMAP authentication smoke test.") | Out-Null }
if (-not $whatsappEnabled) {
  $requiredUserActions.Add("Optional: configure WhatsApp Business API for opted-in warm leads.") | Out-Null
} elseif ($whatsAppMissing.Count -gt 0) {
  $requiredUserActions.Add("Complete WhatsApp config: " + ($whatsAppMissing -join ", ")) | Out-Null
}
if (-not $vpsAcceptanceOk) { $requiredUserActions.Add("Redeploy to VPS and pass Agent tests, systemd health, and restart persistence acceptance.") | Out-Null }

$launchState = if ($localReady -and $externalProductionReady) {
  "READY_FOR_CONTROLLED_PRODUCTION"
} elseif ($localReady) {
  "LOCAL_PRODUCTION_READY_EXTERNAL_AUTH_PENDING"
} else {
  "NOT_READY_CHECK_REPORTS"
}

$status = [pscustomobject]@{
  generated_at = (Get-Date -Format s)
  workspace = $Workspace
  launch_state = $launchState
  local_ready = [bool]$localReady
  external_production_ready = [bool]$externalProductionReady
  evidence = [pscustomobject]@{
    acceptance = if ($latestAcceptanceFile) { $latestAcceptanceFile.FullName } else { "" }
    acceptance_failed = if ($latestAcceptance) { [int]$latestAcceptance.failed } else { $null }
    acceptance_warnings = if ($latestAcceptance) { [int]$latestAcceptance.warnings } else { $null }
    agent_product_acceptance = if ($latestAgentProductFile) { $latestAgentProductFile.FullName } else { "" }
    agent_product_failed = if ($latestAgentProduct) { [int]$latestAgentProduct.failed } else { $null }
    ops_health = if ($latestOpsFile) { $latestOpsFile.FullName } else { "" }
    ops_blocked = if ($latestOps) { [int]$latestOps.blocked } else { $null }
    ops_warnings = if ($latestOps) { [int]$latestOps.warnings } else { $null }
    package_smoke = if ($latestPackageSmokeFile) { $latestPackageSmokeFile.FullName } else { "" }
    package_smoke_blocked = if ($latestPackageSmoke) { [int]$latestPackageSmoke.blocked } else { $null }
    deployment_package = if ($latestPackageFile) { $latestPackageFile.FullName } else { "" }
    production_backup = if ($latestBackupFile) { $latestBackupFile.FullName } else { "" }
    vps_acceptance = if ($latestVpsAcceptanceFile) { $latestVpsAcceptanceFile.FullName } else { "" }
    vps_agent_checks_passed = [bool]$vpsAcceptanceOk
    email_auth_smoke_passed = [bool]$emailAuthSmokePassed
  }
  business_data = [pscustomobject]@{
    crm_rows = $crmRows.Count
    grade_summary = $gradeSummary
    approval_queue_rows = $approvalRows.Count
    approval_summary = $approvalSummary
    outbound_messages = $messageRows.Count
    outbound_message_summary = $messageSummary
  }
  switches = [pscustomobject]@{
    human_approval_guards = [bool]$humanApprovalGuards
    feishu_write_test_passed = [bool]$feishuWritePassed
    feishu_daily_sync_enabled = [bool]$feishuSyncEnabled
    feishu_agent_configured = [bool]$feishuAgentConfigured
    search_provider_configured = [bool]$searchConfigured
    deep_email_verification_configured = [bool]$reacherConfigured
    email_outreach_enabled = [bool]$emailEnabled
    email_production_configured = [bool]$emailProductionConfigured
    email_auth_smoke_passed = [bool]$emailAuthSmokePassed
    whatsapp_outreach_enabled = [bool]$whatsappEnabled
  }
  external_channels = [pscustomobject]@{
    feishu_agent_missing_config = $feishuAgentMissing
    email_missing_config = $emailProductionMissing
    email_launch_mode = $emailLaunchPolicy.launch_mode
    email_launch_stage = $emailLaunchPolicy.stage
    email_effective_daily_limit = $emailLaunchPolicy.effective_daily_limit
    email_effective_hourly_limit = $emailLaunchPolicy.effective_hourly_limit
    email_effective_minimum_interval_seconds = $emailLaunchPolicy.effective_minimum_interval_seconds
    email_send_receive_self_test_required = [bool]$emailLaunchPolicy.send_receive_self_test_required
    email_explicit_global_pause_release_required = [bool]$emailLaunchPolicy.explicit_global_pause_release_required
    whatsapp_missing_config = $whatsAppMissing
  }
  required_user_actions = $requiredUserActions
}

$status | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

$md = New-Object System.Collections.Generic.List[string]
$md.Add("# Production Status Report") | Out-Null
$md.Add("") | Out-Null
$md.Add("- Generated at: $($status.generated_at)") | Out-Null
$md.Add("- Launch state: $($status.launch_state)") | Out-Null
$md.Add("- Local production ready: $($status.local_ready)") | Out-Null
$md.Add("- External production ready: $($status.external_production_ready)") | Out-Null
$md.Add("") | Out-Null
$md.Add("## Evidence") | Out-Null
$md.Add("") | Out-Null
$md.Add("- Acceptance report: $($status.evidence.acceptance)") | Out-Null
$md.Add("- Agent product acceptance: $($status.evidence.agent_product_acceptance)") | Out-Null
$md.Add("- Operations health: $($status.evidence.ops_health)") | Out-Null
$md.Add("- Package smoke test: $($status.evidence.package_smoke)") | Out-Null
$md.Add("- Deployment package: $($status.evidence.deployment_package)") | Out-Null
$md.Add("- Production backup: $($status.evidence.production_backup)") | Out-Null
$md.Add("- VPS acceptance: $($status.evidence.vps_acceptance)") | Out-Null
$md.Add("- Email SMTP/IMAP auth smoke passed: $($status.evidence.email_auth_smoke_passed)") | Out-Null
$md.Add("") | Out-Null
$md.Add("## Business Data") | Out-Null
$md.Add("") | Out-Null
$md.Add("- CRM rows: $($status.business_data.crm_rows)") | Out-Null
$md.Add("- Approval queue rows: $($status.business_data.approval_queue_rows)") | Out-Null
$md.Add("- Outbound messages: $($status.business_data.outbound_messages)") | Out-Null
$md.Add("") | Out-Null
$md.Add("## Switches") | Out-Null
$md.Add("") | Out-Null
$md.Add("- Human approval guards: $($status.switches.human_approval_guards)") | Out-Null
$md.Add("- Feishu write test passed: $($status.switches.feishu_write_test_passed)") | Out-Null
$md.Add("- Feishu daily sync enabled: $($status.switches.feishu_daily_sync_enabled)") | Out-Null
$md.Add("- Feishu Agent configured: $($status.switches.feishu_agent_configured)") | Out-Null
$md.Add("- Search provider configured: $($status.switches.search_provider_configured)") | Out-Null
$md.Add("- Deep email verification configured: $($status.switches.deep_email_verification_configured)") | Out-Null
$md.Add("- Email outreach enabled: $($status.switches.email_outreach_enabled)") | Out-Null
$md.Add("- Email production configured: $($status.switches.email_production_configured)") | Out-Null
$md.Add("- Email auth smoke passed: $($status.switches.email_auth_smoke_passed)") | Out-Null
$md.Add("- Email launch mode: $($status.external_channels.email_launch_mode)") | Out-Null
$md.Add("- Email effective limits: $($status.external_channels.email_effective_daily_limit)/day, $($status.external_channels.email_effective_hourly_limit)/hour, minimum interval $($status.external_channels.email_effective_minimum_interval_seconds)s") | Out-Null
$md.Add("- WhatsApp outreach enabled: $($status.switches.whatsapp_outreach_enabled)") | Out-Null
$md.Add("") | Out-Null
$md.Add("## Required User Actions") | Out-Null
$md.Add("") | Out-Null
foreach ($action in $requiredUserActions) {
  $md.Add("- $action") | Out-Null
}
$md | Set-Content -LiteralPath $mdPath -Encoding UTF8

Write-Host "[OK] Production status JSON: $jsonPath"
Write-Host "[OK] Production status Markdown: $mdPath"
Write-Host "[OK] Launch state: $launchState"
if (-not $localReady) { exit 1 }
exit 0
