param(
  [string]$Workspace = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

function Set-Value {
  param(
    [object]$Row,
    [string]$Name,
    [string]$Value
  )
  if ($Row.PSObject.Properties.Name -contains $Name) {
    $Row.$Name = $Value
  } else {
    $Row | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  }
}

function Assert-Equal {
  param(
    [string]$Name,
    [string]$Expected,
    [string]$Actual
  )
  if ($Expected -ne $Actual) {
    throw "$Name was not preserved. Expected '$Expected', got '$Actual'."
  }
}

$sourceDir = Join-Path $Workspace "product_data"
if (-not (Test-Path -LiteralPath $sourceDir)) {
  throw "Missing source CRM directory: $sourceDir"
}

$testRoot = Join-Path $Workspace "outputs\crm_state_preservation"
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
$testDir = Join-Path $testRoot ("crm-state-preservation-" + (Get-Date -Format "yyyyMMdd_HHmmss"))
New-Item -ItemType Directory -Force -Path $testDir | Out-Null
Get-ChildItem -LiteralPath $sourceDir -Force | Copy-Item -Destination $testDir -Recurse -Force

$crmPath = Join-Path $testDir "crm_import.csv"
$rows = @(Import-Csv -LiteralPath $crmPath -Encoding UTF8)
if ($rows.Count -eq 0) {
  throw "No CRM rows found in copied test data: $crmPath"
}

$target = $rows[0]
$company = [string]$target.company
$sourceUrl = [string]$target.source_url
$expected = [ordered]@{
  created_at = "2026-01-02 03:04:05"
  status = "Manual contacted"
  next_follow_up_at = "2026-07-20"
  owner = "Manual Owner"
  contact_name = "Manual Buyer"
  title = "Procurement Director"
  email = "manual.buyer@example.com"
  whatsapp = "+12345678900"
  linkedin = "https://www.linkedin.com/in/manual-buyer"
  email_draft = "MANUAL EMAIL DRAFT - keep me"
  whatsapp_opener = "MANUAL WHATSAPP OPENER - keep me"
}

foreach ($field in $expected.Keys) {
  Set-Value $target $field $expected[$field]
}
$rows | Export-Csv -LiteralPath $crmPath -NoTypeInformation -Encoding UTF8

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\export-leads-to-crm.ps1") `
  -MvpDir $testDir `
  -Product "sample product line" `
  -Owner "Example Sales"
if ($LASTEXITCODE -ne 0) {
  throw "export-leads-to-crm.ps1 failed with exit code $LASTEXITCODE"
}

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\build-outbound-messages.ps1") `
  -Workspace $Workspace `
  -MvpDir $testDir `
  -Product "sample product line"
if ($LASTEXITCODE -ne 0) {
  throw "build-outbound-messages.ps1 failed with exit code $LASTEXITCODE"
}

$afterRows = @(Import-Csv -LiteralPath $crmPath -Encoding UTF8)
$after = $afterRows | Where-Object { $_.company -eq $company -and $_.source_url -eq $sourceUrl } | Select-Object -First 1
if (-not $after) {
  throw "Could not find preserved test row after regeneration: company=$company; source_url=$sourceUrl"
}

foreach ($field in $expected.Keys) {
  Assert-Equal -Name $field -Expected $expected[$field] -Actual ([string]$after.$field)
}

$reportPath = Join-Path $testDir "crm_merge_report.json"
if (-not (Test-Path -LiteralPath $reportPath)) {
  throw "Missing CRM merge report: $reportPath"
}
$report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($report.matched_existing -lt 1) {
  throw "CRM merge report did not record matched existing rows."
}
if ($report.preserved_rows.Count -lt 1) {
  throw "CRM merge report did not record preserved rows."
}

Write-Host "[OK] CRM state preservation test passed."
Write-Host "[OK] Test directory: $testDir"
Write-Host "[OK] Preserved row: $company"
Write-Host "[OK] Merge report: $reportPath"
