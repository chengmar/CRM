param(
  [string]$Workspace = ""
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

Write-Host "== Hermes local readiness check =="
Write-Host "Workspace: $Workspace"
Write-Host ""

$commands = @("git", "curl", "node", "python", "docker", "wsl", "hermes", "openclaw")
foreach ($cmd in $commands) {
  $found = Get-Command $cmd -ErrorAction SilentlyContinue
  if ($found) {
    Write-Host "[OK] $cmd -> $($found.Source)"
  } else {
    Write-Host "[MISS] $cmd"
  }
}

Write-Host ""
Write-Host "== Hermes =="
$hermes = Get-Command hermes -ErrorAction SilentlyContinue
if ($hermes) {
  hermes --version 2>$null
  hermes doctor 2>$null
} else {
  Write-Host "[MISS] hermes command is not installed."
  Write-Host "[NEXT] Install only after explicit approval:"
  Write-Host "       iex (irm https://hermes-agent.nousresearch.com/install.ps1)"
}

Write-Host ""
Write-Host "== OpenClaw local status =="
$openclaw = Get-Command openclaw -ErrorAction SilentlyContinue
if ($openclaw) {
  openclaw status 2>$null
} else {
  Write-Host "[MISS] openclaw command is not installed."
}

Write-Host ""
Write-Host "== OpenClaw gateway health =="
try {
  $health = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:18789/health -TimeoutSec 3
  Write-Host "[OK] OpenClaw gateway health: $($health.StatusCode)"
} catch {
  Write-Host "[WARN] OpenClaw gateway is not reachable at http://127.0.0.1:18789/health"
}

Write-Host ""
Write-Host "== Local MVP files =="
$required = @(
  "local_mvp_test_20260709\leads.csv",
  "local_mvp_test_20260709\crm_import.csv",
  "local_mvp_test_20260709\contacts_enrichment.csv",
  "local_mvp_test_20260709\procurement_contact_validation.csv",
  "local_mvp_test_20260709\manual_verification_queue.csv",
  "outputs\export_leadgen_mvp_20260709\export_leadgen_mvp_20260709.xlsx",
  "dist\export-ai-skills-20260709.zip"
)

foreach ($rel in $required) {
  $path = Join-Path $Workspace $rel
  if (Test-Path -LiteralPath $path) {
    Write-Host "[OK] $rel"
  } else {
    Write-Host "[MISS] $rel"
  }
}

Write-Host ""
Write-Host "== Reminder =="
Write-Host "This script is read-only. It does not install Hermes, start gateways, configure Feishu, or send messages."
