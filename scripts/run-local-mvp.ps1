param(
  [string]$MvpDir = ".\local_mvp_test_20260709",
  [string]$Product = "Sample Product",
  [string]$Owner = "",
  [string]$RunId = "",
  [string]$OutputDir = "",
  [string]$WorkbookTitle = "",
  [string]$WorkbookName = "",
  [string]$NodePath = "C:\Users\your-user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe",
  [string]$NodeModules = "C:\Users\your-user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules"
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ([System.IO.Path]::IsPathRooted($MvpDir)) {
  $resolvedMvpDir = (Resolve-Path -LiteralPath $MvpDir).Path
} else {
  $resolvedMvpDir = (Resolve-Path -LiteralPath (Join-Path $root $MvpDir)).Path
}
$buildDir = Join-Path $root "workbook_build"
$builder = Join-Path $buildDir "build_export_leadgen_workbook.mjs"
$mvpName = Split-Path -Leaf $resolvedMvpDir

if ([string]::IsNullOrWhiteSpace($RunId)) {
  $RunId = if ($mvpName -eq "local_mvp_test_20260709") { "export_leadgen_mvp_20260709" } else { $mvpName }
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path "outputs" $RunId
}

if ([string]::IsNullOrWhiteSpace($WorkbookTitle)) {
  $WorkbookTitle = "Export Lead Generation Dashboard"
}

if ([string]::IsNullOrWhiteSpace($WorkbookName)) {
  $WorkbookName = if ($RunId -eq "export_leadgen_mvp_20260709") {
    "export_leadgen_mvp_20260709.xlsx"
  } else {
    "$RunId.xlsx"
  }
}

if (-not (Test-Path -LiteralPath $NodePath)) {
  $fallbackNode = Get-Command node -ErrorAction SilentlyContinue
  if (-not $fallbackNode) {
    throw "Node.js not found. Expected bundled node at $NodePath"
  }
  $NodePath = $fallbackNode.Source
}

if (-not (Test-Path -LiteralPath $builder)) {
  throw "Workbook builder missing: $builder"
}

New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
$junction = Join-Path $buildDir "node_modules"
if (-not (Test-Path -LiteralPath $NodeModules)) {
  if (Test-Path -LiteralPath $junction) {
    $NodeModules = (Resolve-Path -LiteralPath $junction).Path
  } else {
    throw "Node modules not found. Expected bundled path '$NodeModules' or packaged path '$junction'."
  }
}

if (-not (Test-Path -LiteralPath $junction)) {
  if ($IsWindows -or $null -eq $IsWindows) {
    New-Item -ItemType Junction -Path $junction -Target $NodeModules | Out-Null
  } else {
    New-Item -ItemType SymbolicLink -Path $junction -Target $NodeModules | Out-Null
  }
}

Write-Host "== Export leads to CRM CSV =="
$exportArgs = @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  (Join-Path $root "scripts\export-leads-to-crm.ps1"),
  "-MvpDir",
  $resolvedMvpDir,
  "-Product",
  $Product
)
if (-not [string]::IsNullOrWhiteSpace($Owner)) {
  $exportArgs += @("-Owner", $Owner)
}
& powershell @exportArgs
if ($LASTEXITCODE -ne 0) {
  throw "export-leads-to-crm.ps1 failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "== Build outbound review messages =="
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\build-outbound-messages.ps1") `
  -Workspace $root `
  -MvpDir $resolvedMvpDir `
  -Product $Product
if ($LASTEXITCODE -ne 0) {
  throw "build-outbound-messages.ps1 failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "== Validate local MVP data =="
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\validate-local-mvp.ps1") `
  -MvpDir $resolvedMvpDir
if ($LASTEXITCODE -ne 0) {
  throw "validate-local-mvp.ps1 failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "== Build Excel workbook =="
$builderArgs = @(
  $builder,
  "--mvp-dir=$resolvedMvpDir",
  "--run-id=$RunId",
  "--output-dir=$OutputDir",
  "--title=$WorkbookTitle",
  "--workbook-name=$WorkbookName"
)
& $NodePath @builderArgs
if ($LASTEXITCODE -ne 0) {
  throw "workbook builder failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "[OK] Local MVP run complete."
Write-Host "[OK] Workbook: $(Join-Path (Join-Path $root $OutputDir) $WorkbookName)"
