param()

$ErrorActionPreference = "Stop"

$taskName = "Export AI Agent - Daily Real Pipeline"
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "[OK] Removed scheduled task: $taskName"
} else {
  Write-Host "[OK] Scheduled task not found: $taskName"
}
