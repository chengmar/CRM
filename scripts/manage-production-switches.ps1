param(
  [string]$Workspace = "",
  [string]$EnvPath = "",
  [ValidateSet("Status", "EnableFeishuDailySync", "DisableFeishuDailySync", "DisableExternalActions")]
  [string]$Action = "Status",
  [switch]$ConfirmEnable
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($EnvPath)) {
  $EnvPath = Join-Path $Workspace ".env"
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

function Set-EnvKey {
  param(
    [string]$Path,
    [string]$Key,
    [string]$Value
  )
  $lines = if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path -Encoding UTF8 } else { @() }
  $found = $false
  $out = foreach ($line in $lines) {
    if ($line -match "^$([regex]::Escape($Key))=") {
      $found = $true
      "$Key=$Value"
    } else {
      $line
    }
  }
  if (-not $found) {
    $out += "$Key=$Value"
  }
  Set-Content -LiteralPath $Path -Value $out -Encoding UTF8
}

function Show-Status {
  param([hashtable]$Map)
  $keys = @(
    "FEISHU_CRM_SYNC_ENABLED",
    "FEISHU_CRM_SYNC_MODE",
    "FEISHU_CRM_WRITE_TEST_PASSED",
    "FEISHU_CRM_WRITE_TEST_PASSED_AT",
    "EMAIL_OUTREACH_ENABLED",
    "WHATSAPP_OUTREACH_ENABLED",
    "EXTERNAL_SEND_REQUIRES_CONFIRMATION",
    "REQUIRE_HUMAN_APPROVAL_BEFORE_SEND",
    "EMAIL_SEND_REQUIRES_CONFIRMATION",
    "WHATSAPP_SEND_REQUIRES_CONFIRMATION"
  )
  foreach ($key in $keys) {
    $value = if ($Map.ContainsKey($key) -and -not [string]::IsNullOrWhiteSpace($Map[$key])) { $Map[$key] } else { "missing" }
    Write-Host "$key=$value"
  }
}

Write-Host "== Production switches =="
Write-Host "Workspace: $Workspace"
Write-Host "Action: $Action"

if ($Action -ne "Status" -and -not (Test-Path -LiteralPath $EnvPath)) {
  throw ".env not found: $EnvPath"
}

$envMap = Get-EnvMap $EnvPath

if ($Action -eq "Status") {
  Show-Status $envMap
  exit 0
}

if ($Action -eq "EnableFeishuDailySync") {
  if (-not $ConfirmEnable) {
    throw "EnableFeishuDailySync requires -ConfirmEnable."
  }
  if ($envMap.FEISHU_CRM_WRITE_TEST_PASSED -ne "true") {
    throw "Refusing to enable daily Feishu CRM sync before FEISHU_CRM_WRITE_TEST_PASSED=true."
  }
  $missing = @("FEISHU_APP_ID", "FEISHU_APP_SECRET", "CRM_SPREADSHEET_TOKEN", "CRM_SHEET_ID") |
    Where-Object { [string]::IsNullOrWhiteSpace($envMap[$_]) }
  if ($missing.Count -gt 0) {
    throw "Refusing to enable daily Feishu CRM sync; missing: $($missing -join ', ')"
  }
  Set-EnvKey -Path $EnvPath -Key "FEISHU_CRM_SYNC_ENABLED" -Value "true"
  Set-EnvKey -Path $EnvPath -Key "FEISHU_CRM_SYNC_MODE" -Value "OverwriteAll"
  Write-Host "[OK] Daily Feishu CRM sync enabled."
  Write-Host "[OK] Mode: OverwriteAll"
  exit 0
}

if ($Action -eq "DisableFeishuDailySync") {
  Set-EnvKey -Path $EnvPath -Key "FEISHU_CRM_SYNC_ENABLED" -Value "false"
  Write-Host "[OK] Daily Feishu CRM sync disabled."
  exit 0
}

if ($Action -eq "DisableExternalActions") {
  Set-EnvKey -Path $EnvPath -Key "FEISHU_CRM_SYNC_ENABLED" -Value "false"
  Set-EnvKey -Path $EnvPath -Key "EMAIL_OUTREACH_ENABLED" -Value "false"
  Set-EnvKey -Path $EnvPath -Key "WHATSAPP_OUTREACH_ENABLED" -Value "false"
  Set-EnvKey -Path $EnvPath -Key "EXTERNAL_SEND_REQUIRES_CONFIRMATION" -Value "true"
  Set-EnvKey -Path $EnvPath -Key "REQUIRE_HUMAN_APPROVAL_BEFORE_SEND" -Value "true"
  Set-EnvKey -Path $EnvPath -Key "EMAIL_SEND_REQUIRES_CONFIRMATION" -Value "true"
  Set-EnvKey -Path $EnvPath -Key "WHATSAPP_SEND_REQUIRES_CONFIRMATION" -Value "true"
  Write-Host "[OK] External actions disabled and confirmation guards enabled."
  exit 0
}
