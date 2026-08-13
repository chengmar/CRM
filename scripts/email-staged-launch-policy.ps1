function Get-EmailPolicyValue {
  param([hashtable]$Map, [string]$Name)
  $value = [string]$Map[$Name]
  return $value.Trim().Trim('"').Trim("'")
}

function Test-EmailPolicyPositiveInt {
  param([string]$Value, [ref]$Parsed)
  $number = 0
  $ok = [int]::TryParse($Value, [ref]$number) -and $number -gt 0
  $Parsed.Value = $number
  return $ok
}

function Get-EnterpriseEmailLaunchPolicy {
  param(
    [hashtable]$Map,
    [bool]$RequireOutreachEnabled = $true
  )

  $blockers = New-Object System.Collections.Generic.List[string]
  $required = @(
    "EMAIL_FROM_ADDRESS",
    "EMAIL_FROM_NAME",
    "COMPANY_POSTAL_ADDRESS",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "IMAP_HOST",
    "IMAP_USER",
    "IMAP_PASSWORD",
    "EMAIL_UNSUBSCRIBE_TEXT",
    "EMAIL_DAILY_LIMIT",
    "EMAIL_HOURLY_LIMIT",
    "EMAIL_MIN_INTERVAL_SECONDS"
  )
  foreach ($name in $required) {
    if ([string]::IsNullOrWhiteSpace((Get-EmailPolicyValue -Map $Map -Name $name))) {
      $blockers.Add($name) | Out-Null
    }
  }

  if ($RequireOutreachEnabled -and (Get-EmailPolicyValue -Map $Map -Name "EMAIL_OUTREACH_ENABLED").ToLowerInvariant() -ne "true") {
    $blockers.Add("EMAIL_OUTREACH_ENABLED=true") | Out-Null
  }
  if ((Get-EmailPolicyValue -Map $Map -Name "EMAIL_INBOUND_ENABLED").ToLowerInvariant() -ne "true") {
    $blockers.Add("EMAIL_INBOUND_ENABLED=true") | Out-Null
  }
  if ((Get-EmailPolicyValue -Map $Map -Name "EMAIL_SEND_REQUIRES_CONFIRMATION").ToLowerInvariant() -ne "true") {
    $blockers.Add("EMAIL_SEND_REQUIRES_CONFIRMATION=true") | Out-Null
  }
  if ((Get-EmailPolicyValue -Map $Map -Name "EMAIL_DOMAIN_AUTH_VERIFIED").ToLowerInvariant() -ne "true") {
    $blockers.Add("EMAIL_DOMAIN_AUTH_VERIFIED=true") | Out-Null
  }

  $sender = Get-EmailPolicyValue -Map $Map -Name "EMAIL_FROM_ADDRESS"
  if ($sender -match '(?i)@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|qq|163|126)\.com$') {
    $blockers.Add("enterprise-domain sender") | Out-Null
  }
  $unsubscribe = Get-EmailPolicyValue -Map $Map -Name "EMAIL_UNSUBSCRIBE_TEXT"
  if (-not [string]::IsNullOrWhiteSpace($unsubscribe) -and $unsubscribe.Length -lt 10) {
    $blockers.Add("EMAIL_UNSUBSCRIBE_TEXT length >= 10") | Out-Null
  }

  $daily = 0
  $hourly = 0
  $minimumInterval = 0
  $smtpPort = 0
  $imapPort = 993
  if (-not (Test-EmailPolicyPositiveInt -Value (Get-EmailPolicyValue -Map $Map -Name "EMAIL_DAILY_LIMIT") -Parsed ([ref]$daily))) {
    $blockers.Add("EMAIL_DAILY_LIMIT positive integer") | Out-Null
  }
  if (-not (Test-EmailPolicyPositiveInt -Value (Get-EmailPolicyValue -Map $Map -Name "EMAIL_HOURLY_LIMIT") -Parsed ([ref]$hourly))) {
    $blockers.Add("EMAIL_HOURLY_LIMIT positive integer") | Out-Null
  }
  if (-not (Test-EmailPolicyPositiveInt -Value (Get-EmailPolicyValue -Map $Map -Name "EMAIL_MIN_INTERVAL_SECONDS") -Parsed ([ref]$minimumInterval))) {
    $blockers.Add("EMAIL_MIN_INTERVAL_SECONDS positive integer") | Out-Null
  }
  if (-not (Test-EmailPolicyPositiveInt -Value (Get-EmailPolicyValue -Map $Map -Name "SMTP_PORT") -Parsed ([ref]$smtpPort)) -or $smtpPort -gt 65535) {
    $blockers.Add("SMTP_PORT valid TCP port") | Out-Null
  }
  $imapPortValue = Get-EmailPolicyValue -Map $Map -Name "IMAP_PORT"
  if (-not [string]::IsNullOrWhiteSpace($imapPortValue) -and
      (-not (Test-EmailPolicyPositiveInt -Value $imapPortValue -Parsed ([ref]$imapPort)) -or $imapPort -gt 65535)) {
    $blockers.Add("IMAP_PORT valid TCP port") | Out-Null
  }
  if ($daily -gt 0 -and $hourly -gt $daily) {
    $blockers.Add("EMAIL_HOURLY_LIMIT <= EMAIL_DAILY_LIMIT") | Out-Null
  }

  $warmupValue = (Get-EmailPolicyValue -Map $Map -Name "EMAIL_WARMUP_COMPLETE").ToLowerInvariant()
  if ($warmupValue -notin @("true", "false")) {
    $blockers.Add("EMAIL_WARMUP_COMPLETE=true or false") | Out-Null
  }
  $warmupComplete = $warmupValue -eq "true"
  $configured = $blockers.Count -eq 0
  $launchMode = if (-not $configured) {
    "blocked"
  } elseif ($warmupComplete) {
    "configured_limits"
  } else {
    "staged_controlled_ramp"
  }
  $stage = if (-not $configured) {
    "blocked"
  } elseif ($warmupComplete) {
    "configured"
  } else {
    "enterprise_initial_reputation_check"
  }
  $effectiveDaily = if (-not $configured) { 0 } elseif ($warmupComplete) { $daily } else { [Math]::Min($daily, 10) }
  $effectiveHourly = if (-not $configured) { 0 } elseif ($warmupComplete) { $hourly } else { [Math]::Min($hourly, 2) }
  $effectiveInterval = if (-not $configured) { 0 } elseif ($warmupComplete) { $minimumInterval } else { [Math]::Max($minimumInterval, 900) }

  return [pscustomobject]@{
    configured = $configured
    launch_mode = $launchMode
    policy_mode = if ($warmupComplete -and $configured) { "fixed" } elseif ($configured) { "adaptive" } else { "blocked" }
    stage = $stage
    warmup_complete = $warmupComplete
    configured_daily_limit = $daily
    configured_hourly_limit = $hourly
    configured_minimum_interval_seconds = $minimumInterval
    effective_daily_limit = $effectiveDaily
    effective_hourly_limit = $effectiveHourly
    effective_minimum_interval_seconds = $effectiveInterval
    blockers = @($blockers)
    smtp_imap_auth_smoke_required = $true
    send_receive_self_test_required = $true
    explicit_global_pause_release_required = $true
  }
}

function Format-EnterpriseEmailLaunchPolicy {
  param([object]$Policy)
  if (-not $Policy.configured) {
    return "blocked: " + (@($Policy.blockers) -join ", ")
  }
  $limits = "$($Policy.effective_daily_limit)/day, $($Policy.effective_hourly_limit)/hour, minimum interval $($Policy.effective_minimum_interval_seconds)s"
  if ($Policy.launch_mode -eq "staged_controlled_ramp") {
    return "controlled staged ramp ($limits); SMTP/IMAP auth smoke and send-receive self-test must pass before explicit global pause release"
  }
  return "configured limits ($limits); SMTP/IMAP auth smoke and send-receive self-test must pass before explicit global pause release"
}
