param(
  [string]$Workspace = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $Workspace = (Resolve-Path -LiteralPath $Workspace).Path
}

$results = New-Object System.Collections.Generic.List[object]
function Add-Requirement {
  param([string]$Area, [string]$Requirement, [string]$Status, [string]$Detail, [string]$Evidence = "")
  $results.Add([pscustomobject]@{
    area = $Area
    requirement = $Requirement
    status = $Status
    detail = $Detail
    evidence = $Evidence
  }) | Out-Null
  Write-Host "[$Status] $Area - $Requirement - $Detail"
}

function Get-JsonFiles {
  param([string]$Directory)
  if (-not (Test-Path -LiteralPath $Directory)) { return @() }
  return @(Get-ChildItem -LiteralPath $Directory -Filter "*.json" -File | Sort-Object LastWriteTime -Descending)
}

function Read-Json {
  param([System.IO.FileInfo]$File)
  try { return Get-Content -LiteralPath $File.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

$releaseDir = Join-Path $Workspace "installer\release"
$manifestPath = Join-Path $releaseDir "release-manifest.json"
$manifest = $null
if (Test-Path -LiteralPath $manifestPath) {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

if ($manifest -and @($manifest.artifacts).Count -eq 4) {
  $hashErrors = New-Object System.Collections.Generic.List[string]
  foreach ($artifact in $manifest.artifacts) {
    $path = Join-Path $releaseDir $artifact.file
    if (-not (Test-Path -LiteralPath $path)) {
      $hashErrors.Add("missing $($artifact.file)") | Out-Null
      continue
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    if ($actual -ne $artifact.sha256) { $hashErrors.Add("checksum $($artifact.file)") | Out-Null }
  }
  if ($hashErrors.Count -eq 0) {
    Add-Requirement "Artifacts" "Four architecture/distribution packages match the release manifest" "VERIFIED" "version=$($manifest.productVersion); payload=$($manifest.payload.sha256)" $manifestPath
  } else {
    Add-Requirement "Artifacts" "Four architecture/distribution packages match the release manifest" "BLOCKED" ($hashErrors -join "; ") $manifestPath
  }
} else {
  Add-Requirement "Artifacts" "Four architecture/distribution packages match the release manifest" "BLOCKED" "release manifest missing or invalid" $manifestPath
}

$sourceAcceptanceFiles = Get-JsonFiles (Join-Path $Workspace "outputs\commercial_source_acceptance")
$sourceAcceptanceFile = $sourceAcceptanceFiles | Where-Object { $_.Name -like "commercial-source-acceptance-*.json" } | Select-Object -First 1
$sourceAcceptance = if ($sourceAcceptanceFile) { Read-Json $sourceAcceptanceFile } else { $null }
$sourceZipHashMatches = $false
if ($sourceAcceptance -and -not [string]::IsNullOrWhiteSpace([string]$sourceAcceptance.source_zip) -and
    (Test-Path -LiteralPath ([string]$sourceAcceptance.source_zip))) {
  $actualSourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath ([string]$sourceAcceptance.source_zip)).Hash.ToLowerInvariant()
  $sourceZipHashMatches = $actualSourceHash -eq ([string]$sourceAcceptance.source_sha256).ToLowerInvariant()
}
$sourceChecksPass = $sourceAcceptance -and @($sourceAcceptance.results | Where-Object { $_.status -ne "PASS" }).Count -eq 0
if ($sourceAcceptance -and [int]$sourceAcceptance.failed -eq 0 -and $sourceChecksPass -and
    $sourceZipHashMatches -and $manifest -and $sourceAcceptance.payload_sha256 -eq $manifest.payload.sha256) {
  Add-Requirement "Commercial source" "Sanitized source ZIP clean-builds the exact release payload" "VERIFIED" "source=$($sourceAcceptance.source_sha256); payload=$($sourceAcceptance.payload_sha256)" $sourceAcceptanceFile.FullName
} else {
  Add-Requirement "Commercial source" "Sanitized source ZIP clean-builds the exact release payload" "BLOCKED" "source acceptance missing, failed, checksum-mismatched, or built a different payload" $(if ($sourceAcceptanceFile) { $sourceAcceptanceFile.FullName } else { "" })
}

$version = if ($manifest) { [string]$manifest.productVersion } else { "" }
if ($version -and $version -ne "0.1.0") {
  Add-Requirement "Release identity" "Commercial version number is finalized" "VERIFIED" "version=$version" $manifestPath
} else {
  Add-Requirement "Release identity" "Commercial version number is finalized" "PENDING" "0.1.0 remains a development version; bump only after external acceptance" $manifestPath
}

$packageReports = Get-JsonFiles (Join-Path $Workspace "outputs\windows_package_acceptance")
$developmentReportFile = $null
$developmentReport = $null
$commercialReportFile = $null
$commercialReport = $null
foreach ($file in $packageReports) {
  $json = Read-Json $file
  if (-not $json) { continue }
  if (-not $developmentReport -and -not [bool]$json.signature_required) { $developmentReport = $json; $developmentReportFile = $file }
  if (-not $commercialReport -and [bool]$json.signature_required) { $commercialReport = $json; $commercialReportFile = $file }
}
if ($developmentReport -and [int]$developmentReport.failed -eq 0 -and $developmentReport.payload_sha256 -eq $manifest.payload.sha256) {
  Add-Requirement "Windows package" "Setup, Portable, DPAPI, IPC, payload, install and uninstall pass" "VERIFIED" "warnings=$($developmentReport.warnings)" $developmentReportFile.FullName
} else {
  Add-Requirement "Windows package" "Setup, Portable, DPAPI, IPC, payload, install and uninstall pass" "BLOCKED" "no passing package acceptance report" $(if ($developmentReportFile) { $developmentReportFile.FullName } else { "" })
}

$packageSmokeFiles = Get-JsonFiles (Join-Path $Workspace "outputs\package_smoke")
$packageSmokeFile = $packageSmokeFiles | Select-Object -First 1
$packageSmoke = if ($packageSmokeFile) { Read-Json $packageSmokeFile } else { $null }
if ($packageSmoke -and [int]$packageSmoke.blocked -eq 0 -and $packageSmoke.package_sha256 -eq $manifest.payload.sha256) {
  Add-Requirement "Deployment package" "Embedded generic deployment ZIP passes isolated extraction smoke" "VERIFIED" "warnings=$($packageSmoke.warnings); payload=$($packageSmoke.package_sha256)" $packageSmokeFile.FullName
} else {
  Add-Requirement "Deployment package" "Embedded generic deployment ZIP passes isolated extraction smoke" "BLOCKED" "missing, blocked, or payload hash does not match the installer manifest" $(if ($packageSmokeFile) { $packageSmokeFile.FullName } else { "" })
}
if ($commercialReport -and [bool]$commercialReport.commercial_release_eligible -and [int]$commercialReport.failed -eq 0 -and $commercialReport.payload_sha256 -eq $manifest.payload.sha256) {
  Add-Requirement "Code signing" "Clean-runner commercial acceptance and all Authenticode checks pass" "VERIFIED" "warnings=$($commercialReport.warnings)" $commercialReportFile.FullName
} else {
  $detail = if ($commercialReport) { "failed=$($commercialReport.failed); eligible=$($commercialReport.commercial_release_eligible)" } else { "commercial acceptance report missing" }
  Add-Requirement "Code signing" "Clean-runner commercial acceptance and all Authenticode checks pass" "BLOCKED" $detail $(if ($commercialReportFile) { $commercialReportFile.FullName } else { "" })
}

$defenderFiles = Get-JsonFiles (Join-Path $Workspace "outputs\windows_defender_scan")
$defenderFile = $defenderFiles | Select-Object -First 1
$defender = if ($defenderFile) { Read-Json $defenderFile } else { $null }
$defenderHashesMatch = $false
if ($defender -and $manifest) {
  $defenderHashesMatch = @($manifest.artifacts | Where-Object {
    $expected = $_
    -not @($defender.scanned | Where-Object { $_.file -eq $expected.file -and $_.sha256 -eq $expected.sha256 }).Count
  }).Count -eq 0
}
if ($defender -and [bool]$defender.passed -and @($defender.scanned).Count -eq 4 -and $defenderHashesMatch) {
  Add-Requirement "Malware scan" "Microsoft Defender reports no detections for all four artifacts" "VERIFIED" "signature=$($defender.signature_version)" $defenderFile.FullName
} else {
  Add-Requirement "Malware scan" "Microsoft Defender reports no detections for all four artifacts" "PENDING" "scan report missing, incomplete, or contains detections" $(if ($defenderFile) { $defenderFile.FullName } else { "" })
}

$compatibilityFiles = Get-JsonFiles (Join-Path $Workspace "outputs\windows_compatibility_acceptance")
$compatibility = @()
foreach ($file in $compatibilityFiles) {
  $json = Read-Json $file
  if ($json) { $compatibility += [pscustomobject]@{ file = $file; report = $json } }
}
foreach ($serverVersion in @("2022", "2025")) {
  $match = $compatibility | Where-Object { [int]$_.report.failed -eq 0 -and $_.report.payload_sha256 -eq $manifest.payload.sha256 -and [string]$_.report.os_caption -match "Windows Server $serverVersion" } | Select-Object -First 1
  if ($match) {
    Add-Requirement "Windows compatibility" "Windows Server $serverVersion Setup and Portable acceptance passes" "VERIFIED" "build=$($match.report.os_build)" $match.file.FullName
  } else {
    Add-Requirement "Windows compatibility" "Windows Server $serverVersion Setup and Portable acceptance passes" "PENDING" "run the GitHub Actions compatibility matrix and retain its report"
  }
}
$armMatch = $compatibility | Where-Object { $_.report.architecture -eq "arm64" -and $_.report.host_architecture -eq "arm64" -and $_.report.payload_sha256 -eq $manifest.payload.sha256 -and [int]$_.report.failed -eq 0 } | Select-Object -First 1
if ($armMatch) {
  Add-Requirement "Windows ARM64" "Native Windows ARM64 Setup and Portable acceptance passes" "VERIFIED" "build=$($armMatch.report.os_build)" $armMatch.file.FullName
} else {
  Add-Requirement "Windows ARM64" "Native Windows ARM64 Setup and Portable acceptance passes" "PENDING" "run run-windows-compatibility-acceptance.ps1 -Architecture arm64 on native Windows ARM64"
}

$freshFiles = Get-JsonFiles (Join-Path $Workspace "outputs\fresh_install_acceptance")
$freshMatch = $null
foreach ($file in $freshFiles) {
  $json = Read-Json $file
  if ($json -and [bool]$json.clean_server_declared -and [int]$json.failed -eq 0) {
    $freshMatch = [pscustomobject]@{ file = $file; report = $json }
    break
  }
}
if ($freshMatch) {
  Add-Requirement "Ubuntu VPS" "Clean Ubuntu 22.04/24.04 installation acceptance passes" "VERIFIED" "passed=$($freshMatch.report.passed); outbound_enabled=$($freshMatch.report.outbound_enabled)" $freshMatch.file.FullName
} else {
  Add-Requirement "Ubuntu VPS" "Clean Ubuntu 22.04/24.04 installation acceptance passes" "PENDING" "run fresh-install acceptance with -CleanServer on a disposable clean VPS and copy the report back"
}

$remoteNames = @(& git -C $Workspace remote)
$origin = if ($remoteNames -contains "origin") { (& git -C $Workspace remote get-url origin) } else { "" }
if (-not [string]::IsNullOrWhiteSpace($origin)) {
  Add-Requirement "GitHub" "Repository remote is configured for clean CI builds" "VERIFIED" $origin
} else {
  Add-Requirement "GitHub" "Repository remote is configured for clean CI builds" "PENDING" "user-approved private GitHub repository is not configured"
}

$guidePath = Join-Path $releaseDir "WINDOWS_INSTALLER_USER_GUIDE.md"
if (Test-Path -LiteralPath $guidePath) {
  Add-Requirement "Delivery" "Customer installation guide is included with release artifacts" "VERIFIED" "included" $guidePath
} else {
  Add-Requirement "Delivery" "Customer installation guide is included with release artifacts" "BLOCKED" "guide missing from release directory" $guidePath
}

$blocked = @($results | Where-Object { $_.status -eq "BLOCKED" }).Count
$pending = @($results | Where-Object { $_.status -eq "PENDING" }).Count
$verified = @($results | Where-Object { $_.status -eq "VERIFIED" }).Count
$state = if ($blocked -eq 0 -and $pending -eq 0) { "COMMERCIAL_RELEASE_READY" } else { "NOT_READY" }
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$outputDir = Join-Path $Workspace "outputs\commercial_installer_release"
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$jsonPath = Join-Path $outputDir "commercial-installer-release-$stamp.json"
$mdPath = Join-Path $outputDir "commercial-installer-release-$stamp.md"
$report = [pscustomobject]@{
  generated_at = (Get-Date -Format s)
  workspace = $Workspace
  state = $state
  verified = $verified
  blocked = $blocked
  pending = $pending
  requirements = $results
}
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# Commercial Installer Release Audit") | Out-Null
$lines.Add("") | Out-Null
$lines.Add("- State: $state") | Out-Null
$lines.Add("- Verified: $verified") | Out-Null
$lines.Add("- Blocked: $blocked") | Out-Null
$lines.Add("- Pending: $pending") | Out-Null
$lines.Add("") | Out-Null
foreach ($item in $results) {
  $lines.Add("- [$($item.status)] $($item.area): $($item.requirement) - $($item.detail)") | Out-Null
}
$lines | Set-Content -LiteralPath $mdPath -Encoding UTF8

Write-Host "[SUMMARY] state=$state verified=$verified blocked=$blocked pending=$pending"
Write-Host "[OK] JSON: $jsonPath"
Write-Host "[OK] Markdown: $mdPath"
if ($state -ne "COMMERCIAL_RELEASE_READY") { exit 1 }
exit 0
