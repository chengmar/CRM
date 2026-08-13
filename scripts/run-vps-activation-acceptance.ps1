param(
  [string]$Workspace = ""
)

$ErrorActionPreference = "Stop"
$ExpectedSchemaVersion = 19
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $Workspace = (Resolve-Path -LiteralPath $Workspace).Path
}

$results = New-Object System.Collections.Generic.List[object]
$reportDir = Join-Path $Workspace "outputs\vps_activation_acceptance"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$reportPath = Join-Path $reportDir ("vps-activation-acceptance-" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".json")

function Protect-Detail {
  param([AllowNull()][object]$Text)
  $safe = [string]$Text
  if ([string]::IsNullOrEmpty($safe)) { return "" }
  $safe = $safe -replace '(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}', '[EMAIL_REDACTED]'
  $safe = $safe -replace '(?i)(://)[^/\s:@]+:[^@/\s]+@', '${1}REDACTED@'
  $safe = $safe -replace '(?i)(["'']?Authorization["'']?\s*[:=]\s*)(?:"[^"\r\n]*"|''[^''\r\n]*''|(?:Bearer|Basic)\s+[^\s,;&}\]\r\n]+|[^\s,;&}\]\r\n]+)', '${1}REDACTED'
  $safe = $safe -replace '(?i)((?:--?|/)[A-Za-z0-9_.-]*(?:password|token|key|secret)[A-Za-z0-9_.-]*\s+)(?:"[^"\r\n]*"|''[^''\r\n]*''|[^\s,;&}\]\r\n]+)', '${1}REDACTED'
  $safe = $safe -replace '(?i)(["'']?[A-Za-z0-9_.-]*(?:password|token|key|secret)[A-Za-z0-9_.-]*["'']?\s*[:=]\s*)(?:"[^"\r\n]*"|''[^''\r\n]*''|[^\s,;&}\]\r\n]+)', '${1}REDACTED'
  $safe = $safe -replace '(?i)(\b(?:Bearer|Basic)\s+)[^\s,;&}\]\r\n]+', '${1}REDACTED'
  $safe = $safe -replace 'sk-[A-Za-z0-9_-]{12,}', 'sk-REDACTED'
  if ($safe.Length -gt 2000) { $safe = $safe.Substring($safe.Length - 2000) }
  return $safe
}

function Add-Result {
  param([string]$Name, [string]$Status, [string]$Detail)
  $safe = Protect-Detail $Detail
  $results.Add([pscustomobject]@{ name = $Name; status = $Status; detail = $safe }) | Out-Null
  Write-Host "[$Status] $Name $safe"
}

function Invoke-Check {
  param([string]$Name, [scriptblock]$Action)
  try {
    $detail = & $Action
    Add-Result $Name "PASS" (($detail | ForEach-Object { [string]$_ }) -join " | ")
  } catch {
    Add-Result $Name "FAIL" $_.Exception.Message
  }
}

function Invoke-ExternalCheck {
  param([string]$Name, [scriptblock]$Action)
  try {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $output = & $Action 2>&1
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) { throw (($output | Select-Object -Last 20) -join " | ") }
    Add-Result $Name "PASS" (($output | Select-Object -Last 8) -join " | ")
  } catch {
    Add-Result $Name "FAIL" $_.Exception.Message
  }
}

function Get-EnvValue {
  param([string]$Text, [string]$Name, [string]$Default = "")
  $match = [regex]::Match($Text, "(?m)^" + [regex]::Escape($Name) + "=(.*)$")
  if (-not $match.Success) { return $Default }
  return $match.Groups[1].Value.Trim().Trim('"').Trim("'")
}

function Wait-AgentEndpoint {
  param(
    [string]$Uri,
    [int]$TimeoutSeconds = 90
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = "endpoint did not respond"
  do {
    try {
      return Invoke-RestMethod -Uri $Uri -TimeoutSec 10
    } catch {
      $lastError = $_.Exception.Message
      Start-Sleep -Seconds 2
    }
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for $Uri after $TimeoutSeconds seconds: $lastError"
}

$envPath = Join-Path $Workspace ".env"
$envText = if (Test-Path -LiteralPath $envPath) { Get-Content -LiteralPath $envPath -Raw -Encoding UTF8 } else { "" }
$emailOutreachEnabled = (Get-EnvValue $envText "EMAIL_OUTREACH_ENABLED" "false").ToLowerInvariant() -eq "true"
$gmailPilot = (Get-EnvValue $envText "CONSUMER_EMAIL_PILOT_ENABLED" "false").ToLowerInvariant() -eq "true"
$enterpriseEmail = $emailOutreachEnabled -and -not $gmailPilot
$domainAuthVerified = (Get-EnvValue $envText "EMAIL_DOMAIN_AUTH_VERIFIED" "false").ToLowerInvariant() -eq "true"
$expectedOutboundCapability = if ($emailOutreachEnabled) { "true" } else { "false" }
$businessDataDir = Get-EnvValue $envText "BUSINESS_DATA_DIR" "customer_business_data"
if ([System.IO.Path]::IsPathRooted($businessDataDir) -or $businessDataDir -match '(^|[\\/])\.\.([\\/]|$)') {
  throw "BUSINESS_DATA_DIR must be a safe relative path."
}

Invoke-Check "Activation files" {
  $required = @(
    $envPath,
    (Join-Path $Workspace "agent_service\dist\app.js"),
    (Join-Path $Workspace "agent_service\dist\cli.js"),
    (Join-Path $Workspace "$businessDataDir\input_brief.yaml"),
    (Join-Path $Workspace "$businessDataDir\company_profile_template.md"),
    (Join-Path $Workspace "$businessDataDir\leads.csv")
  )
  $missing = @($required | Where-Object { -not (Test-Path -LiteralPath $_) })
  if ($missing.Count -gt 0) { throw "Missing: $($missing -join ', ')" }
  "business_data_dir=$businessDataDir"
}

Invoke-Check "Controlled outbound defaults" {
  foreach ($pair in @(
    @("OUTBOUND_ENABLED", $expectedOutboundCapability),
    @("EXTERNAL_SEND_REQUIRES_CONFIRMATION", "true"),
    @("REQUIRE_HUMAN_APPROVAL_BEFORE_SEND", "true"),
    @("OUTREACH_APPROVAL_REQUIRED", "true")
  )) {
    $actual = Get-EnvValue $envText $pair[0]
    if ($actual.ToLowerInvariant() -ne $pair[1]) { throw "$($pair[0]) must be $($pair[1])" }
  }
  if ($gmailPilot) {
    if ((Get-EnvValue $envText "AUTO_FOLLOWUP_ENABLED" "true").ToLowerInvariant() -ne "false") {
      throw "Gmail pilot must keep automatic follow-up disabled."
    }
    $dailyTarget = [int](Get-EnvValue $envText "EMAIL_DAILY_LIMIT" "0")
    $hourlyCeiling = [int](Get-EnvValue $envText "EMAIL_HOURLY_LIMIT" "0")
    $minimumInterval = [int](Get-EnvValue $envText "EMAIL_MIN_INTERVAL_SECONDS" "0")
    if ($dailyTarget -lt 1 -or $dailyTarget -gt 100) {
      throw "Gmail pilot daily target must be between 1 and 100."
    }
    if ($hourlyCeiling -lt 1 -or $hourlyCeiling -gt 20) {
      throw "Gmail pilot hourly ceiling must be between 1 and 20."
    }
    if ($minimumInterval -lt 60) {
      throw "Gmail pilot minimum adaptive interval must be at least 60 seconds."
    }
    "daily_target=$dailyTarget; adaptive_hourly_ceiling=$hourlyCeiling; adaptive_minimum_interval=$minimumInterval"
  }
  if ($enterpriseEmail) {
    foreach ($pair in @(
      @("EMAIL_INBOUND_ENABLED", "true"),
      @("EMAIL_SEND_REQUIRES_CONFIRMATION", "true")
    )) {
      $actual = Get-EnvValue $envText $pair[0]
      if ($actual.ToLowerInvariant() -ne $pair[1]) { throw "$($pair[0]) must be $($pair[1]) for enterprise email." }
    }
  }
  if ((Get-EnvValue $envText "SEARCH_PROVIDER" "").ToLowerInvariant() -ne "searxng") {
    throw "SEARCH_PROVIDER must be searxng for the strict production research runtime."
  }
  foreach ($name in @(
    "ACQ_SEARXNG_V2_ENABLED",
    "SEARXNG_LOCAL_ENDPOINT_ALLOWED",
    "ACQ_LOCAL_PUBLIC_WEB_ENABLED"
  )) {
    if ((Get-EnvValue $envText $name "false").ToLowerInvariant() -ne "true") {
      throw "$name must be true for the strict production research runtime."
    }
  }
  $searxngUri = [Uri](Get-EnvValue $envText "SEARXNG_BASE_URL" "")
  if ($searxngUri.Scheme -ne "http" -or
      $searxngUri.Host -notin @("127.0.0.1", "::1") -or
      $searxngUri.IsDefaultPort) {
    throw "SEARXNG_BASE_URL must be an explicit loopback HTTP endpoint with a non-default port."
  }
  "email_enabled=$emailOutreachEnabled; gmail_pilot=$gmailPilot; enterprise_email=$enterpriseEmail; domain_auth_verified=$domainAuthVerified; outbound_capability=$expectedOutboundCapability; runtime_pause_required=true; send_receive_self_test_required=$enterpriseEmail"
}

Invoke-Check "Hermes foreign-trade skills" {
  $requiredSkills = @(
    "b2b-search-keywords",
    "customer-discovery-pro",
    "export-customer-research",
    "competitor-intel-pro",
    "personalized-email",
    "feishu-sheets",
    "monthly-report"
  )
  $bundledRoot = Join-Path $Workspace "agents\skills"
  $installedRoot = Join-Path $HOME ".hermes\skills"
  $missing = @()
  foreach ($skill in $requiredSkills) {
    if (-not (Test-Path -LiteralPath (Join-Path $bundledRoot "$skill\SKILL.md"))) {
      $missing += "bundle:$skill"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $installedRoot "$skill\SKILL.md"))) {
      $missing += "installed:$skill"
    }
  }
  if ($missing.Count -gt 0) { throw "Missing Hermes skills: $($missing -join ', ')" }
  "skills=$($requiredSkills.Count)"
}

Invoke-ExternalCheck "Agent systemd service" {
  & systemctl is-active --quiet export-ai-agent-service.service
  if ($LASTEXITCODE -ne 0) { throw "Agent service is not active." }
  & systemctl is-enabled --quiet export-ai-agent-service.service
  if ($LASTEXITCODE -ne 0) { throw "Agent service is not enabled." }
  & systemctl is-enabled --quiet export-ai-agent-backup.timer
  if ($LASTEXITCODE -ne 0) { throw "Agent backup timer is not enabled." }
  & systemctl is-enabled --quiet export-ai-agent-daily.timer
  if ($LASTEXITCODE -eq 0) { throw "Daily acquisition timer must remain disabled during activation." }
  & systemctl is-active --quiet export-ai-agent-daily.timer
  if ($LASTEXITCODE -eq 0) { throw "Daily acquisition timer must remain inactive during activation." }
  & systemctl is-active --quiet export-ai-agent-backup.timer
  if ($LASTEXITCODE -ne 0) { throw "Agent backup timer is not active." }
}

Invoke-Check "Agent health" {
  $deadline = (Get-Date).AddSeconds(180)
  $health = $null
  $lastHealthError = "health endpoint did not respond"
  do {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:18790/health" -TimeoutSec 30
      if ($health.feishuConnected) { break }
      $lastHealthError = "Feishu is not connected yet"
    } catch {
      $lastHealthError = $_.Exception.Message
    }
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $deadline)
  if ($null -eq $health) { throw "Agent health did not stabilize within 180 seconds: $lastHealthError" }
  if (-not $health.ok) { throw "Health endpoint is not OK." }
  if ([int]$health.schemaVersion -ne $ExpectedSchemaVersion -or
      [int]$health.latestSchemaVersion -ne $ExpectedSchemaVersion) {
    throw "Expected database schema $ExpectedSchemaVersion, got current=$($health.schemaVersion) latest=$($health.latestSchemaVersion)."
  }
  if ($emailOutreachEnabled -and -not $health.outboundEnabled) { throw "Email outbound capability was not installed." }
  if (-not $emailOutreachEnabled -and $health.outboundEnabled) { throw "Outbound capability is unexpectedly enabled while email is disabled." }
  if (-not $health.outboundPaused) { throw "Global outbound pause must remain active." }
  if ($health.dailyResearchEnabled) { throw "Database daily research flag must remain disabled during activation." }
  if (-not $health.feishuConnected) { throw "Feishu did not connect within the activation window." }
  if ($gmailPilot) {
    if (-not $health.gmailPilot.mode) { throw "Health endpoint does not report Gmail pilot mode." }
  }
  if ($enterpriseEmail) {
    if ($health.gmailPilot.mode) { throw "Enterprise email must not report Gmail pilot mode." }
    if (-not $health.emailInboundEnabled) { throw "Enterprise inbound capability was not installed." }
  }
  "schema=$($health.schemaVersion); feishu_connected=$($health.feishuConnected); outbound_capability=$($health.outboundEnabled); gmail_self_test=$($health.gmailPilot.selfTestPassed); gmail_activated=$($health.gmailPilot.activated); outbound_paused=$($health.outboundPaused)"
}

Invoke-Check "Enterprise email send gates" {
  if (-not $enterpriseEmail) { return "enterprise_email=false; not_applicable=true" }
  $dispatcherPath = Join-Path $Workspace "agent_service\dist\outreach\dispatcher.js"
  $commandPath = Join-Path $Workspace "agent_service\dist\commands\service.js"
  foreach ($path in @($dispatcherPath, $commandPath)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Compiled enterprise email gate is missing: $path" }
  }
  $dispatcherText = Get-Content -LiteralPath $dispatcherPath -Raw -Encoding UTF8
  foreach ($required in @(
    "global outbound pause is active",
    "enterprise SMTP/IMAP send-receive self-test has not passed"
  )) {
    if ($dispatcherText -notmatch [regex]::Escape($required)) { throw "Compiled dispatcher is missing enterprise email gate: $required" }
  }
  $commandText = Get-Content -LiteralPath $commandPath -Raw -Encoding UTF8
  if ($commandText -notmatch [regex]::Escape('!ensureEmailChannelState(this.config, this.db).selfTestPassed')) {
    throw "Compiled operator command can release the global pause before the enterprise send-receive self-test."
  }
  "outbound_capability=true; global_pause=true; send_receive_self_test_gate=required; send_active=false"
}

Invoke-Check "Local production gates" {
  if ((Get-EnvValue $envText "SEARCH_PROVIDER" "").ToLowerInvariant() -ne "searxng" -or
      [string]::IsNullOrWhiteSpace((Get-EnvValue $envText "SEARXNG_BASE_URL" ""))) {
    throw "Strict search runtime is not configured."
  }
  if ($enterpriseEmail) {
    $missingEmailSettings = @(
      "SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD",
      "IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD",
      "EMAIL_FROM_ADDRESS", "EMAIL_UNSUBSCRIBE_TEXT", "COMPANY_POSTAL_ADDRESS"
    ) | Where-Object { [string]::IsNullOrWhiteSpace((Get-EnvValue $envText $_ "")) }
    if ($missingEmailSettings.Count -gt 0) {
      throw "Enterprise email configuration is incomplete."
    }
  }
  "search=true; email_channel_configured=$enterpriseEmail; domain_auth_verified=$domainAuthVerified; outbound_paused=$($health.outboundPaused); bitable_runtime_observed_by_sync_jobs=true"
}

Invoke-ExternalCheck "Agent database" {
  Push-Location (Join-Path $Workspace "agent_service")
  try { & node dist/cli.js verify-db } finally { Pop-Location }
}

if ($emailOutreachEnabled) {
  Invoke-ExternalCheck "SMTP and IMAP no-send authentication" {
    & (Join-Path $Workspace "scripts\test-email-auth.ps1") -Workspace $Workspace -EnvPath $envPath
  }
}

$failed = @($results | Where-Object { $_.status -eq "FAIL" }).Count
$report = [pscustomobject]@{
  generated_at = (Get-Date -Format s)
  workspace = Protect-Detail $Workspace
  phase = "PRE_PAIR_ACTIVATION"
  business_data_dir = Protect-Detail $businessDataDir
  failed = $failed
  passed = @($results | Where-Object { $_.status -eq "PASS" }).Count
  outbound_enabled = [bool]$emailOutreachEnabled
  outbound_paused = $true
  outbound_send_active = $false
  enterprise_email = [bool]$enterpriseEmail
  email_send_receive_self_test_required = [bool]$enterpriseEmail
  results = $results
}
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Host "[OK] Report: $(Protect-Detail $reportPath)"
if ($failed -gt 0) { exit 1 }
exit 0
