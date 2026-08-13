param(
  [string]$BriefPath = "",
  [switch]$AllowPlaceholder
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($BriefPath)) {
  $root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
  $BriefPath = Join-Path $root "local_mvp_test_20260709\input_brief.yaml"
}

if (-not (Test-Path -LiteralPath $BriefPath)) {
  throw "Brief file not found: $BriefPath"
}

$text = Get-Content -LiteralPath $BriefPath -Raw -Encoding UTF8
$missing = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

function Get-YamlScalar {
  param(
    [string]$Name
  )
  $pattern = "(?m)^\s*$([regex]::Escape($Name)):\s*(.*)\s*$"
  $m = [regex]::Match($text, $pattern)
  if (-not $m.Success) { return $null }
  return $m.Groups[1].Value.Trim()
}

function Require-Scalar {
  param(
    [string]$Path,
    [string]$Name
  )
  $value = Get-YamlScalar $Name
  $isEmpty = $null -eq $value -or $value -eq '""' -or $value -eq "''" -or [string]::IsNullOrWhiteSpace($value)
  $isPlaceholder = -not $isEmpty -and $value -match 'TODO|待填写|provide|your '
  if ($isEmpty -or ($isPlaceholder -and -not $AllowPlaceholder)) {
    $missing.Add($Path) | Out-Null
  } elseif ($isPlaceholder) {
    $warnings.Add("$Path still contains placeholder value.") | Out-Null
  }
}

Require-Scalar "company.legal_name_en" "legal_name_en"
Require-Scalar "company.website" "website"
Require-Scalar "company.city" "city"
Require-Scalar "company.contact_email" "contact_email"
Require-Scalar "company.intro_en" "intro_en"
Require-Scalar "product.name_cn" "name_cn"
Require-Scalar "product.name_en" "name_en"
Require-Scalar "product.hs_code" "hs_code"
Require-Scalar "product.year_range" "year_range"
Require-Scalar "product.tonnage_range" "tonnage_range"
Require-Scalar "product.inventory_count" "inventory_count"
Require-Scalar "product.price_range" "price_range"
Require-Scalar "product.moq" "moq"
Require-Scalar "output.owner" "owner"

if ($text -match '(?m)^\s*-\s*""\s*$' -and -not $AllowPlaceholder) {
  $warnings.Add('Some list items still contain empty placeholders: - ""') | Out-Null
}

if ($text -match '(?m)^\s*write_to_feishu:\s*true\s*$') {
  $warnings.Add('write_to_feishu is true. Keep it false until Feishu app/table authorization is ready.') | Out-Null
}

if ($text -match '(?m)^\s*send_email:\s*true\s*$') {
  $warnings.Add('send_email is true. Keep it false until SMTP/IMAP, unsubscribe text, and approval rules are ready.') | Out-Null
}

if ($text -notmatch '(?m)^\s*require_human_approval_before_send:\s*true\s*$') {
  $warnings.Add('require_human_approval_before_send should stay true for the first production tests.') | Out-Null
}

Write-Host "== Real brief validation =="
Write-Host "Brief: $BriefPath"

if ($missing.Count -eq 0) {
  Write-Host "[OK] Required scalar fields are filled."
} else {
  Write-Host "[FAIL] Missing required fields:"
  foreach ($item in $missing) {
    Write-Host "  - $item"
  }
}

if ($warnings.Count -eq 0) {
  Write-Host "[OK] No safety warnings."
} else {
  Write-Host "[WARN] Review these warnings:"
  foreach ($item in $warnings) {
    Write-Host "  - $item"
  }
}

if ($missing.Count -gt 0) {
  exit 1
}

exit 0
