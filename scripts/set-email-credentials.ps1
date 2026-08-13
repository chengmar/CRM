param(
  [string]$Workspace = "",
  [string]$EnvPath = "",
  [Parameter(Mandatory = $true)]
  [string]$FromAddress,
  [Parameter(Mandatory = $true)]
  [string]$FromName,
  [string]$ReplyTo = "",
  [string]$SmtpHost = "smtp.exmail.qq.com",
  [ValidateRange(1, 65535)]
  [int]$SmtpPort = 465,
  [string]$SmtpUser = "",
  [string]$ImapHost = "imap.exmail.qq.com",
  [ValidateRange(1, 65535)]
  [int]$ImapPort = 993,
  [string]$ImapUser = "",
  [switch]$ConfirmUpdate,
  [ValidateRange(50, 300000)]
  [int]$LockTimeoutMilliseconds = 15000
)

$ErrorActionPreference = "Stop"

function Assert-MailAddress {
  param([string]$Value, [string]$Name)
  try {
    $parsed = [System.Net.Mail.MailAddress]::new($Value)
  } catch {
    throw "$Name must be a valid email address."
  }
  if ($parsed.Address -ne $Value) {
    throw "$Name must contain only the email address."
  }
}

function Assert-MailHost {
  param([string]$Value, [string]$Name)
  if ($Value -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$') {
    throw "$Name must be a DNS host name without a URL scheme or path."
  }
}

function Test-SecureStringEqual {
  param(
    [Security.SecureString]$Left,
    [Security.SecureString]$Right
  )
  if ($Left.Length -ne $Right.Length) { return $false }
  $leftPointer = [IntPtr]::Zero
  $rightPointer = [IntPtr]::Zero
  try {
    $leftPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Left)
    $rightPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Right)
    for ($index = 0; $index -lt $Left.Length; $index += 1) {
      $offset = $index * 2
      if ([Runtime.InteropServices.Marshal]::ReadInt16($leftPointer, $offset) -ne
          [Runtime.InteropServices.Marshal]::ReadInt16($rightPointer, $offset)) {
        return $false
      }
    }
    return $true
  } finally {
    if ($leftPointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($leftPointer)
    }
    if ($rightPointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($rightPointer)
    }
  }
}

function ConvertFrom-PrivateSecureString {
  param([Security.SecureString]$Value)
  $pointer = [IntPtr]::Zero
  try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    if ($pointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
  }
}

function ConvertTo-DotEnvValue {
  param([AllowEmptyString()][string]$Value)
  if ($Value -match '^[A-Za-z0-9_./:@,+-]*$') { return $Value }
  $escaped = $Value.Replace('\', '\\').Replace('"', '\"')
  $escaped = $escaped.Replace("`r", '\r').Replace("`n", '\n')
  return '"' + $escaped + '"'
}

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

function Write-AtomicEnvUpdate {
  param(
    [string]$Path,
    [Collections.Specialized.OrderedDictionary]$Values,
    [int]$LockTimeout
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "The target .env file does not exist."
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
    $written = @{}
    $updated = New-Object Collections.Generic.List[string]

    foreach ($line in $lines) {
      $match = [regex]::Match($line, '^\s*(?:export\s+)?(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=')
      $name = if ($match.Success) { $match.Groups['name'].Value } else { "" }
      if (-not $Values.Contains($name)) {
        $updated.Add($line)
        continue
      }
      if ($written.ContainsKey($name)) { continue }
      $updated.Add("$name=$(ConvertTo-DotEnvValue ([string]$Values[$name]))")
      $written[$name] = $true
    }

    $missing = @($Values.Keys | Where-Object { -not $written.ContainsKey([string]$_) })
    if ($missing.Count -gt 0 -and $updated.Count -gt 0 -and $updated[$updated.Count - 1] -eq "") {
      $updated.RemoveAt($updated.Count - 1)
    }
    foreach ($name in $missing) {
      $updated.Add("$name=$(ConvertTo-DotEnvValue ([string]$Values[$name]))")
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
    Set-PrivateFileMode -Path $Path
  } catch {
    $restored = $false
    $rollbackFailed = $false
    if ($replacementCommitted -and $backupPath -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
      try {
        [IO.File]::Replace($backupPath, $Path, $rollbackDiscardPath, $true)
        $replacementCommitted = $false
        $restored = $true
      } catch {
        $rollbackFailed = $true
        $preserveBackup = $true
      }
    }
    if ($rollbackFailed) {
      throw "Unable to update email credentials safely, and automatic rollback failed. The restricted backup was preserved."
    }
    if ($restored) {
      throw "Unable to update email credentials safely. The original file was restored."
    }
    throw "Unable to update email credentials safely. No file was changed."
  } finally {
    try {
      if ($temporaryPath -and (Test-Path -LiteralPath $temporaryPath)) {
        Remove-Item -LiteralPath $temporaryPath -Force
      }
      if (-not $preserveBackup -and $backupPath -and (Test-Path -LiteralPath $backupPath)) {
        Remove-Item -LiteralPath $backupPath -Force
      }
      if ($rollbackDiscardPath -and (Test-Path -LiteralPath $rollbackDiscardPath)) {
        Remove-Item -LiteralPath $rollbackDiscardPath -Force
      }
    } finally {
      if ($null -ne $lockStream) { $lockStream.Dispose() }
    }
  }
}

if (-not $ConfirmUpdate) {
  throw "Credential update requires -ConfirmUpdate. No file was changed."
}
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($EnvPath)) {
  $EnvPath = Join-Path $Workspace ".env"
}
$EnvPath = [IO.Path]::GetFullPath($EnvPath)

$FromAddress = $FromAddress.Trim()
$FromName = $FromName.Trim()
$ReplyTo = if ([string]::IsNullOrWhiteSpace($ReplyTo)) { $FromAddress } else { $ReplyTo.Trim() }
$SmtpHost = $SmtpHost.Trim().ToLowerInvariant()
$ImapHost = $ImapHost.Trim().ToLowerInvariant()
$SmtpUser = if ([string]::IsNullOrWhiteSpace($SmtpUser)) { $FromAddress } else { $SmtpUser.Trim() }
$ImapUser = if ([string]::IsNullOrWhiteSpace($ImapUser)) { $FromAddress } else { $ImapUser.Trim() }

Assert-MailAddress -Value $FromAddress -Name "FromAddress"
Assert-MailAddress -Value $ReplyTo -Name "ReplyTo"
if ([string]::IsNullOrWhiteSpace($FromName)) { throw "FromName is required." }
Assert-MailHost -Value $SmtpHost -Name "SmtpHost"
Assert-MailHost -Value $ImapHost -Name "ImapHost"

$firstEntry = $null
$secondEntry = $null
$plainText = ""
$updates = $null
try {
  $firstEntry = Read-Host -Prompt "Enter the mailbox client application password" -AsSecureString
  $secondEntry = Read-Host -Prompt "Enter the mailbox client application password again" -AsSecureString
  if ($firstEntry.Length -eq 0) { throw "The mailbox client application password cannot be empty." }
  if (-not (Test-SecureStringEqual -Left $firstEntry -Right $secondEntry)) {
    throw "The two password entries did not match. No file was changed."
  }

  $plainText = ConvertFrom-PrivateSecureString $firstEntry
  $updates = [ordered]@{
    EMAIL_FROM_ADDRESS = $FromAddress
    EMAIL_FROM_NAME = $FromName
    EMAIL_REPLY_TO = $ReplyTo
    SMTP_HOST = $SmtpHost
    SMTP_PORT = [string]$SmtpPort
    SMTP_USER = $SmtpUser
    SMTP_PASSWORD = $plainText
    IMAP_HOST = $ImapHost
    IMAP_PORT = [string]$ImapPort
    IMAP_USER = $ImapUser
    IMAP_PASSWORD = $plainText
  }
  Write-AtomicEnvUpdate -Path $EnvPath -Values $updates -LockTimeout $LockTimeoutMilliseconds
} finally {
  if ($null -ne $updates) {
    $updates["SMTP_PASSWORD"] = ""
    $updates["IMAP_PASSWORD"] = ""
    $updates = $null
  }
  $plainText = ""
  if ($null -ne $firstEntry) { $firstEntry.Dispose() }
  if ($null -ne $secondEntry) { $secondEntry.Dispose() }
}

Write-Host "[OK] Email credentials and sender settings updated atomically."
Write-Host "[OK] No upload, service restart, authentication test, or email send was performed."
