param(
  [string]$Workspace = "",
  [string]$EnvPath = "",
  [string]$CsvPath = "",
  [ValidateSet("Plan", "AppendTest", "OverwriteAll")]
  [string]$Mode = "Plan",
  [switch]$ConfirmWrite
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($EnvPath)) {
  $EnvPath = Join-Path $Workspace ".env"
}
if ([string]::IsNullOrWhiteSpace($CsvPath)) {
  $CsvPath = Join-Path $Workspace "product_data\crm_import.csv"
}

$ExpectedHeaders = @(
  "created_at",
  "market",
  "product",
  "company",
  "website",
  "country",
  "buyer_type",
  "contact_name",
  "title",
  "email",
  "whatsapp",
  "linkedin",
  "source_url",
  "score",
  "grade",
  "match_reason",
  "recommended_channel",
  "email_draft",
  "whatsapp_opener",
  "status",
  "next_follow_up_at",
  "owner"
)

function Get-EnvMap {
  param([string]$Path)
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) {
    throw ".env not found: $Path"
  }
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

function Get-TenantAccessToken {
  param(
    [string]$AppId,
    [string]$AppSecret
  )
  $body = @{ app_id = $AppId; app_secret = $AppSecret } | ConvertTo-Json -Compress
  $resp = Invoke-RestMethod `
    -Method Post `
    -Uri "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" `
    -ContentType "application/json" `
    -Body $body
  if ($resp.code -ne 0) {
    throw "Feishu token failed: code=$($resp.code) msg=$($resp.msg)"
  }
  return $resp.tenant_access_token
}

function ConvertTo-A1Column {
  param([int]$Index)
  $n = $Index
  $name = ""
  while ($n -gt 0) {
    $n--
    $name = [char](65 + ($n % 26)) + $name
    $n = [math]::Floor($n / 26)
  }
  return $name
}

function Get-WikiTokenFromUrl {
  param([string]$Url)
  if ([string]::IsNullOrWhiteSpace($Url)) { return "" }
  if ($Url -match '/wiki/([^?/#]+)') { return $matches[1] }
  return ""
}

function Resolve-SpreadsheetFromWiki {
  param(
    [hashtable]$EnvMap,
    [string]$Token,
    [string]$EnvPath
  )
  if (-not [string]::IsNullOrWhiteSpace($EnvMap.CRM_SPREADSHEET_TOKEN)) {
    return $EnvMap.CRM_SPREADSHEET_TOKEN
  }

  $wikiToken = Get-WikiTokenFromUrl $EnvMap.CRM_WIKI_URL
  if ([string]::IsNullOrWhiteSpace($wikiToken)) {
    throw "CRM_SPREADSHEET_TOKEN is missing and CRM_WIKI_URL is not a wiki URL."
  }

  $headers = @{ Authorization = "Bearer $Token" }
  $resp = Invoke-RestMethod `
    -Method Get `
    -Uri "https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=$wikiToken" `
    -Headers $headers
  if ($resp.code -ne 0) {
    throw "Feishu wiki resolve failed: code=$($resp.code) msg=$($resp.msg)"
  }
  if ($resp.data.node.obj_type -ne "sheet") {
    throw "Wiki node is not a sheet: obj_type=$($resp.data.node.obj_type)"
  }

  Set-EnvKey -Path $EnvPath -Key "CRM_SPREADSHEET_TOKEN" -Value $resp.data.node.obj_token
  return $resp.data.node.obj_token
}

function Resolve-SheetId {
  param(
    [hashtable]$EnvMap,
    [string]$SpreadsheetToken,
    [string]$Token,
    [string]$EnvPath
  )
  if (-not [string]::IsNullOrWhiteSpace($EnvMap.CRM_SHEET_ID)) {
    return $EnvMap.CRM_SHEET_ID
  }

  $headers = @{ Authorization = "Bearer $Token" }
  $resp = Invoke-RestMethod `
    -Method Get `
    -Uri "https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/$SpreadsheetToken/sheets/query" `
    -Headers $headers
  if ($resp.code -ne 0) {
    throw "Feishu sheet query failed: code=$($resp.code) msg=$($resp.msg)"
  }
  if (-not $resp.data.sheets -or $resp.data.sheets.Count -eq 0) {
    throw "No sheets found in spreadsheet."
  }

  $sheetId = $resp.data.sheets[0].sheet_id
  Set-EnvKey -Path $EnvPath -Key "CRM_SHEET_ID" -Value $sheetId
  return $sheetId
}

function Read-FeishuRange {
  param(
    [string]$SpreadsheetToken,
    [string]$SheetId,
    [string]$Range,
    [string]$Token
  )
  $encodedRange = [uri]::EscapeDataString("$SheetId!$Range")
  $headers = @{ Authorization = "Bearer $Token" }
  $resp = Invoke-RestMethod `
    -Method Get `
    -Uri "https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/$SpreadsheetToken/values/$encodedRange" `
    -Headers $headers
  if ($resp.code -ne 0) {
    throw "Feishu range read failed: code=$($resp.code) msg=$($resp.msg)"
  }
  return $resp.data.valueRange.values
}

function Write-FeishuRange {
  param(
    [string]$SpreadsheetToken,
    [string]$SheetId,
    [string]$Range,
    [array]$Values,
    [string]$Token
  )
  $headers = @{
    Authorization = "Bearer $Token"
    "Content-Type" = "application/json; charset=utf-8"
  }
  $payload = @{
    valueRange = @{
      range = "$SheetId!$Range"
      values = $Values
    }
  } | ConvertTo-Json -Depth 8 -Compress
  $resp = Invoke-RestMethod `
    -Method Put `
    -Uri "https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/$SpreadsheetToken/values" `
    -Headers $headers `
    -Body $payload
  if ($resp.code -ne 0) {
    throw "Feishu range write failed: code=$($resp.code) msg=$($resp.msg)"
  }
  return $resp
}

function Append-FeishuRows {
  param(
    [string]$SpreadsheetToken,
    [string]$SheetId,
    [string]$Range,
    [array]$Values,
    [string]$Token
  )
  $headers = @{
    Authorization = "Bearer $Token"
    "Content-Type" = "application/json; charset=utf-8"
  }
  $payload = @{
    valueRange = @{
      range = "$SheetId!$Range"
      values = $Values
    }
  } | ConvertTo-Json -Depth 8 -Compress
  $resp = Invoke-RestMethod `
    -Method Post `
    -Uri "https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/$SpreadsheetToken/values_append" `
    -Headers $headers `
    -Body $payload
  if ($resp.code -ne 0) {
    throw "Feishu row append failed: code=$($resp.code) msg=$($resp.msg)"
  }
  return $resp
}

function Convert-CsvToValues {
  param(
    [string]$Path,
    [string[]]$Headers
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "CRM CSV not found: $Path"
  }
  $rows = @(Import-Csv -LiteralPath $Path -Encoding UTF8)
  $values = @()
  $values += ,@($Headers)
  foreach ($row in $rows) {
    $line = foreach ($header in $Headers) {
      $value = [string]$row.$header
      if ($null -eq $value) { "" } else { $value -replace "`r?`n", " " }
    }
    $values += ,@($line)
  }
  return [pscustomobject]@{
    Rows = $rows
    Values = $values
  }
}

if ($Mode -ne "Plan" -and -not $ConfirmWrite) {
  throw "Write mode '$Mode' requires -ConfirmWrite."
}

if ($Mode -ne "Plan") {
  $backupScript = Join-Path $Workspace "scripts\backup-production-state.ps1"
  if (Test-Path -LiteralPath $backupScript) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $backupScript -Workspace $Workspace -Reason "before-feishu-$Mode"
    if ($LASTEXITCODE -ne 0) {
      throw "backup-production-state.ps1 failed before Feishu write mode $Mode"
    }
  } else {
    throw "backup-production-state.ps1 missing; refusing Feishu write mode $Mode"
  }
}

$envMap = Get-EnvMap -Path $EnvPath
$missing = @("FEISHU_APP_ID", "FEISHU_APP_SECRET") | Where-Object { [string]::IsNullOrWhiteSpace($envMap[$_]) }
if ($missing.Count -gt 0) {
  throw "Missing Feishu credentials in .env: $($missing -join ', ')"
}

$token = Get-TenantAccessToken -AppId $envMap.FEISHU_APP_ID -AppSecret $envMap.FEISHU_APP_SECRET
$spreadsheetToken = Resolve-SpreadsheetFromWiki -EnvMap $envMap -Token $token -EnvPath $EnvPath
$envMap = Get-EnvMap -Path $EnvPath
$sheetId = Resolve-SheetId -EnvMap $envMap -SpreadsheetToken $spreadsheetToken -Token $token -EnvPath $EnvPath

$crm = Convert-CsvToValues -Path $CsvPath -Headers $ExpectedHeaders
$values = $crm.Values
$localRows = @($crm.Rows).Count
$localCols = $ExpectedHeaders.Count
$lastCol = ConvertTo-A1Column $localCols
$writeEndRow = $localRows + 1
$writeRange = "A1:${lastCol}${writeEndRow}"

$remoteHeaderRows = Read-FeishuRange `
  -SpreadsheetToken $spreadsheetToken `
  -SheetId $sheetId `
  -Range "A1:${lastCol}2" `
  -Token $token
$remoteHeaders = if ($remoteHeaderRows -and $remoteHeaderRows.Count -gt 0) {
  @($remoteHeaderRows[0] | ForEach-Object { [string]$_ })
} else {
  @()
}
$headerMatch = (($remoteHeaders -join "`t") -eq ($ExpectedHeaders -join "`t"))

Write-Host "== Feishu CRM sync =="
Write-Host "Mode: $Mode"
Write-Host "Workspace: $Workspace"
Write-Host "CSV rows: $localRows"
Write-Host "CSV columns: $localCols"
Write-Host "Spreadsheet token: present"
Write-Host "Sheet ID: $sheetId"
Write-Host "Remote header match: $headerMatch"
Write-Host "Target range: $writeRange"

if (-not $headerMatch) {
  Write-Host "[WARN] Remote header:"
  Write-Host ($remoteHeaders -join ",")
  Write-Host "[WARN] Expected header:"
  Write-Host ($ExpectedHeaders -join ",")
  if ($Mode -ne "OverwriteAll") {
    throw "Remote header does not match expected CRM schema. Use OverwriteAll only after manual review."
  }
}

if ($Mode -eq "Plan") {
  Write-Host "[OK] Plan complete. No Feishu writes performed."
  exit 0
}

if ($Mode -eq "AppendTest") {
  $testRow = @(
    (Get-Date -Format "yyyy-MM-dd HH:mm:ss"),
    "API_TEST",
    "sample product line",
    "FEISHU_API_WRITE_TEST_DO_NOT_CONTACT",
    "",
    "API_TEST",
    "system test",
    "Do Not Contact",
    "API write test",
    "",
    "",
    "",
    "",
    "0",
    "REJECT",
    "API connectivity test row. Delete after validation.",
    "manual_verify",
    "",
    "",
    "DO_NOT_SEND_YET",
    "",
    "system"
  )
  Append-FeishuRows `
    -SpreadsheetToken $spreadsheetToken `
    -SheetId $sheetId `
    -Range "A1:${lastCol}1" `
    -Values (,$testRow) `
    -Token $token | Out-Null
  Set-EnvKey -Path $EnvPath -Key "FEISHU_CRM_WRITE_TEST_PASSED" -Value "true"
  Set-EnvKey -Path $EnvPath -Key "FEISHU_CRM_WRITE_TEST_PASSED_AT" -Value (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
  Write-Host "[OK] Appended one test row: FEISHU_API_WRITE_TEST_DO_NOT_CONTACT"
  Write-Host "[OK] FEISHU_CRM_WRITE_TEST_PASSED=true recorded in local .env"
  exit 0
}

if ($Mode -eq "OverwriteAll") {
  Write-FeishuRange `
    -SpreadsheetToken $spreadsheetToken `
    -SheetId $sheetId `
    -Range $writeRange `
    -Values $values `
    -Token $token | Out-Null
  Write-Host "[OK] Overwrote Feishu CRM range $writeRange from local CSV."
  exit 0
}
