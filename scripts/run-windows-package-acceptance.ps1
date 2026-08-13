param(
  [string]$Workspace = "",
  [switch]$RequireSignature,
  [switch]$RequireCleanWindowsVm
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $Workspace = (Resolve-Path -LiteralPath $Workspace).Path
}

$installerDir = Join-Path $Workspace "installer"
$releaseDir = Join-Path $installerDir "release"
$manifestPath = Join-Path $releaseDir "release-manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Release manifest is missing: $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$reportDir = Join-Path $Workspace "outputs\windows_package_acceptance"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$reportPath = Join-Path $reportDir "windows-package-acceptance-$stamp.json"
$tempBase = (Resolve-Path -LiteralPath $env:TEMP).Path
$runRoot = Join-Path $tempBase "crm-agent-package-acceptance-$stamp-$PID"
New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
$runRoot = (Resolve-Path -LiteralPath $runRoot).Path
if (-not $runRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Acceptance run directory escapes the Windows temp directory."
}

$results = New-Object System.Collections.Generic.List[object]
function Add-Result {
  param([string]$Name, [string]$Status, [string]$Detail)
  $results.Add([pscustomobject]@{ name = $Name; status = $Status; detail = $Detail }) | Out-Null
  Write-Host "[$Status] $Name $Detail"
}

function Get-PeArchitecture {
  param([string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  $reader = New-Object System.IO.BinaryReader($stream)
  try {
    $stream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw "Invalid PE signature: $Path" }
    $machine = $reader.ReadUInt16()
    if ($machine -eq 0x8664) { return "x64" }
    if ($machine -eq 0xAA64) { return "arm64" }
    if ($machine -eq 0x014c) { return "x86" }
    return ("unknown-0x{0:X4}" -f $machine)
  } finally {
    $reader.Dispose()
    $stream.Dispose()
  }
}

function Add-SignatureResult {
  param([string]$Path, [string]$Name)
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -eq "Valid") {
    $subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { "unknown signer" }
    Add-Result "Signature $Name" "PASS" "Authenticode valid; signer=$subject"
    return
  }
  $status = if ($RequireSignature) { "FAIL" } else { "WARN" }
  Add-Result "Signature $Name" $status "Authenticode status=$($signature.Status); a valid signature is mandatory for commercial release"
}

function Invoke-InstallerSelfTest {
  param([string]$Executable, [string]$Name, [string]$DataDir)
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $stdout = Join-Path $DataDir "stdout.log"
  $stderr = Join-Path $DataDir "stderr.log"
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $Executable
  $start.Arguments = "--installer-self-test"
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.EnvironmentVariables["CRM_INSTALLER_SELF_TEST_DIR"] = $DataDir
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  [void]$process.Start()
  $outTask = $process.StandardOutput.ReadToEndAsync()
  $errTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(120000)) {
    $process.Kill()
    throw "$Name timed out."
  }
  $outTask.Result | Set-Content -LiteralPath $stdout -Encoding UTF8
  $errTask.Result | Set-Content -LiteralPath $stderr -Encoding UTF8
  if ($process.ExitCode -ne 0) { throw "$Name failed with exit code $($process.ExitCode): $($errTask.Result)" }
  $selfReportPath = Join-Path $DataDir "self-test-report.json"
  if (-not (Test-Path -LiteralPath $selfReportPath)) { throw "$Name did not write a self-test report." }
  $selfReport = Get-Content -LiteralPath $selfReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $selfReport.ok -or -not $selfReport.safeStorage -or -not $selfReport.renderer.ipc) {
    throw "$Name self-test contract failed."
  }
  Add-Result $Name "PASS" "arch=$($selfReport.architecture); payload=$($selfReport.payload.sha256)"
}

try {
  $cleanWindowsVm = $env:GITHUB_ACTIONS -eq "true"
  if ($RequireCleanWindowsVm -and -not $cleanWindowsVm) {
    Add-Result "Clean Windows runner" "FAIL" "Commercial acceptance must run on an isolated GitHub-hosted Windows runner."
  } elseif ($cleanWindowsVm) {
    Add-Result "Clean Windows runner" "PASS" "GitHub-hosted Windows runner detected."
  }

  foreach ($artifact in $manifest.artifacts) {
    $path = Join-Path $releaseDir $artifact.file
    if (-not (Test-Path -LiteralPath $path)) { throw "Artifact is missing: $($artifact.file)" }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    if ($hash -ne $artifact.sha256) { throw "Checksum mismatch: $($artifact.file)" }
    $peArch = Get-PeArchitecture $path
    if ($peArch -notin @("x86", $artifact.architecture)) {
      throw "Unexpected NSIS wrapper architecture for $($artifact.file): $peArch"
    }
    Add-Result "Artifact $($artifact.file)" "PASS" "sha256=$hash; launcher_pe=$peArch; target=$($artifact.architecture)"
    Add-SignatureResult $path $artifact.file
  }

  $unpacked = Join-Path $releaseDir "win-unpacked\CRM Agent Installer.exe"
  if ((Get-PeArchitecture $unpacked) -ne "x64") { throw "Unpacked x64 application has the wrong PE architecture." }
  $armUnpacked = Join-Path $releaseDir "win-arm64-unpacked\CRM Agent Installer.exe"
  if ((Get-PeArchitecture $armUnpacked) -ne "arm64") { throw "Unpacked ARM64 application has the wrong PE architecture." }
  Add-Result "Unpacked application architectures" "PASS" "x64 and arm64 payloads verified"
  Add-SignatureResult $unpacked "x64 unpacked application"
  Add-SignatureResult $armUnpacked "arm64 unpacked application"
  Invoke-InstallerSelfTest $unpacked "x64 unpacked app" (Join-Path $runRoot "unpacked-user-data")

  $portable = Join-Path $releaseDir "CRM Agent Installer-$($manifest.productVersion)-x64-Portable.exe"
  Invoke-InstallerSelfTest $portable "x64 portable app" (Join-Path $runRoot "portable-user-data")

  $setup = Join-Path $releaseDir "CRM Agent Installer-$($manifest.productVersion)-x64-Setup.exe"
  $installDir = Join-Path $runRoot "installed"
  $install = Start-Process -FilePath $setup -ArgumentList @("/S", "/D=$installDir") -PassThru -Wait
  if ($install.ExitCode -ne 0) { throw "Silent NSIS installation failed with exit code $($install.ExitCode)." }
  $installedExe = Join-Path $installDir "CRM Agent Installer.exe"
  if (-not (Test-Path -LiteralPath $installedExe)) { throw "Installed application is missing: $installedExe" }
  Add-SignatureResult $installedExe "x64 installed application"
  Invoke-InstallerSelfTest $installedExe "x64 installed app" (Join-Path $runRoot "installed-user-data")

  $uninstaller = Get-ChildItem -LiteralPath $installDir -Filter "Uninstall*.exe" -File | Select-Object -First 1
  if (-not $uninstaller) { throw "NSIS uninstaller was not created." }
  Add-SignatureResult $uninstaller.FullName "x64 uninstaller"
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -PassThru -Wait
  if ($uninstall.ExitCode -ne 0) { throw "Silent NSIS uninstall failed with exit code $($uninstall.ExitCode)." }
  Add-Result "x64 NSIS install and uninstall" "PASS" "isolated_install_dir=$installDir"
} catch {
  Add-Result "Acceptance execution" "FAIL" $_.Exception.Message
}

$failed = @($results | Where-Object { $_.status -eq "FAIL" }).Count
$warnings = @($results | Where-Object { $_.status -eq "WARN" }).Count
$report = [pscustomobject]@{
  generated_at = (Get-Date -Format s)
  workspace = $Workspace
  release_version = $manifest.productVersion
  payload_sha256 = $manifest.payload.sha256
  release_manifest_generated_at = $manifest.generatedAt
  clean_user_data = $true
  clean_windows_vm = ($env:GITHUB_ACTIONS -eq "true")
  signature_required = [bool]$RequireSignature
  clean_windows_vm_required = [bool]$RequireCleanWindowsVm
  commercial_release_eligible = ([bool]$RequireSignature -and [bool]$RequireCleanWindowsVm -and $failed -eq 0 -and $warnings -eq 0)
  failed = $failed
  warnings = $warnings
  results = $results
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8

if (Test-Path -LiteralPath $runRoot) {
  $resolvedRunRoot = (Resolve-Path -LiteralPath $runRoot).Path
  if (-not $resolvedRunRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove acceptance data outside the Windows temp directory."
  }
  Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force
}

Write-Host "[OK] Report: $reportPath"
if ($failed -gt 0) { exit 1 }
exit 0
