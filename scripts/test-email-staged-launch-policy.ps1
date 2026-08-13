param(
  [string]$Workspace = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $Workspace = (Resolve-Path -LiteralPath $Workspace).Path
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Assert-Equal {
  param([object]$Actual, [object]$Expected, [string]$Message)
  if ($Actual -ne $Expected) {
    throw "$Message (expected=$Expected actual=$Actual)"
  }
}

function Assert-Contains {
  param([object[]]$Values, [string]$Expected, [string]$Message)
  if ($Expected -notin @($Values)) {
    throw "$Message (missing=$Expected; actual=$(@($Values) -join ', '))"
  }
}

function Assert-TextContains {
  param([string]$Text, [string]$Expected, [string]$Message)
  if ($Text -notmatch [regex]::Escape($Expected)) {
    throw "$Message (missing=$Expected)"
  }
}

$policyScript = Join-Path $Workspace "scripts\email-staged-launch-policy.ps1"
if (-not (Test-Path -LiteralPath $policyScript)) {
  throw "Missing staged launch policy helper: $policyScript"
}
. $policyScript

$baseFixture = @{
  EMAIL_FROM_ADDRESS = "sales@fixture-enterprise.example"
  EMAIL_FROM_NAME = "Fixture Export Sales"
  COMPANY_POSTAL_ADDRESS = "10 Fixture Road, Example City"
  SMTP_HOST = "smtp.fixture-enterprise.example"
  SMTP_PORT = "465"
  SMTP_USER = "sales@fixture-enterprise.example"
  SMTP_PASSWORD = "fixture-smtp-password"
  IMAP_HOST = "imap.fixture-enterprise.example"
  IMAP_PORT = "993"
  IMAP_USER = "sales@fixture-enterprise.example"
  IMAP_PASSWORD = "fixture-imap-password"
  EMAIL_UNSUBSCRIBE_TEXT = "Reply unsubscribe to stop future messages."
  EMAIL_DAILY_LIMIT = "500"
  EMAIL_HOURLY_LIMIT = "50"
  EMAIL_MIN_INTERVAL_SECONDS = "60"
  EMAIL_OUTREACH_ENABLED = "true"
  EMAIL_INBOUND_ENABLED = "true"
  EMAIL_SEND_REQUIRES_CONFIRMATION = "true"
  EMAIL_DOMAIN_AUTH_VERIFIED = "true"
  EMAIL_WARMUP_COMPLETE = "false"
}

$stagedFixture = $baseFixture.Clone()
$stagedPolicy = Get-EnterpriseEmailLaunchPolicy -Map $stagedFixture
Assert-True $stagedPolicy.configured "Warmup=false must remain launchable when all hard gates pass."
Assert-Equal $stagedPolicy.launch_mode "staged_controlled_ramp" "Warmup=false must select the staged launch mode."
Assert-Equal $stagedPolicy.stage "enterprise_initial_reputation_check" "Warmup=false must select the initial enterprise reputation stage."
Assert-Equal $stagedPolicy.effective_daily_limit 10 "Staged launch must cap the daily limit at 10."
Assert-Equal $stagedPolicy.effective_hourly_limit 2 "Staged launch must cap the hourly limit at 2."
Assert-Equal $stagedPolicy.effective_minimum_interval_seconds 900 "Staged launch must enforce a 900 second interval."
Assert-Equal @($stagedPolicy.blockers).Count 0 "Warmup=false with complete hard gates must have no blockers."
Assert-True $stagedPolicy.smtp_imap_auth_smoke_required "SMTP/IMAP auth smoke must remain mandatory."
Assert-True $stagedPolicy.send_receive_self_test_required "Send-receive self-test must remain mandatory."
Assert-True $stagedPolicy.explicit_global_pause_release_required "Explicit global pause release must remain mandatory."

$configuredFixture = $baseFixture.Clone()
$configuredFixture.EMAIL_WARMUP_COMPLETE = "true"
$configuredPolicy = Get-EnterpriseEmailLaunchPolicy -Map $configuredFixture
Assert-True $configuredPolicy.configured "Warmup=true must be launchable when all hard gates pass."
Assert-Equal $configuredPolicy.launch_mode "configured_limits" "Warmup=true must select configured limits."
Assert-Equal $configuredPolicy.stage "configured" "Warmup=true must select the configured stage."
Assert-Equal $configuredPolicy.effective_daily_limit 500 "Warmup=true must retain the configured daily limit."
Assert-Equal $configuredPolicy.effective_hourly_limit 50 "Warmup=true must retain the configured hourly limit."
Assert-Equal $configuredPolicy.effective_minimum_interval_seconds 60 "Warmup=true must retain the configured interval."

$hardGateCases = @(
  @{ name = "domain authentication"; key = "EMAIL_DOMAIN_AUTH_VERIFIED"; value = "false"; blocker = "EMAIL_DOMAIN_AUTH_VERIFIED=true" },
  @{ name = "SMTP host"; key = "SMTP_HOST"; value = ""; blocker = "SMTP_HOST" },
  @{ name = "SMTP port"; key = "SMTP_PORT"; value = "70000"; blocker = "SMTP_PORT valid TCP port" },
  @{ name = "IMAP host"; key = "IMAP_HOST"; value = ""; blocker = "IMAP_HOST" },
  @{ name = "IMAP port"; key = "IMAP_PORT"; value = "0"; blocker = "IMAP_PORT valid TCP port" },
  @{ name = "enterprise sender domain"; key = "EMAIL_FROM_ADDRESS"; value = ("fixture.sender@" + "gmail.com"); blocker = "enterprise-domain sender" },
  @{ name = "daily limit"; key = "EMAIL_DAILY_LIMIT"; value = "0"; blocker = "EMAIL_DAILY_LIMIT positive integer" },
  @{ name = "hourly limit"; key = "EMAIL_HOURLY_LIMIT"; value = "invalid"; blocker = "EMAIL_HOURLY_LIMIT positive integer" },
  @{ name = "minimum interval"; key = "EMAIL_MIN_INTERVAL_SECONDS"; value = "-1"; blocker = "EMAIL_MIN_INTERVAL_SECONDS positive integer" },
  @{ name = "inbound processing"; key = "EMAIL_INBOUND_ENABLED"; value = "false"; blocker = "EMAIL_INBOUND_ENABLED=true" },
  @{ name = "send confirmation"; key = "EMAIL_SEND_REQUIRES_CONFIRMATION"; value = "false"; blocker = "EMAIL_SEND_REQUIRES_CONFIRMATION=true" },
  @{ name = "explicit warmup state"; key = "EMAIL_WARMUP_COMPLETE"; value = "unknown"; blocker = "EMAIL_WARMUP_COMPLETE=true or false" }
)
foreach ($case in $hardGateCases) {
  $fixture = $baseFixture.Clone()
  $fixture[$case.key] = $case.value
  $policy = Get-EnterpriseEmailLaunchPolicy -Map $fixture
  Assert-True (-not $policy.configured) "$($case.name) failure must block launch."
  Assert-Equal $policy.launch_mode "blocked" "$($case.name) failure must select blocked mode."
  Assert-Contains @($policy.blockers) $case.blocker "$($case.name) failure must report its hard blocker."
}
Write-Host "[OK] Staged and configured launch limits preserve all email hard gates"

$entryScripts = @(
  "scripts\check-outbound-readiness.ps1",
  "scripts\check-production-readiness.ps1",
  "scripts\audit-commercial-completion.ps1",
  "scripts\export-production-status.ps1",
  "scripts\validate-commercial-launch-inputs.ps1"
)
$directWarmupGate = '(?i)\$envMap(?:\.EMAIL_WARMUP_COMPLETE|\[["'']EMAIL_WARMUP_COMPLETE["'']\])\s*-(?:eq|ne)\s*["'']true["'']'
foreach ($rel in $entryScripts) {
  $path = Join-Path $Workspace $rel
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing email readiness entry script: $rel" }
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { throw "$rel parse failed: $($errors[0].Message)" }
  $text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
  Assert-TextContains $text "email-staged-launch-policy.ps1" "$rel must load the shared staged launch policy."
  Assert-TextContains $text "Get-EnterpriseEmailLaunchPolicy" "$rel must evaluate the shared staged launch policy."
  if ($text -match $directWarmupGate) {
    throw "$rel still treats EMAIL_WARMUP_COMPLETE=true as a direct absolute prerequisite."
  }
}
Write-Host "[OK] Email readiness entry scripts delegate warmup decisions to the shared staged policy"

$auditText = Get-Content -LiteralPath (Join-Path $Workspace "scripts\audit-commercial-completion.ps1") -Raw -Encoding UTF8
$acceptanceGateBlock = [regex]::Match(
  $auditText,
  '(?s)foreach \(\$resultName in @\((?<body>.*?)\)\) \{'
)
Assert-True $acceptanceGateBlock.Success "Commercial completion audit must define its acceptance gate list."
Assert-TextContains `
  $acceptanceGateBlock.Groups["body"].Value `
  'Email SMTP IMAP auth smoke' `
  "Commercial completion audit must require the SMTP/IMAP auth smoke gate."

$productionStatusText = Get-Content -LiteralPath (Join-Path $Workspace "scripts\export-production-status.ps1") -Raw -Encoding UTF8
Assert-TextContains `
  $productionStatusText `
  '$emailAuthSmokePassed = (Result-Status $latestAcceptance "Email SMTP IMAP auth smoke") -eq "PASS"' `
  "Production status must explicitly calculate SMTP/IMAP auth smoke PASS."
if ($productionStatusText -notmatch '(?m)^\$externalProductionReady\s*=.*\$emailAuthSmokePassed') {
  throw "Production external readiness must include SMTP/IMAP auth smoke PASS."
}
foreach ($required in @(
  'email_auth_smoke_passed = [bool]$emailAuthSmokePassed',
  'email_launch_mode = $emailLaunchPolicy.launch_mode',
  'email_effective_daily_limit = $emailLaunchPolicy.effective_daily_limit',
  'email_effective_hourly_limit = $emailLaunchPolicy.effective_hourly_limit',
  'email_effective_minimum_interval_seconds = $emailLaunchPolicy.effective_minimum_interval_seconds'
)) {
  Assert-TextContains $productionStatusText $required "Production status is missing staged email evidence."
}
Write-Host "[OK] Commercial status keeps SMTP/IMAP auth PASS and effective staged limits in its launch gate"

$deliverabilityPath = Join-Path $Workspace "agent_service\src\outreach\deliverability-policy.ts"
$deliverabilityText = Get-Content -LiteralPath $deliverabilityPath -Raw -Encoding UTF8
foreach ($required in @(
  'if (!gmailPilot && config.EMAIL_WARMUP_COMPLETE)',
  'dailyTarget: config.EMAIL_DAILY_LIMIT',
  'hourlyCeiling: config.EMAIL_HOURLY_LIMIT',
  'minimumIntervalSeconds: config.EMAIL_MIN_INTERVAL_SECONDS',
  'dailyTarget: Math.min(config.EMAIL_DAILY_LIMIT, 10)',
  'hourlyCeiling: Math.min(config.EMAIL_HOURLY_LIMIT, 2)',
  'minimumIntervalSeconds: Math.max(config.EMAIL_MIN_INTERVAL_SECONDS, 900)',
  'stage: "enterprise_initial_reputation_check"'
)) {
  Assert-TextContains $deliverabilityText $required "Runtime deliverability policy drifted from the staged launch contract."
}

$dispatcherPath = Join-Path $Workspace "agent_service\src\outreach\dispatcher.ts"
$dispatcherText = Get-Content -LiteralPath $dispatcherPath -Raw -Encoding UTF8
foreach ($required in @(
  'this.db.getSetting("outbound_paused") === "true"',
  'global outbound pause is active',
  '!this.config.REQUIRE_HUMAN_APPROVAL_BEFORE_SEND || !this.config.OUTREACH_APPROVAL_REQUIRED',
  'message sequence is not approved',
  'const emailChannel = ensureEmailChannelState(this.config, this.db)',
  'if (!emailChannel.configured)',
  'else if (!emailChannel.selfTestPassed)',
  'enterprise SMTP/IMAP send-receive self-test has not passed'
)) {
  Assert-TextContains $dispatcherText $required "Dispatcher hard-gate fingerprint is missing."
}
Write-Host "[OK] Runtime keeps 10/2/900 staging, auth self-test, approval, and global pause gates"

Write-Host "[OK] Email staged launch policy validated without reading a workspace .env or sending mail."
