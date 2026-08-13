param(
  [string]$Workspace = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$mvpDir = Join-Path $Workspace "local_mvp_test_20260709"
$template = Join-Path $mvpDir "input_brief.real.template.yaml"
$target = Join-Path $mvpDir "input_brief.yaml"

if (-not (Test-Path -LiteralPath $template)) {
  throw "Template not found: $template"
}

if ((Test-Path -LiteralPath $target) -and -not $Force) {
  Write-Host "[OK] Real brief already exists: $target"
  Write-Host "Use -Force to overwrite it from the template."
  exit 0
}

Copy-Item -LiteralPath $template -Destination $target -Force
Write-Host "[OK] Created editable real brief: $target"
Write-Host "Fill this file with real company/product/market data before the next business run."
