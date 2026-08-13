param(
  [string]$Workspace = "",
  [string]$EnvPath = ""
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($EnvPath)) {
  $EnvPath = Join-Path $Workspace ".env"
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
  $safe = $Detail -replace 'sk-[A-Za-z0-9_-]{12,}', 'sk-REDACTED'
  $safe = $safe -replace '(?i)(password|secret|token|api_key)\s*[:=]\s*[^,\s;]+', '$1=REDACTED'
  $results.Add([pscustomobject]@{ area = $Area; status = $Status; detail = $safe }) | Out-Null
  $tag = if ($Status -eq "OK") { "[OK]" } elseif ($Status -eq "WARN") { "[WARN]" } else { "[BLOCKED]" }
  Write-Host "$tag $Area $safe"
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

function Missing-Keys {
  param(
    [hashtable]$Map,
    [string[]]$Keys
  )
  return @($Keys | Where-Object { [string]::IsNullOrWhiteSpace($Map[$_]) })
}

function Test-PositiveInt {
  param([string]$Value)
  $parsed = 0
  return [int]::TryParse($Value, [ref]$parsed) -and $parsed -gt 0
}

function Test-StoredFeishuAlertDestination {
  $cliPath = Join-Path $Workspace "agent_service\dist\cli.js"
  if (-not (Test-Path -LiteralPath $cliPath)) { return $false }
  $previousWarnings = $env:NODE_NO_WARNINGS
  try {
    $env:NODE_NO_WARNINGS = "1"
    $json = (& node $cliPath status 2>$null | Out-String)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($json)) { return $false }
    $status = $json | ConvertFrom-Json
    return [bool]$status.config.feishuAlertDestinationConfigured
  } catch {
    return $false
  } finally {
    $env:NODE_NO_WARNINGS = $previousWarnings
  }
}

Write-Host "== Outbound readiness check =="
Write-Host "Workspace: $Workspace"

$envMap = Get-EnvMap $EnvPath
if ($envMap.Count -eq 0) {
  Add-Check "Private .env" "BLOCKED" "missing"
} else {
  $safetyMissing = @()
  if ($envMap.EXTERNAL_SEND_REQUIRES_CONFIRMATION -ne "true") { $safetyMissing += "EXTERNAL_SEND_REQUIRES_CONFIRMATION=true" }
  if ($envMap.REQUIRE_HUMAN_APPROVAL_BEFORE_SEND -ne "true") { $safetyMissing += "REQUIRE_HUMAN_APPROVAL_BEFORE_SEND=true" }
  if ($envMap.OUTREACH_APPROVAL_REQUIRED -ne "true") { $safetyMissing += "OUTREACH_APPROVAL_REQUIRED=true" }
  if ($safetyMissing.Count -eq 0) {
    Add-Check "Global external-send safety" "OK" "human approval required"
  } else {
    Add-Check "Global external-send safety" "BLOCKED" ("missing " + ($safetyMissing -join ", "))
  }

  if ($envMap.EMAIL_OUTREACH_ENABLED -eq "true" -or $envMap.WHATSAPP_OUTREACH_ENABLED -eq "true") {
    $alertMissing = Missing-Keys $envMap @("FEISHU_APP_ID", "FEISHU_APP_SECRET")
    if ($envMap.FEISHU_BOT_ENABLED -ne "true") { $alertMissing += "FEISHU_BOT_ENABLED=true" }
    if (
      [string]::IsNullOrWhiteSpace($envMap.FEISHU_ALERT_OPEN_IDS) -and
      [string]::IsNullOrWhiteSpace($envMap.FEISHU_ALERT_CHAT_ID) -and
      -not (Test-StoredFeishuAlertDestination)
    ) {
      $alertMissing += "FEISHU_ALERT_OPEN_IDS or FEISHU_ALERT_CHAT_ID"
    }
    if ($alertMissing.Count -eq 0) {
      Add-Check "Inquiry alert channel" "OK" "Feishu bot and at least one alert destination are configured"
    } else {
      Add-Check "Inquiry alert channel" "BLOCKED" ("missing " + ($alertMissing -join ", "))
    }
  }

  if ($envMap.EMAIL_OUTREACH_ENABLED -eq "true") {
    $isGmailSender = $envMap.EMAIL_FROM_ADDRESS -match '(?i)@(gmail|googlemail)\.com$'
    $isGmailPilot = $envMap.CONSUMER_EMAIL_PILOT_ENABLED -eq "true" -and $isGmailSender
    $requiredEmail = @(
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
      "EMAIL_MIN_INTERVAL_SECONDS",
      "LEAD_SEND_SCORE_MIN"
    )
    $missingEmail = Missing-Keys $envMap $requiredEmail
    if ($missingEmail.Count -gt 0) {
      Add-Check "Email outreach config" "BLOCKED" ("missing " + ($missingEmail -join ", "))
    } elseif ($envMap.EMAIL_INBOUND_ENABLED -ne "true") {
      Add-Check "Email reply monitoring" "BLOCKED" "EMAIL_INBOUND_ENABLED must be true before any production send"
    } elseif ($envMap.EMAIL_SEND_REQUIRES_CONFIRMATION -ne "true") {
      Add-Check "Email outreach config" "BLOCKED" "EMAIL_SEND_REQUIRES_CONFIRMATION must remain true"
    } elseif (-not (Test-PositiveInt $envMap.EMAIL_DAILY_LIMIT) -or -not (Test-PositiveInt $envMap.EMAIL_HOURLY_LIMIT)) {
      Add-Check "Email sending limits" "BLOCKED" "EMAIL_DAILY_LIMIT and EMAIL_HOURLY_LIMIT must be positive integers"
    } elseif ([int]$envMap.EMAIL_HOURLY_LIMIT -gt [int]$envMap.EMAIL_DAILY_LIMIT) {
      Add-Check "Email sending limits" "BLOCKED" "hourly limit cannot exceed daily limit"
    } elseif ($envMap.EMAIL_UNSUBSCRIBE_TEXT.Length -lt 10) {
      Add-Check "Email unsubscribe text" "BLOCKED" "unsubscribe text is too short"
    } elseif ($isGmailPilot -and $envMap.AUTO_FOLLOWUP_ENABLED -eq "true") {
      Add-Check "Gmail pilot follow-up" "BLOCKED" "AUTO_FOLLOWUP_ENABLED must remain false"
    } elseif ($isGmailPilot -and ([int]$envMap.EMAIL_DAILY_LIMIT -gt 100 -or [int]$envMap.EMAIL_HOURLY_LIMIT -gt 20)) {
      Add-Check "Gmail pilot limits" "BLOCKED" "Gmail pilot operator target cannot exceed 100 emails per day or an adaptive ceiling of 20 per hour"
    } elseif ($isGmailPilot -and (
      -not (Test-PositiveInt $envMap.EMAIL_MIN_INTERVAL_SECONDS) -or
      [int]$envMap.EMAIL_MIN_INTERVAL_SECONDS -lt 60
    )) {
      Add-Check "Gmail pilot spacing" "BLOCKED" "EMAIL_MIN_INTERVAL_SECONDS must be at least 60"
    } elseif ($isGmailPilot -and (
      -not (Test-PositiveInt $envMap.LEAD_SEND_SCORE_MIN) -or
      [int]$envMap.LEAD_SEND_SCORE_MIN -lt 90
    )) {
      Add-Check "Gmail pilot lead quality" "BLOCKED" "LEAD_SEND_SCORE_MIN must be at least 90"
    } elseif ($isGmailPilot) {
      Add-Check "Gmail pilot outreach config" "OK" "SMTP/IMAP ready; first email only; adaptive pacing toward the daily target; score 90+; full card approval required"
    } else {
      $emailLaunchPolicy = Get-EnterpriseEmailLaunchPolicy -Map $envMap
      $emailPolicyDetail = Format-EnterpriseEmailLaunchPolicy -Policy $emailLaunchPolicy
      if (-not $emailLaunchPolicy.configured) {
        Add-Check "Email outreach config" "BLOCKED" $emailPolicyDetail
      } elseif ($emailLaunchPolicy.launch_mode -eq "staged_controlled_ramp") {
        Add-Check "Email outreach config" "WARN" ("ready for controlled staged deployment and operation; " + $emailPolicyDetail)
      } else {
        Add-Check "Email outreach config" "OK" ("ready at configured limits; " + $emailPolicyDetail)
      }
    }
  } else {
    Add-Check "Email outreach config" "WARN" "EMAIL_OUTREACH_ENABLED is false; safe but email sending is not production-enabled"
  }

  if ($envMap.WHATSAPP_OUTREACH_ENABLED -eq "true") {
    $requiredWhatsApp = @(
      "WHATSAPP_BUSINESS_API_ENABLED",
      "WHATSAPP_GRAPH_API_VERSION",
      "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_APP_SECRET",
      "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
      "WHATSAPP_TEMPLATE_NAME",
      "WHATSAPP_TEMPLATE_LANGUAGE",
      "WHATSAPP_DAILY_LIMIT",
      "WHATSAPP_SEND_REQUIRES_CONFIRMATION"
    )
    $missingWhatsApp = Missing-Keys $envMap $requiredWhatsApp
    if ($missingWhatsApp.Count -gt 0) {
      Add-Check "WhatsApp outreach config" "BLOCKED" ("missing " + ($missingWhatsApp -join ", "))
    } elseif ($envMap.WHATSAPP_BUSINESS_API_ENABLED -ne "true") {
      Add-Check "WhatsApp outreach config" "BLOCKED" "WhatsApp automation must use Business API or another explicitly approved compliant channel"
    } elseif ($envMap.WHATSAPP_SEND_REQUIRES_CONFIRMATION -ne "true") {
      Add-Check "WhatsApp outreach config" "BLOCKED" "WHATSAPP_SEND_REQUIRES_CONFIRMATION must remain true for production launch"
    } elseif (-not (Test-PositiveInt $envMap.WHATSAPP_DAILY_LIMIT)) {
      Add-Check "WhatsApp sending limits" "BLOCKED" "WHATSAPP_DAILY_LIMIT must be a positive integer"
    } else {
      Add-Check "WhatsApp outreach config" "OK" "Business API template fields present; confirmation required"
    }
  } else {
    Add-Check "WhatsApp outreach config" "WARN" "WHATSAPP_OUTREACH_ENABLED is false; safe but WhatsApp sending is not production-enabled"
  }
}

$briefPath = Join-Path $Workspace "product_data\input_brief.yaml"
$outreachPath = Join-Path $Workspace "product_data\outreach_drafts.md"
if (Test-Path -LiteralPath $briefPath) {
  $brief = Get-Content -LiteralPath $briefPath -Raw -Encoding UTF8
  $caseFlagsOk = $brief -match '(?m)^\s*public_case_references_allowed:\s*false\s*$' -and
    $brief -match '(?m)^\s*external_outreach_must_not_cite_private_cases:\s*true\s*$'
  if ($caseFlagsOk) {
    Add-Check "Private case usage rule" "OK" "private overseas cases marked as not public"
  } else {
    Add-Check "Private case usage rule" "BLOCKED" "case privacy flags missing or unsafe in input_brief.yaml"
  }
} else {
  Add-Check "Private case usage rule" "BLOCKED" "input_brief.yaml missing"
}

if (Test-Path -LiteralPath $outreachPath) {
  $outreach = Get-Content -LiteralPath $outreachPath -Raw -Encoding UTF8
  $forbiddenPhrases = @(
    "Our recent overseas applications",
    "Public Case References",
    "case-backed",
    "share relevant overseas cases",
    "Indonesia label printing",
    "USA furniture case",
    "Mexico grinding"
  )
  $hits = @($forbiddenPhrases | Where-Object { $outreach -match [regex]::Escape($_) })
  if ($hits.Count -eq 0 -and $outreach -match "Do not cite overseas cases") {
    Add-Check "Outbound draft case safety" "OK" "no forbidden private-case marketing phrase found"
  } else {
    Add-Check "Outbound draft case safety" "BLOCKED" ("forbidden or missing case-safety wording: " + ($hits -join ", "))
  }
} else {
  Add-Check "Outbound draft case safety" "BLOCKED" "outreach_drafts.md missing"
}

$approvalScript = Join-Path $Workspace "scripts\validate-outbound-approval.ps1"
if (Test-Path -LiteralPath $approvalScript) {
  $approvalOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $approvalScript -Workspace $Workspace 2>&1
  $approvalExit = $LASTEXITCODE
  $approvalText = ($approvalOutput | ForEach-Object { [string]$_ }) -join " | "
  if ($approvalText.Length -gt 900) {
    $approvalText = $approvalText.Substring($approvalText.Length - 900)
  }
  if ($approvalExit -eq 0) {
    Add-Check "Outbound approval queue" "OK" $approvalText
  } else {
    Add-Check "Outbound approval queue" "BLOCKED" $approvalText
  }
} else {
  Add-Check "Outbound approval queue" "BLOCKED" "validate-outbound-approval.ps1 missing"
}

$reportDir = Join-Path $Workspace "outputs\outbound_readiness"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$reportPath = Join-Path $reportDir ("outbound-readiness-" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".json")
$results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Host ""
$blocked = @($results | Where-Object { $_.status -eq "BLOCKED" }).Count
$warn = @($results | Where-Object { $_.status -eq "WARN" }).Count
Write-Host "Blocked: $blocked"
Write-Host "Warnings: $warn"
Write-Host "[OK] Report written: $reportPath"

if ($blocked -gt 0) {
  exit 1
}
exit 0
