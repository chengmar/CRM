param(
  [string]$Workspace = "",
  [string]$DailyTime = "09:10",
  [switch]$RunOnceNow
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$dailyScript = Join-Path $Workspace "scripts\invoke-daily-real-pipeline.ps1"
if (-not (Test-Path -LiteralPath $dailyScript)) {
  throw "Missing daily pipeline script: $dailyScript"
}

$taskName = "Export AI Agent - Daily Real Pipeline"
$time = [datetime]::ParseExact($DailyTime, "HH:mm", $null)
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$dailyScript`" -Workspace `"$Workspace`""
$trigger = New-ScheduledTaskTrigger -Daily -At $time
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Write-Host "[OK] Scheduled task installed: $taskName"
Write-Host "[OK] Daily time: $DailyTime"
Write-Host "[OK] Action script: $dailyScript"
Write-Host "[OK] Safety: task only regenerates local CRM/workbook and health report."

if ($RunOnceNow) {
  Write-Host "[OK] Running once now for verification..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File $dailyScript -Workspace $Workspace
}
