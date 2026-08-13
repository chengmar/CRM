param(
  [string]$Workspace = "",
  [switch]$AllowFeishuTestWrite
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$results = New-Object System.Collections.Generic.List[object]
$startedAt = Get-Date
$reportDir = Join-Path $Workspace "outputs\vps_acceptance"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$reportPath = Join-Path $reportDir ("vps-acceptance-" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".json")

function Add-Result {
  param(
    [string]$Name,
    [string]$Status,
    [string]$Detail,
    [int]$ExitCode = 0
  )
  $safe = $Detail -replace 'sk-[A-Za-z0-9_-]{12,}', 'sk-REDACTED'
  $safe = $safe -replace '(?i)(password|secret|token|api_key|access_token)\s*[:=]\s*[^,\s;]+', '$1=REDACTED'
  $results.Add([pscustomobject]@{ name = $Name; status = $Status; exit_code = $ExitCode; detail = $safe }) | Out-Null
  $tag = if ($Status -eq "PASS") { "[PASS]" } elseif ($Status -eq "WARN") { "[WARN]" } else { "[FAIL]" }
  Write-Host "$tag $Name $safe"
}

function Invoke-CheckedCommand {
  param(
    [string]$Name,
    [string]$Command,
    [int[]]$AllowedExitCodes = @(0),
    [switch]$WarningOnly
  )
  Write-Host ""
  Write-Host "== $Name =="
  $output = & powershell -NoProfile -ExecutionPolicy Bypass -Command $Command 2>&1
  $exitCode = $LASTEXITCODE
  $text = (($output | ForEach-Object { [string]$_ }) -join "`n")
  if ($text.Length -gt 4000) { $text = $text.Substring($text.Length - 4000) }
  $tail = (($text | Select-String -Pattern '.' | Select-Object -Last 10 | ForEach-Object { $_.Line }) -join " | ")
  if ($AllowedExitCodes -contains $exitCode) {
    Add-Result $Name "PASS" $tail $exitCode
  } elseif ($WarningOnly) {
    Add-Result $Name "WARN" $tail $exitCode
  } else {
    Add-Result $Name "FAIL" $tail $exitCode
  }
}

function Test-CommandExists {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) {
    Add-Result "Command $Name" "PASS" $cmd.Source
  } else {
    Add-Result "Command $Name" "FAIL" "missing"
  }
}

Write-Host "== VPS production acceptance =="
Write-Host "Workspace: $Workspace"
Write-Host "Started: $($startedAt.ToString('s'))"
Write-Host "External writes: disabled unless explicitly enabled and confirmed"

foreach ($cmd in @("pwsh", "powershell", "node", "curl", "git", "unzip")) {
  Test-CommandExists $cmd
}
Test-CommandExists "hermes"
Test-CommandExists "openclaw"

Invoke-CheckedCommand `
  -Name "Agent product service tests" `
  -Command "& '$Workspace/scripts/run-agent-product-acceptance.ps1' -Workspace '$Workspace'"

Invoke-CheckedCommand `
  -Name "Agent systemd service" `
  -Command "bash -lc 'systemctl is-active export-ai-agent-service && systemctl is-enabled export-ai-agent-backup.timer && curl -fsS http://127.0.0.1:18790/health'"

Invoke-CheckedCommand `
  -Name "Agent restart persistence" `
  -Command "& '$Workspace/scripts/test-agent-service-persistence.ps1' -Workspace '$Workspace'"

$envText = if (Test-Path -LiteralPath (Join-Path $Workspace ".env")) {
  Get-Content -LiteralPath (Join-Path $Workspace ".env") -Raw -Encoding UTF8
} else {
  ""
}
$bitableConfigured = $envText -match '(?m)^FEISHU_BITABLE_APP_TOKEN=.+$' -and
  $envText -match '(?m)^FEISHU_BITABLE_LEADS_TABLE_ID=.+$' -and
  $envText -match '(?m)^FEISHU_BITABLE_EVENTS_TABLE_ID=.+$'
if ($bitableConfigured) {
  Invoke-CheckedCommand `
    -Name "Feishu Bitable schema" `
    -Command "Push-Location '$Workspace/agent_service'; try { `$env:NODE_NO_WARNINGS='1'; node dist/cli.js validate-bitable } finally { Pop-Location }"
} else {
  Add-Result "Feishu Bitable schema" "WARN" "not configured"
}

Invoke-CheckedCommand `
  -Name "Company brief validation" `
  -Command "& '$Workspace/scripts/validate-real-brief.ps1' -BriefPath '$Workspace/product_data/input_brief.yaml'"

Invoke-CheckedCommand `
  -Name "Real commercial pipeline" `
  -Command "& '$Workspace/scripts/run-real-commercial-pipeline.ps1'"

Invoke-CheckedCommand `
  -Name "Local data validation" `
  -Command "& '$Workspace/scripts/validate-local-mvp.ps1' -MvpDir '$Workspace/product_data'"

Invoke-CheckedCommand `
  -Name "CRM state preservation" `
  -Command "& '$Workspace/scripts/test-crm-state-preservation.ps1' -Workspace '$Workspace'"

Invoke-CheckedCommand `
  -Name "Feishu CRM read-only sync plan" `
  -Command "& '$Workspace/scripts/sync-feishu-crm.ps1' -Workspace '$Workspace' -Mode Plan" `
  -WarningOnly

Invoke-CheckedCommand `
  -Name "Outbound readiness" `
  -Command "& '$Workspace/scripts/check-outbound-readiness.ps1' -Workspace '$Workspace'"

Invoke-CheckedCommand `
  -Name "Commercial launch input report" `
  -Command "& '$Workspace/scripts/validate-commercial-launch-inputs.ps1' -Workspace '$Workspace'"

Invoke-CheckedCommand `
  -Name "Outbound dispatch plan" `
  -Command "& '$Workspace/scripts/invoke-outbound-dispatch.ps1' -Workspace '$Workspace' -Mode Plan"

Invoke-CheckedCommand `
  -Name "Email send safety refusal" `
  -Command "& '$Workspace/scripts/invoke-outbound-dispatch.ps1' -Workspace '$Workspace' -Mode SendEmail" `
  -AllowedExitCodes @(1)

Invoke-CheckedCommand `
  -Name "WhatsApp send safety refusal" `
  -Command "& '$Workspace/scripts/invoke-outbound-dispatch.ps1' -Workspace '$Workspace' -Mode SendWhatsAppTemplate" `
  -AllowedExitCodes @(1)

if ($bitableConfigured) {
  Add-Result "Legacy Feishu Sheets write test" "PASS" "not required; production Bitable schema was validated through the official API"
} elseif ($AllowFeishuTestWrite) {
  Invoke-CheckedCommand `
    -Name "Feishu one-row write test" `
    -Command "& '$Workspace/scripts/sync-feishu-crm.ps1' -Workspace '$Workspace' -Mode AppendTest -ConfirmWrite"
} else {
  Add-Result "Feishu one-row write test" "WARN" "skipped; requires explicit user approval"
}

Invoke-CheckedCommand `
  -Name "Production state backup" `
  -Command "& '$Workspace/scripts/backup-production-state.ps1' -Workspace '$Workspace' -Reason 'vps-acceptance'"

$endedAt = Get-Date
$failed = @($results | Where-Object { $_.status -eq "FAIL" }).Count
$warnings = @($results | Where-Object { $_.status -eq "WARN" }).Count
$summary = [pscustomobject]@{
  started_at = $startedAt.ToString("s")
  ended_at = $endedAt.ToString("s")
  workspace = $Workspace
  failed = $failed
  warnings = $warnings
  results = $results
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Host ""
Write-Host "== VPS acceptance summary =="
Write-Host "Failed: $failed"
Write-Host "Warnings: $warnings"
Write-Host "[OK] Report: $reportPath"

if ($failed -gt 0) { exit 1 }
exit 0
