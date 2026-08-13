param(
  [string]$Workspace = "",
  [string]$EnvPath = "",
  [switch]$RequireFeishu,
  [switch]$RequireEmail,
  [switch]$RequireWhatsApp,
  [switch]$RequireVps
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
  $safe = $safe -replace '(?i)(password|secret|token|api_key|access_token)\s*[:=]\s*[^,\s;]+', '$1=REDACTED'
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

function Add-RequiredOrWarn {
  param(
    [string]$Area,
    [bool]$Required,
    [string[]]$Missing,
    [string]$OkDetail
  )
  if ($Missing.Count -eq 0) {
    Add-Check $Area "OK" $OkDetail
  } elseif ($Required) {
    Add-Check $Area "BLOCKED" ("missing " + ($Missing -join ", "))
  } else {
    Add-Check $Area "WARN" ("not configured yet; missing " + ($Missing -join ", "))
  }
}

Write-Host "== Commercial launch input validation =="
Write-Host "Workspace: $Workspace"
Write-Host "Env: $EnvPath"

$envMap = Get-EnvMap $EnvPath
if ($envMap.Count -eq 0) {
  Add-Check "Private .env" "BLOCKED" "missing .env; copy .env.example to .env and fill private values"
} else {
  Add-Check "Private .env" "OK" "present; secrets redacted from reports"
}

$safetyMissing = @()
if ($envMap.EXTERNAL_SEND_REQUIRES_CONFIRMATION -ne "true") { $safetyMissing += "EXTERNAL_SEND_REQUIRES_CONFIRMATION=true" }
if ($envMap.REQUIRE_HUMAN_APPROVAL_BEFORE_SEND -ne "true") { $safetyMissing += "REQUIRE_HUMAN_APPROVAL_BEFORE_SEND=true" }
if ($envMap.OUTREACH_APPROVAL_REQUIRED -ne "true") { $safetyMissing += "OUTREACH_APPROVAL_REQUIRED=true" }
if ($safetyMissing.Count -eq 0) {
  Add-Check "External action guards" "OK" "human approval and confirmation guards enabled"
} else {
  Add-Check "External action guards" "BLOCKED" ("missing " + ($safetyMissing -join ", "))
}

$feishuRequired = @(
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_BITABLE_APP_TOKEN",
  "FEISHU_BITABLE_LEADS_TABLE_ID",
  "FEISHU_BITABLE_EVENTS_TABLE_ID"
)
$feishuMissing = Missing-Keys $envMap $feishuRequired
if ($envMap.FEISHU_BOT_ENABLED -ne "true") { $feishuMissing += "FEISHU_BOT_ENABLED=true" }
if ([string]::IsNullOrWhiteSpace($envMap.FEISHU_ALLOWED_USERS) -and [string]::IsNullOrWhiteSpace($envMap.FEISHU_PAIRING_CODE)) {
  $feishuMissing += "FEISHU_ALLOWED_USERS or FEISHU_PAIRING_CODE"
}
if (
  [string]::IsNullOrWhiteSpace($envMap.FEISHU_ALERT_OPEN_IDS) -and
  [string]::IsNullOrWhiteSpace($envMap.FEISHU_ALERT_CHAT_ID) -and
  -not (Test-StoredFeishuAlertDestination)
) {
  $feishuMissing += "FEISHU_ALERT_OPEN_IDS or FEISHU_ALERT_CHAT_ID"
}
Add-RequiredOrWarn -Area "Feishu Agent control plane" -Required ([bool]$RequireFeishu) -Missing $feishuMissing -OkDetail "bot, Bitable, command authorization, and inquiry alert destination are present"

$emailLaunchPolicy = Get-EnterpriseEmailLaunchPolicy -Map $envMap -RequireOutreachEnabled ([bool]$RequireEmail)
$emailPolicyDetail = Format-EnterpriseEmailLaunchPolicy -Policy $emailLaunchPolicy
if ($emailLaunchPolicy.configured) {
  if ($emailLaunchPolicy.launch_mode -eq "staged_controlled_ramp") {
    Add-Check "Email outreach inputs" "WARN" ("ready for controlled staged deployment and operation; " + $emailPolicyDetail)
  } else {
    Add-Check "Email outreach inputs" "OK" ("ready at configured limits; " + $emailPolicyDetail)
  }
} elseif ($RequireEmail) {
  Add-Check "Email outreach inputs" "BLOCKED" $emailPolicyDetail
} else {
  Add-Check "Email outreach inputs" "WARN" ("not configured yet; " + $emailPolicyDetail)
}

if (
  -not [string]::IsNullOrWhiteSpace($envMap.SERPER_API_KEY) -or
  -not [string]::IsNullOrWhiteSpace($envMap.EXA_API_KEY) -or
  -not [string]::IsNullOrWhiteSpace($envMap.SEARXNG_BASE_URL)
) {
  Add-Check "Lead discovery provider" "OK" "Serper, Exa, or SearXNG is configured"
} else {
  Add-Check "Lead discovery provider" "WARN" "configure SERPER_API_KEY, EXA_API_KEY, or SEARXNG_BASE_URL"
}
if (-not [string]::IsNullOrWhiteSpace($envMap.REACHER_BASE_URL)) {
  Add-Check "Deep mailbox verification" "OK" "Reacher-compatible verification endpoint is configured"
} else {
  Add-Check "Deep mailbox verification" "WARN" "configure REACHER_BASE_URL before production discovery"
}

$whatsAppRequired = @(
  "WHATSAPP_GRAPH_API_VERSION",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
  "WHATSAPP_TEMPLATE_NAME",
  "WHATSAPP_TEMPLATE_LANGUAGE",
  "WHATSAPP_DAILY_LIMIT"
)
$whatsAppMissing = Missing-Keys $envMap $whatsAppRequired
Add-RequiredOrWarn -Area "WhatsApp Business API inputs" -Required ([bool]$RequireWhatsApp) -Missing $whatsAppMissing -OkDetail "Business API template fields present"
if ($whatsAppMissing.Count -eq 0) {
  if ($envMap.WHATSAPP_BUSINESS_API_ENABLED -ne "true") {
    Add-Check "WhatsApp channel type" "BLOCKED" "WHATSAPP_BUSINESS_API_ENABLED must be true"
  } elseif ($envMap.WHATSAPP_SEND_REQUIRES_CONFIRMATION -ne "true") {
    Add-Check "WhatsApp send guard" "BLOCKED" "WHATSAPP_SEND_REQUIRES_CONFIRMATION must remain true"
  } elseif (-not (Test-PositiveInt $envMap.WHATSAPP_DAILY_LIMIT)) {
    Add-Check "WhatsApp limits" "BLOCKED" "WHATSAPP_DAILY_LIMIT must be a positive integer"
  } else {
    Add-Check "WhatsApp send guard" "OK" "Business API and confirmation guard ready"
  }
}

$vpsRequired = @("VPS_IP", "VPS_SSH_USER", "VPS_UBUNTU_VERSION", "VPS_REGION")
$vpsMissing = Missing-Keys $envMap $vpsRequired
if ([string]::IsNullOrWhiteSpace($envMap.VPS_SSH_KEY_PATH) -and [string]::IsNullOrWhiteSpace($envMap.VPS_SSH_PASSWORD)) {
  $vpsMissing += "VPS_SSH_KEY_PATH or VPS_SSH_PASSWORD"
}
Add-RequiredOrWarn -Area "VPS deployment inputs" -Required ([bool]$RequireVps) -Missing $vpsMissing -OkDetail "host, SSH user, auth method, Ubuntu version, and region present"

$reportDir = Join-Path $Workspace "outputs\launch_inputs"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$reportPath = Join-Path $reportDir ("launch-inputs-" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".json")
$summary = [pscustomobject]@{
  generated_at = (Get-Date -Format s)
  workspace = $Workspace
  require_feishu = [bool]$RequireFeishu
  require_email = [bool]$RequireEmail
  require_whatsapp = [bool]$RequireWhatsApp
  require_vps = [bool]$RequireVps
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
