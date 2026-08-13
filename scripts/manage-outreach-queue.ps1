param(
  [string]$Workspace = "",
  [ValidateSet("List", "Approve", "Reject", "Reset")]
  [string]$Action = "List",
  [string]$Company = "",
  [string]$ApprovedBy = "",
  [string]$SendAfter = "",
  [string]$Reason = "",
  [switch]$ConfirmChange
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$queuePath = Join-Path $Workspace "product_data\outreach_approval_queue.csv"
if (-not (Test-Path -LiteralPath $queuePath)) {
  throw "Approval queue missing: $queuePath"
}

function Normalize {
  param([string]$Value)
  if ($null -eq $Value) { return "" }
  return $Value.Trim().ToLowerInvariant()
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

$rows = @(Import-Csv -LiteralPath $queuePath -Encoding UTF8)

if ($Action -eq "List") {
  Write-Host "== Outreach approval queue =="
  $rows |
    Select-Object company, channel, destination_type, approval_status, approved_by, approved_at, send_after, sent_at |
    Format-Table -AutoSize
  $summary = $rows | Group-Object approval_status | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Count)" }
  Write-Host "[OK] Rows: $($rows.Count)"
  Write-Host "[OK] Status: $($summary -join ', ')"
  exit 0
}

if (-not $ConfirmChange) {
  throw "$Action requires -ConfirmChange."
}
if ([string]::IsNullOrWhiteSpace($Company)) {
  throw "$Action requires -Company."
}

$matches = @($rows | Where-Object { (Normalize $_.company) -eq (Normalize $Company) })
if ($matches.Count -ne 1) {
  throw "Expected exactly one queue row for company '$Company', found $($matches.Count)."
}

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\backup-production-state.ps1") -Workspace $Workspace -Reason "before-outreach-queue-$Action"
if ($LASTEXITCODE -ne 0) {
  throw "backup-production-state.ps1 failed before queue change."
}

$row = $matches[0]
$now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
if ($Action -eq "Approve") {
  if ([string]::IsNullOrWhiteSpace($ApprovedBy)) {
    throw "Approve requires -ApprovedBy."
  }
  if ([string]::IsNullOrWhiteSpace($row.destination)) {
    throw "Cannot approve row with blank destination."
  }
  Set-Value $row "approval_status" "APPROVED"
  Set-Value $row "approved_by" $ApprovedBy
  Set-Value $row "approved_at" $now
  Set-Value $row "send_after" $SendAfter
  if (-not [string]::IsNullOrWhiteSpace($Reason)) {
    Set-Value $row "notes" (($row.notes + " | APPROVED: " + $Reason).Trim(" |".ToCharArray()))
  }
} elseif ($Action -eq "Reject") {
  Set-Value $row "approval_status" "REJECTED"
  Set-Value $row "approved_by" $ApprovedBy
  Set-Value $row "approved_at" $now
  Set-Value $row "send_after" ""
  if (-not [string]::IsNullOrWhiteSpace($Reason)) {
    Set-Value $row "notes" (($row.notes + " | REJECTED: " + $Reason).Trim(" |".ToCharArray()))
  }
} elseif ($Action -eq "Reset") {
  Set-Value $row "approval_status" "DO_NOT_SEND_YET"
  Set-Value $row "approved_by" ""
  Set-Value $row "approved_at" ""
  Set-Value $row "send_after" ""
  if (-not [string]::IsNullOrWhiteSpace($Reason)) {
    Set-Value $row "notes" (($row.notes + " | RESET: " + $Reason).Trim(" |".ToCharArray()))
  }
}

$rows | Export-Csv -LiteralPath $queuePath -NoTypeInformation -Encoding UTF8

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\build-outbound-messages.ps1") -Workspace $Workspace -MvpDir (Join-Path $Workspace "product_data")
if ($LASTEXITCODE -ne 0) {
  throw "build-outbound-messages.ps1 failed after queue change."
}

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\validate-outbound-approval.ps1") -Workspace $Workspace
if ($LASTEXITCODE -ne 0) {
  throw "validate-outbound-approval.ps1 failed after queue change."
}

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\invoke-outbound-dispatch.ps1") -Workspace $Workspace -Mode Plan
if ($LASTEXITCODE -ne 0) {
  throw "invoke-outbound-dispatch.ps1 plan failed after queue change."
}

Write-Host "[OK] $Action applied to $Company"
exit 0
