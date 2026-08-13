param(
  [string]$Workspace = "",
  [string]$EnvPath = "",
  [ValidateRange(1, 1000000)]
  [int]$MaxPagesPerCampaign = 1600,
  [switch]$ConfirmUpdate,
  [ValidateRange(50, 300000)]
  [int]$LockTimeoutMilliseconds = 15000,
  [Parameter(DontShow = $true)]
  [ValidateSet("NONE", "POST_REPLACE_PERMISSION", "POST_REPLACE_PERMISSION_AND_ROLLBACK")]
  [string]$TestOnlyFailureMode = "NONE"
)

$ErrorActionPreference = "Stop"

function Set-PrivateFileMode {
  param([string]$Path)
  if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { return }
  & chmod 600 -- $Path
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to restrict the environment file permissions."
  }
}

function Enter-EnvUpdateLock {
  param(
    [string]$Path,
    [int]$TimeoutMilliseconds
  )

  $lockPath = $Path + ".update.lock"
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    $stream = $null
    try {
      $stream = [IO.File]::Open(
        $lockPath,
        [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
      )
      Set-PrivateFileMode -Path $lockPath
      $stopwatch.Stop()
      return $stream
    } catch [IO.IOException] {
      if ($null -ne $stream) { $stream.Dispose() }
      if ($stopwatch.ElapsedMilliseconds -ge $TimeoutMilliseconds) {
        throw "Timed out waiting for the environment update lock. No file was changed."
      }
      $remaining = $TimeoutMilliseconds - [int]$stopwatch.ElapsedMilliseconds
      Start-Sleep -Milliseconds ([Math]::Max(1, [Math]::Min(50, $remaining)))
    } catch {
      if ($null -ne $stream) { $stream.Dispose() }
      throw "Unable to acquire the environment update lock. No file was changed."
    }
  }
}

function Write-AtomicResearchCapacityUpdate {
  param(
    [string]$Path,
    [int]$Value,
    [int]$LockTimeout,
    [string]$FailureMode
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "The target environment file does not exist."
  }

  $lockStream = $null
  $temporaryPath = ""
  $backupPath = ""
  $rollbackDiscardPath = ""
  $replacementCommitted = $false
  $preserveBackup = $false
  try {
    $lockStream = Enter-EnvUpdateLock -Path $Path -TimeoutMilliseconds $LockTimeout
    $original = [IO.File]::ReadAllText($Path)
    $newline = if ($original.Contains("`r`n")) { "`r`n" } else { "`n" }
    $lines = [regex]::Split($original, '\r\n|\n|\r')
    $targetName = "MAX_PAGES_PER_CAMPAIGN"
    $targetWritten = $false
    $updated = New-Object Collections.Generic.List[string]

    foreach ($line in $lines) {
      $match = [regex]::Match($line, '^\s*(?:export\s+)?(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=')
      $name = if ($match.Success) { $match.Groups['name'].Value } else { "" }
      if ($name -ne $targetName) {
        $updated.Add($line)
        continue
      }
      if ($targetWritten) { continue }
      $updated.Add("$targetName=$Value")
      $targetWritten = $true
    }

    if (-not $targetWritten) {
      if ($updated.Count -gt 0 -and $updated[$updated.Count - 1] -eq "") {
        $updated.RemoveAt($updated.Count - 1)
      }
      $updated.Add("$targetName=$Value")
    }
    $output = ($updated -join $newline).TrimEnd("`r", "`n") + $newline

    $directory = [IO.Path]::GetDirectoryName($Path)
    $fileName = [IO.Path]::GetFileName($Path)
    $artifactPrefix = if ($fileName.StartsWith(".")) { $fileName } else { ".$fileName" }
    $temporaryPath = Join-Path $directory "$artifactPrefix.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    $backupPath = Join-Path $directory "$artifactPrefix.$PID.$([guid]::NewGuid().ToString('N')).bak"
    $rollbackDiscardPath = Join-Path $directory "$artifactPrefix.$PID.$([guid]::NewGuid().ToString('N')).rollback"
    [IO.File]::WriteAllText($temporaryPath, $output, [Text.UTF8Encoding]::new($false))
    Set-PrivateFileMode -Path $temporaryPath
    [IO.File]::Replace($temporaryPath, $Path, $backupPath, $true)
    $replacementCommitted = $true
    Set-PrivateFileMode -Path $backupPath
    if ($FailureMode -in @("POST_REPLACE_PERMISSION", "POST_REPLACE_PERMISSION_AND_ROLLBACK")) {
      throw "Injected post-replace permission failure."
    }
    Set-PrivateFileMode -Path $Path
  } catch {
    $restored = $false
    $rollbackFailed = $false
    if ($replacementCommitted -and $backupPath -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
      try {
        if ($FailureMode -eq "POST_REPLACE_PERMISSION_AND_ROLLBACK") {
          throw "Injected rollback failure."
        }
        [IO.File]::Replace($backupPath, $Path, $rollbackDiscardPath, $true)
        $replacementCommitted = $false
        $restored = $true
      } catch {
        $rollbackFailed = $true
        $preserveBackup = $true
      }
    }

    if ($rollbackFailed) {
      throw "Unable to update the research capacity safely, and automatic rollback failed. The restricted backup was preserved."
    }
    if ($restored) {
      throw "Unable to update the research capacity safely. The original file was restored."
    }
    throw "Unable to update the research capacity safely. No file was changed."
  } finally {
    try {
      if ($temporaryPath -and (Test-Path -LiteralPath $temporaryPath)) {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
      }
      if (-not $preserveBackup -and $backupPath -and (Test-Path -LiteralPath $backupPath)) {
        Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
      }
      if ($rollbackDiscardPath -and (Test-Path -LiteralPath $rollbackDiscardPath)) {
        Remove-Item -LiteralPath $rollbackDiscardPath -Force -ErrorAction SilentlyContinue
      }
    } finally {
      if ($null -ne $lockStream) { $lockStream.Dispose() }
    }
  }
}

if (-not $ConfirmUpdate) {
  throw "Research capacity update requires -ConfirmUpdate. No file was changed."
}
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($EnvPath)) {
  $EnvPath = Join-Path $Workspace ".env"
}
$EnvPath = [IO.Path]::GetFullPath($EnvPath)
if ($TestOnlyFailureMode -ne "NONE") {
  $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (-not $EnvPath.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Test-only failure injection is restricted to the system temporary directory. No file was changed."
  }
}

Write-AtomicResearchCapacityUpdate `
  -Path $EnvPath `
  -Value $MaxPagesPerCampaign `
  -LockTimeout $LockTimeoutMilliseconds `
  -FailureMode $TestOnlyFailureMode

Write-Host "[OK] Research capacity updated atomically."
Write-Host "[OK] No upload, service restart, network request, or external action was performed."
