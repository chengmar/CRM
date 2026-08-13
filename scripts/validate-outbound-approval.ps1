param(
  [string]$Workspace = "",
  [string]$QueuePath = "",
  [string]$DoNotContactPath = ""
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($QueuePath)) {
  $QueuePath = Join-Path $Workspace "product_data\outreach_approval_queue.csv"
}
if ([string]::IsNullOrWhiteSpace($DoNotContactPath)) {
  $DoNotContactPath = Join-Path $Workspace "product_data\do_not_contact.csv"
}

$results = New-Object System.Collections.Generic.List[object]

function Add-Check {
  param(
    [string]$Area,
    [string]$Status,
    [string]$Detail
  )
  $results.Add([pscustomobject]@{ area = $Area; status = $Status; detail = $Detail }) | Out-Null
  $tag = if ($Status -eq "OK") { "[OK]" } elseif ($Status -eq "WARN") { "[WARN]" } else { "[BLOCKED]" }
  Write-Host "$tag $Area $Detail"
}

function Normalize-Target {
  param([string]$Value)
  if ($null -eq $Value) { return "" }
  return $Value.Trim().ToLowerInvariant()
}

function Has-Column {
  param(
    [object]$Row,
    [string]$Name
  )
  return ($Row.PSObject.Properties.Name -contains $Name)
}

Write-Host "== Outbound approval queue check =="
Write-Host "Queue: $QueuePath"
Write-Host "Do-not-contact: $DoNotContactPath"

if (-not (Test-Path -LiteralPath $QueuePath)) {
  Add-Check "Approval queue file" "BLOCKED" "missing outreach_approval_queue.csv"
  $results | ConvertTo-Json -Depth 5 | Out-Null
  exit 1
}
if (-not (Test-Path -LiteralPath $DoNotContactPath)) {
  Add-Check "Do-not-contact file" "BLOCKED" "missing do_not_contact.csv"
  $results | ConvertTo-Json -Depth 5 | Out-Null
  exit 1
}

try {
  $queue = @(Import-Csv -LiteralPath $QueuePath -Encoding UTF8)
} catch {
  Add-Check "Approval queue CSV" "BLOCKED" $_.Exception.Message
  exit 1
}

try {
  $dnc = @(Import-Csv -LiteralPath $DoNotContactPath -Encoding UTF8)
} catch {
  Add-Check "Do-not-contact CSV" "BLOCKED" $_.Exception.Message
  exit 1
}

$queueRequired = @(
  "company",
  "channel",
  "destination",
  "destination_type",
  "source_url",
  "draft_ref",
  "approval_status",
  "approved_by",
  "approved_at",
  "send_after",
  "sent_at",
  "notes"
)
$dncRequired = @("entry_type", "value", "reason", "source", "created_at", "notes")

$queueHeader = if ($queue.Count -gt 0) {
  $queue[0].PSObject.Properties.Name
} else {
  (Get-Content -LiteralPath $QueuePath -Encoding UTF8 -TotalCount 1) -split ","
}
$missingQueueCols = @($queueRequired | Where-Object { $queueHeader -notcontains $_ })
if ($missingQueueCols.Count -gt 0) {
  Add-Check "Approval queue schema" "BLOCKED" ("missing " + ($missingQueueCols -join ", "))
} else {
  Add-Check "Approval queue schema" "OK" "required columns present"
}

$dncHeader = if ($dnc.Count -gt 0) {
  $dnc[0].PSObject.Properties.Name
} else {
  (Get-Content -LiteralPath $DoNotContactPath -Encoding UTF8 -TotalCount 1) -split ","
}
$missingDncCols = @($dncRequired | Where-Object { $dncHeader -notcontains $_ })
if ($missingDncCols.Count -gt 0) {
  Add-Check "Do-not-contact schema" "BLOCKED" ("missing " + ($missingDncCols -join ", "))
} else {
  Add-Check "Do-not-contact schema" "OK" "required columns present"
}

$blockedDetails = New-Object System.Collections.Generic.List[string]
$warnDetails = New-Object System.Collections.Generic.List[string]

$allowedStatuses = @("DO_NOT_SEND_YET", "NEEDS_RESEARCH", "PENDING_APPROVAL", "APPROVED", "REJECTED", "SENT")
$dncValues = New-Object System.Collections.Generic.HashSet[string]
foreach ($entry in $dnc) {
  $value = Normalize-Target $entry.value
  if ([string]::IsNullOrWhiteSpace($value)) {
    $blockedDetails.Add("blank value in do_not_contact.csv") | Out-Null
    continue
  }
  [void]$dncValues.Add($value)
}

foreach ($row in $queue) {
  $company = [string]$row.company
  $status = ([string]$row.approval_status).Trim().ToUpperInvariant()
  if ([string]::IsNullOrWhiteSpace($company)) {
    $blockedDetails.Add("blank company in approval queue") | Out-Null
    continue
  }
  if ($allowedStatuses -notcontains $status) {
    $blockedDetails.Add("$company has invalid approval_status '$($row.approval_status)'") | Out-Null
    continue
  }

  $companyKey = Normalize-Target $company
  $destinationKey = Normalize-Target $row.destination
  if ($dncValues.Contains($companyKey) -or ($destinationKey -and $dncValues.Contains($destinationKey))) {
    $blockedDetails.Add("$company is still present in approval queue but matches do_not_contact.csv") | Out-Null
  }

  if ($status -eq "APPROVED") {
    $requiredApprovedFields = @("channel", "destination", "destination_type", "source_url", "draft_ref", "approved_by", "approved_at")
    foreach ($field in $requiredApprovedFields) {
      if ([string]::IsNullOrWhiteSpace($row.$field)) {
        $blockedDetails.Add("$company is APPROVED but missing $field") | Out-Null
      }
    }
  } elseif ($status -eq "SENT") {
    if ([string]::IsNullOrWhiteSpace($row.sent_at)) {
      $blockedDetails.Add("$company is SENT but missing sent_at") | Out-Null
    }
  } else {
    $warnDetails.Add("$company remains $status") | Out-Null
  }
}

$approvedCount = @($queue | Where-Object { ([string]$_.approval_status).Trim().ToUpperInvariant() -eq "APPROVED" }).Count
$sentCount = @($queue | Where-Object { ([string]$_.approval_status).Trim().ToUpperInvariant() -eq "SENT" }).Count

if ($blockedDetails.Count -gt 0) {
  Add-Check "Approval queue safety" "BLOCKED" (($blockedDetails | Select-Object -First 8) -join " | ")
} else {
  Add-Check "Approval queue safety" "OK" "rows=$($queue.Count); approved=$approvedCount; sent=$sentCount; dnc_entries=$($dnc.Count)"
}

if ($warnDetails.Count -gt 0) {
  Add-Check "Approval queue status" "WARN" (($warnDetails | Select-Object -First 6) -join " | ")
}

$reportDir = Join-Path $Workspace "outputs\outbound_readiness"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$reportPath = Join-Path $reportDir ("outbound-approval-" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".json")
$results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Host "[OK] Report written: $reportPath"

if (@($results | Where-Object { $_.status -eq "BLOCKED" }).Count -gt 0) {
  exit 1
}
exit 0
