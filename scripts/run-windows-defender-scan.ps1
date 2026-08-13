param(
  [string]$Workspace = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $Workspace = (Resolve-Path -LiteralPath $Workspace).Path
}

$releaseDir = Join-Path $Workspace "installer\release"
$manifestPath = Join-Path $releaseDir "release-manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Release manifest is missing: $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (@($manifest.artifacts).Count -ne 4) { throw "Expected four Windows artifacts in the release manifest." }

$status = Get-MpComputerStatus
if (-not $status.AMServiceEnabled -or -not $status.AntivirusEnabled) {
  throw "Microsoft Defender Antivirus is not enabled on this Windows host."
}

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$reportDir = Join-Path $Workspace "outputs\windows_defender_scan"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$reportPath = Join-Path $reportDir "windows-defender-scan-$stamp.json"
$startedAt = Get-Date
$scanned = New-Object System.Collections.Generic.List[object]

foreach ($artifact in $manifest.artifacts) {
  $path = Join-Path $releaseDir $artifact.file
  if (-not (Test-Path -LiteralPath $path)) { throw "Artifact is missing: $($artifact.file)" }
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
  if ($hash -ne $artifact.sha256) { throw "Checksum mismatch before Defender scan: $($artifact.file)" }
  Write-Host "[SCAN] $($artifact.file)"
  Start-MpScan -ScanType CustomScan -ScanPath $path
  $scanned.Add([pscustomobject]@{
    file = $artifact.file
    sha256 = $hash
    scanned_at = (Get-Date -Format s)
  }) | Out-Null
}

$artifactPaths = @($manifest.artifacts | ForEach-Object { (Join-Path $releaseDir $_.file).ToLowerInvariant() })
$detections = @(
  Get-MpThreatDetection -ErrorAction SilentlyContinue | Where-Object {
    $_.InitialDetectionTime -ge $startedAt.AddMinutes(-1) -and
    @($_.Resources | Where-Object {
      $resource = ([string]$_).Replace("file:_", "").ToLowerInvariant()
      $artifactPaths -contains $resource
    }).Count -gt 0
  } | Select-Object ThreatID,ThreatStatusID,InitialDetectionTime,LastThreatStatusChangeTime,Resources
)

$finishedAt = Get-Date
$report = [pscustomobject]@{
  generated_at = ($finishedAt.ToString("s"))
  workspace = $Workspace
  release_version = $manifest.productVersion
  payload_sha256 = $manifest.payload.sha256
  engine_version = $status.AMEngineVersion
  product_version = $status.AMProductVersion
  signature_version = $status.AntivirusSignatureVersion
  signature_updated_at = if ($status.AntivirusSignatureLastUpdated) { $status.AntivirusSignatureLastUpdated.ToString("s") } else { $null }
  real_time_protection = [bool]$status.RealTimeProtectionEnabled
  started_at = $startedAt.ToString("s")
  finished_at = $finishedAt.ToString("s")
  scanned = $scanned
  detections = $detections
  passed = ($detections.Count -eq 0)
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8

if ($detections.Count -gt 0) {
  Write-Host "[FAIL] Defender reported $($detections.Count) detection(s)."
  Write-Host "[INFO] Report: $reportPath"
  exit 1
}

Write-Host "[PASS] Defender reported no detections for four release artifacts."
Write-Host "[OK] Report: $reportPath"
exit 0
