param(
  [string]$MvpDir = ".\local_mvp_test_20260709",
  [string]$Product = "Sample Product",
  [string]$Owner = "",
  [string]$OutputFile = "crm_import.csv"
)

$ErrorActionPreference = "Stop"

function Get-SafeValue {
  param(
    [object]$Row,
    [string]$Name,
    [string]$Default = ""
  )
  if ($null -eq $Row -or -not ($Row.PSObject.Properties.Name -contains $Name)) { return $Default }
  $value = [string]$Row.$Name
  if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
  return $value.Trim()
}

function Set-RowValue {
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

function Normalize-KeyPart {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return "" }
  return ($Text.Trim().ToLowerInvariant() -replace '^https?://', '' -replace '^www\.', '' -replace '/+$', '' -replace '\s+', ' ')
}

function New-CrmKey {
  param([object]$Row)

  $sourceUrl = Get-SafeValue $Row "source_url"
  if ([string]::IsNullOrWhiteSpace($sourceUrl)) { $sourceUrl = Get-SafeValue $Row "Source URLs" }
  if (-not [string]::IsNullOrWhiteSpace($sourceUrl)) {
    return "source:" + (Normalize-KeyPart $sourceUrl)
  }

  $website = Get-SafeValue $Row "website"
  if ([string]::IsNullOrWhiteSpace($website)) { $website = Get-SafeValue $Row "Website" }
  if (-not [string]::IsNullOrWhiteSpace($website)) {
    return "website:" + (Normalize-KeyPart $website)
  }

  $company = Get-SafeValue $Row "company"
  if ([string]::IsNullOrWhiteSpace($company)) { $company = Get-SafeValue $Row "Company Name" }
  $country = Get-SafeValue $Row "country"
  if ([string]::IsNullOrWhiteSpace($country)) { $country = Get-SafeValue $Row "Country" }
  return "company:" + (Normalize-KeyPart "$company|$country")
}

function Test-GenericValue {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $true }
  $v = $Value.Trim().ToLowerInvariant()
  return (
    $v -eq "unknown" -or
    $v -eq "sales inquiry" -or
    $v -eq "generic contact via site" -or
    $v -eq "department contact via site" -or
    $v -eq "public whatsapp via site" -or
    $v -eq "official contact route" -or
    $v -eq "official sales team" -or
    $v -match 'generic|unknown|inquiry|route|team'
  )
}

function Test-ExistingValueIsRicher {
  param(
    [string]$ExistingValue,
    [string]$NewValue,
    [string]$Field
  )

  if ([string]::IsNullOrWhiteSpace($ExistingValue)) { return $false }
  if ([string]::IsNullOrWhiteSpace($NewValue)) { return $true }
  if ($ExistingValue.Trim() -eq $NewValue.Trim()) { return $false }
  if (Test-GenericValue $NewValue) { return $true }
  if ($Field -eq "email" -and $ExistingValue -match '@' -and $NewValue -notmatch '@') { return $true }
  if ($Field -in @("whatsapp", "contact_name", "title", "linkedin") -and $ExistingValue.Trim().Length -gt $NewValue.Trim().Length) { return $true }
  return $false
}

$leadsPath = Join-Path $MvpDir "leads.csv"
if (-not (Test-Path -LiteralPath $leadsPath)) {
  throw "Missing leads file: $leadsPath"
}

$rows = Import-Csv -LiteralPath $leadsPath
$createdAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")

$crmRows = foreach ($row in $rows) {
  $sourceUrl = $row."Source URLs"
  $grade = $row.Priority
  $recommendedChannel = if (-not [string]::IsNullOrWhiteSpace($row.WhatsApp)) {
    "WhatsApp + Email draft"
  } elseif (-not [string]::IsNullOrWhiteSpace($row.Email)) {
    "Email draft"
  } elseif (-not [string]::IsNullOrWhiteSpace($row.Phone)) {
    "Phone/WhatsApp research"
  } else {
    "Research contact first"
  }

  $status = if ($grade -eq "SILVER") {
    "Needs named contact"
  } elseif ($grade -eq "GOLD") {
    "Ready for human review"
  } else {
    "Company-level lead"
  }

  [PSCustomObject]@{
    created_at = $createdAt
    market = $row.Country
    product = $Product
    company = $row."Company Name"
    website = $row.Website
    country = $row.Country
    buyer_type = $row."Buyer Type"
    contact_name = if ($row."Contact Person" -eq "Unknown") { "" } else { $row."Contact Person" }
    title = if ($row."Job Title" -eq "Unknown") { "" } else { $row."Job Title" }
    email = $row.Email
    whatsapp = $row.WhatsApp
    linkedin = ""
    source_url = $sourceUrl
    score = $row.Score
    grade = $grade
    match_reason = "$($row."Product Match") | $($row.Notes)"
    recommended_channel = $recommendedChannel
    email_draft = ""
    whatsapp_opener = ""
    status = $status
    next_follow_up_at = ""
    owner = $Owner
  }
}

$outPath = Join-Path $MvpDir $OutputFile
$existingRows = @()
$existingByKey = @{}
if (Test-Path -LiteralPath $outPath) {
  $existingRows = @(Import-Csv -LiteralPath $outPath -Encoding UTF8)
  foreach ($existing in $existingRows) {
    $key = New-CrmKey $existing
    if (-not [string]::IsNullOrWhiteSpace($key) -and -not $existingByKey.ContainsKey($key)) {
      $existingByKey[$key] = $existing
    }
  }
}

$manualFields = @(
  "created_at",
  "status",
  "next_follow_up_at",
  "owner",
  "email_draft",
  "whatsapp_opener"
)
$contactFields = @(
  "contact_name",
  "title",
  "email",
  "whatsapp",
  "linkedin"
)
$preservedCounts = [ordered]@{}
foreach ($field in ($manualFields + $contactFields)) {
  $preservedCounts[$field] = 0
}

$matchedCount = 0
$newCount = 0
$mergeDetails = New-Object System.Collections.Generic.List[object]
foreach ($crmRow in $crmRows) {
  $key = New-CrmKey $crmRow
  if ($existingByKey.ContainsKey($key)) {
    $matchedCount += 1
    $existing = $existingByKey[$key]
    $preservedFields = New-Object System.Collections.Generic.List[string]

    foreach ($field in $manualFields) {
      $existingValue = Get-SafeValue $existing $field
      if (-not [string]::IsNullOrWhiteSpace($existingValue)) {
        $currentValue = Get-SafeValue $crmRow $field
        if ($currentValue -ne $existingValue) {
          Set-RowValue $crmRow $field $existingValue
          $preservedCounts[$field] += 1
          $preservedFields.Add($field) | Out-Null
        }
      }
    }

    foreach ($field in $contactFields) {
      $existingValue = Get-SafeValue $existing $field
      $currentValue = Get-SafeValue $crmRow $field
      if (Test-ExistingValueIsRicher -ExistingValue $existingValue -NewValue $currentValue -Field $field) {
        Set-RowValue $crmRow $field $existingValue
        $preservedCounts[$field] += 1
        $preservedFields.Add($field) | Out-Null
      }
    }

    if ($preservedFields.Count -gt 0) {
      $mergeDetails.Add([pscustomobject]@{
        company = $crmRow.company
        key = $key
        preserved_fields = @($preservedFields)
      }) | Out-Null
    }
  } else {
    $newCount += 1
  }
}

$crmRows | Export-Csv -LiteralPath $outPath -NoTypeInformation -Encoding UTF8

$preservedCountsObject = [pscustomobject]@{}
foreach ($field in $preservedCounts.Keys) {
  $preservedCountsObject | Add-Member -NotePropertyName $field -NotePropertyValue $preservedCounts[$field]
}

$report = New-Object System.Collections.Specialized.OrderedDictionary
$report.Add("generated_at", (Get-Date -Format s))
$report.Add("output_file", $outPath)
$report.Add("source_leads", $rows.Count)
$report.Add("existing_rows", $existingRows.Count)
$report.Add("matched_existing", $matchedCount)
$report.Add("new_rows", $newCount)
$report.Add("preserved_counts", $preservedCountsObject)
$report.Add("preserved_rows", @($mergeDetails.ToArray()))
$reportPath = Join-Path $MvpDir "crm_merge_report.json"
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Host "[OK] CRM import written: $outPath"
Write-Host "[OK] Row count: $($crmRows.Count)"
Write-Host "[OK] CRM state merge: matched_existing=$matchedCount; new_rows=$newCount"
Write-Host "[OK] CRM merge report: $reportPath"
