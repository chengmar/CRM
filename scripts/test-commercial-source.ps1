param(
  [string]$Workspace = "",
  [string]$SourceZip = "",
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $Workspace = (Resolve-Path -LiteralPath $Workspace).Path
}
if ([string]::IsNullOrWhiteSpace($SourceZip)) {
  $latest = Get-ChildItem -LiteralPath (Join-Path $Workspace "dist") -Filter "crm-agent-commercial-source-*.zip" -File |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { throw "Commercial source ZIP is missing." }
  $SourceZip = $latest.FullName
} else {
  $SourceZip = (Resolve-Path -LiteralPath $SourceZip).Path
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) { $OutputDir = Join-Path $Workspace "outputs\commercial_source_acceptance" }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$extractDir = Join-Path $OutputDir "source-$stamp"
$reportPath = Join-Path $OutputDir "commercial-source-acceptance-$stamp.json"
New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
Expand-Archive -LiteralPath $SourceZip -DestinationPath $extractDir -Force

$results = New-Object System.Collections.Generic.List[object]
function Invoke-Check {
  param([string]$Name, [scriptblock]$Action)
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # npm writes non-fatal deprecation warnings to stderr. Judge native steps by
    # their exit code while still retaining stderr in the acceptance report.
    $ErrorActionPreference = "Continue"
    $global:LASTEXITCODE = 0
    $output = @(& $Action 2>&1)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { throw (($output | Select-Object -Last 25) -join " | ") }
    $results.Add([pscustomobject]@{ name = $Name; status = "PASS"; detail = (($output | Select-Object -Last 8) -join " | ") }) | Out-Null
    Write-Host "[PASS] $Name"
  } catch {
    $results.Add([pscustomobject]@{ name = $Name; status = "FAIL"; detail = $_.Exception.Message }) | Out-Null
    Write-Host "[FAIL] $Name $($_.Exception.Message)"
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

function Invoke-NpmStep {
  param([string]$Name, [string[]]$Arguments)
  $stepOutput = @(& npm @Arguments 2>&1)
  $exitCode = $LASTEXITCODE
  $stepOutput | Write-Output
  if ($exitCode -ne 0) {
    throw "$Name failed with exit code $exitCode. $(($stepOutput | Select-Object -Last 25) -join ' | ')"
  }
}

$manifestPath = Join-Path $extractDir "source-manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Source manifest is missing." }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$hashErrors = @()
foreach ($entry in $manifest.files) {
  $path = Join-Path $extractDir $entry.path
  if (-not (Test-Path -LiteralPath $path)) { $hashErrors += "missing $($entry.path)"; continue }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
  if ($actual -ne $entry.sha256) { $hashErrors += "checksum $($entry.path)" }
}
if ($hashErrors.Count -eq 0) {
  $results.Add([pscustomobject]@{ name = "Source manifest"; status = "PASS"; detail = "files=$(@($manifest.files).Count)" }) | Out-Null
  Write-Host "[PASS] Source manifest"
} else {
  $results.Add([pscustomobject]@{ name = "Source manifest"; status = "FAIL"; detail = ($hashErrors -join "; ") }) | Out-Null
}

Invoke-Check "Agent clean install and tests" {
  Push-Location (Join-Path $extractDir "agent_service")
  try {
    Invoke-NpmStep "Agent npm ci" @("ci")
    Invoke-NpmStep "Agent typecheck" @("run", "typecheck")
    Invoke-NpmStep "Agent tests" @("test")
    Invoke-NpmStep "Agent build" @("run", "build")
  } finally { Pop-Location }
}
Invoke-Check "Installer clean install and tests" {
  Push-Location (Join-Path $extractDir "installer")
  try {
    Invoke-NpmStep "Installer npm ci" @("ci")
    Invoke-NpmStep "Installer typecheck" @("run", "typecheck")
    Invoke-NpmStep "Installer tests" @("test")
    Invoke-NpmStep "Installer package build" @("run", "dist:all")
  } finally { Pop-Location }
}
$releaseManifestPath = Join-Path $extractDir "installer\release\release-manifest.json"
if (Test-Path -LiteralPath $releaseManifestPath) {
  Invoke-Check "Clean-source Windows package acceptance" {
    & (Join-Path $extractDir "scripts\run-windows-package-acceptance.ps1") -Workspace $extractDir
  }
} else {
  $results.Add([pscustomobject]@{
    name = "Clean-source Windows package acceptance"
    status = "FAIL"
    detail = "Skipped because installer release manifest was not generated."
  }) | Out-Null
  Write-Host "[FAIL] Clean-source Windows package acceptance Release manifest was not generated."
}

$failed = @($results | Where-Object { $_.status -eq "FAIL" }).Count
$payloadSha256 = $null
if (Test-Path -LiteralPath $releaseManifestPath) {
  $payloadManifest = Get-Content -LiteralPath $releaseManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $payloadSha256 = $payloadManifest.payload.sha256
}
$report = [pscustomobject]@{
  generated_at = (Get-Date -Format s)
  source_zip = $SourceZip
  source_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $SourceZip).Hash.ToLowerInvariant()
  extracted_to = $extractDir
  payload_sha256 = $payloadSha256
  failed = $failed
  results = $results
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Host "[OK] Report: $reportPath"
if ($failed -gt 0) { exit 1 }
exit 0
