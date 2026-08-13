param(
  [string]$MvpDir = ".\product_data",
  [string]$Product = "sample product line",
  [string]$Owner = "",
  [string]$RunId = "product_launch",
  [switch]$RunAgentSmoke
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$resolvedMvpDir = if ([System.IO.Path]::IsPathRooted($MvpDir)) {
  (Resolve-Path -LiteralPath $MvpDir).Path
} else {
  (Resolve-Path -LiteralPath (Join-Path $root $MvpDir)).Path
}

Write-Host "== Real commercial pipeline: $Product =="
Write-Host "Workspace: $root"
Write-Host "Input: $resolvedMvpDir"
Write-Host "Safety: no external sending, no Feishu write"
Write-Host ""

$briefPath = Join-Path $resolvedMvpDir "input_brief.yaml"
if ([string]::IsNullOrWhiteSpace($Owner) -and (Test-Path -LiteralPath $briefPath)) {
  $briefText = Get-Content -LiteralPath $briefPath -Raw -Encoding UTF8
  $ownerMatch = [regex]::Match($briefText, '(?m)^\s{2}owner:\s*"?([^"\r\n]+)"?\s*$')
  if ($ownerMatch.Success) {
    $Owner = $ownerMatch.Groups[1].Value.Trim()
  }
}

$runArgs = @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  (Join-Path $root "scripts\run-local-mvp.ps1"),
  "-MvpDir",
  $resolvedMvpDir,
  "-Product",
  $Product,
  "-RunId",
  $RunId,
  "-OutputDir",
  (Join-Path "outputs" $RunId),
  "-WorkbookTitle",
  "$Product Commercial Lead Generation Dashboard",
  "-WorkbookName",
  "commercial_leadgen.xlsx"
)
if (-not [string]::IsNullOrWhiteSpace($Owner)) {
  $runArgs += @("-Owner", $Owner)
}
& powershell @runArgs
if ($LASTEXITCODE -ne 0) {
  throw "run-local-mvp.ps1 failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "== Company brief readiness =="
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\validate-real-brief.ps1") `
  -BriefPath $briefPath `
  -AllowPlaceholder
if ($LASTEXITCODE -ne 0) {
  Write-Host "[WARN] Company identity/commercial fields are still incomplete. This blocks real outreach, not local CRM/workbook generation."
}

if ($RunAgentSmoke) {
  Write-Host ""
  Write-Host "== Agent read-only smoke tests =="
  $prompt = "Read-only task. Do not write files, do not send external messages, and do not write Feishu. Workspace: $root. Read relative paths product_data/test_report.md, product_data/crm_import.csv, and product_data/manual_verification_queue.csv. Output only product direction, total leads/SILVER/BRONZE/GOLD, and whether sending is allowed."

  $hermesExe = "C:\Users\your-user\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe"
  if (Test-Path -LiteralPath $hermesExe) {
    & $hermesExe -z $prompt
  } else {
    Write-Host "[WARN] Hermes executable not found; skipped."
  }

  openclaw agent --agent export-local-test --session-key "agent:export-local-test:product-launch-smoke" --message $prompt --json --timeout 300
}

Write-Host ""
Write-Host "[OK] Real commercial pipeline complete."
$crmPath = Join-Path $resolvedMvpDir "crm_import.csv"
$workbookDir = Join-Path $root (Join-Path "outputs" $RunId)
$workbookPath = Join-Path $workbookDir "commercial_leadgen.xlsx"
Write-Host "[OK] CRM: $crmPath"
Write-Host "[OK] Workbook: $workbookPath"
Write-Host "[OK] External sending remains disabled."

exit 0
