param(
  [string]$Workspace = "",
  [ValidateSet("x64", "arm64")]
  [string]$Architecture = "x64",
  [switch]$RequireSignature
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

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$reportDir = Join-Path $Workspace "outputs\windows_compatibility_acceptance"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$reportPath = Join-Path $reportDir "windows-compatibility-$Architecture-$stamp.json"
$tempBase = (Resolve-Path -LiteralPath $env:TEMP).Path
$runRoot = Join-Path $tempBase "crm-agent-compatibility-$stamp-$PID"
New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
$runRoot = (Resolve-Path -LiteralPath $runRoot).Path
if (-not $runRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Compatibility run directory escapes the Windows temp directory."
}

$results = New-Object System.Collections.Generic.List[object]
$os = Get-CimInstance Win32_OperatingSystem
$hostArchitecture = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
function Add-Result {
  param([string]$Name, [string]$Status, [string]$Detail)
  $results.Add([pscustomobject]@{ name = $Name; status = $Status; detail = $Detail }) | Out-Null
  Write-Host "[$Status] $Name $Detail"
}

function Test-Signature {
  param([string]$Path, [string]$Name)
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -eq "Valid") {
    Add-Result "Signature $Name" "PASS" "Authenticode valid"
  } else {
    Add-Result "Signature $Name" $(if ($RequireSignature) { "FAIL" } else { "WARN" }) "Authenticode status=$($signature.Status)"
  }
}

function Invoke-InstallerSelfTest {
  param([string]$Executable, [string]$Name, [string]$DataDir)
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
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
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(120000)) {
    $process.Kill()
    throw "$Name timed out."
  }
  if ($process.ExitCode -ne 0) { throw "$Name failed with exit code $($process.ExitCode): $($stderr.Result)" }
  $selfReportPath = Join-Path $DataDir "self-test-report.json"
  if (-not (Test-Path -LiteralPath $selfReportPath)) { throw "$Name did not write a self-test report." }
  $report = Get-Content -LiteralPath $selfReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $report.ok -or -not $report.safeStorage -or -not $report.renderer.ipc -or $report.architecture -ne $Architecture) {
    throw "$Name self-test contract failed."
  }
  Add-Result $Name "PASS" "arch=$($report.architecture); payload=$($report.payload.sha256)"
}

try {
  Add-Result "Windows environment" "PASS" "$($os.Caption); version=$($os.Version); build=$($os.BuildNumber); host_arch=$hostArchitecture"
  if ($Architecture -eq "arm64" -and $hostArchitecture -ne "arm64") {
    throw "ARM64 acceptance must run on native Windows ARM64 hardware or a Windows ARM64 virtual machine."
  }

  $setupArtifact = @($manifest.artifacts | Where-Object { $_.architecture -eq $Architecture -and $_.distribution -eq "setup" })
  $portableArtifact = @($manifest.artifacts | Where-Object { $_.architecture -eq $Architecture -and $_.distribution -eq "portable" })
  if ($setupArtifact.Count -ne 1 -or $portableArtifact.Count -ne 1) {
    throw "Expected exactly one setup and one portable artifact for $Architecture."
  }
  $setupArtifact = $setupArtifact[0]
  $portableArtifact = $portableArtifact[0]

  foreach ($artifact in @($setupArtifact, $portableArtifact)) {
    $path = Join-Path $releaseDir $artifact.file
    if (-not (Test-Path -LiteralPath $path)) { throw "Artifact is missing: $($artifact.file)" }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    if ($hash -ne $artifact.sha256) { throw "Checksum mismatch: $($artifact.file)" }
    Add-Result "Checksum $($artifact.file)" "PASS" $hash
    Test-Signature $path $artifact.file
  }

  $portable = Join-Path $releaseDir $portableArtifact.file
  Invoke-InstallerSelfTest $portable "$Architecture portable app" (Join-Path $runRoot "portable-user-data")

  $setup = Join-Path $releaseDir $setupArtifact.file
  $installDir = Join-Path $runRoot "installed"
  $install = Start-Process -FilePath $setup -ArgumentList @("/S", "/D=$installDir") -PassThru -Wait
  if ($install.ExitCode -ne 0) { throw "Silent NSIS installation failed with exit code $($install.ExitCode)." }
  $installedExe = Join-Path $installDir "CRM Agent Installer.exe"
  if (-not (Test-Path -LiteralPath $installedExe)) { throw "Installed application is missing: $installedExe" }
  Test-Signature $installedExe "$Architecture installed application"
  Invoke-InstallerSelfTest $installedExe "$Architecture installed app" (Join-Path $runRoot "installed-user-data")

  $uninstaller = Get-ChildItem -LiteralPath $installDir -Filter "Uninstall*.exe" -File | Select-Object -First 1
  if (-not $uninstaller) { throw "NSIS uninstaller was not created." }
  Test-Signature $uninstaller.FullName "$Architecture uninstaller"
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -PassThru -Wait
  if ($uninstall.ExitCode -ne 0) { throw "Silent NSIS uninstall failed with exit code $($uninstall.ExitCode)." }
  Add-Result "$Architecture setup install and uninstall" "PASS" "isolated_install_dir=$installDir"
} catch {
  Add-Result "Compatibility execution" "FAIL" $_.Exception.Message
}

$failed = @($results | Where-Object { $_.status -eq "FAIL" }).Count
$warnings = @($results | Where-Object { $_.status -eq "WARN" }).Count
$report = [pscustomobject]@{
  generated_at = (Get-Date -Format s)
  workspace = $Workspace
  release_version = $manifest.productVersion
  payload_sha256 = $manifest.payload.sha256
  architecture = $Architecture
  host_architecture = $hostArchitecture
  os_caption = $os.Caption
  os_version = $os.Version
  os_build = $os.BuildNumber
  signature_required = [bool]$RequireSignature
  failed = $failed
  warnings = $warnings
  results = $results
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8

if (Test-Path -LiteralPath $runRoot) {
  $resolvedRunRoot = (Resolve-Path -LiteralPath $runRoot).Path
  if (-not $resolvedRunRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove compatibility data outside the Windows temp directory."
  }
  Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force
}

Write-Host "[OK] Report: $reportPath"
if ($failed -gt 0) { exit 1 }
exit 0
