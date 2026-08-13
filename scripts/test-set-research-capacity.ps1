param(
  [string]$Workspace = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
$updaterPath = Join-Path $Workspace "scripts\set-research-capacity.ps1"
if (-not (Test-Path -LiteralPath $updaterPath -PathType Leaf)) {
  throw "Research capacity updater is missing."
}

$tokens = $null
$errors = $null
$null = [Management.Automation.Language.Parser]::ParseFile($updaterPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "Research capacity updater parse failed." }
$source = Get-Content -LiteralPath $updaterPath -Raw -Encoding UTF8

foreach ($required in @(
  '[ValidateRange(1, 1000000)]',
  '[int]$MaxPagesPerCampaign = 1600',
  '$lockPath = $Path + ".update.lock"',
  '[IO.FileShare]::None',
  '[IO.File]::Replace($temporaryPath, $Path, $backupPath, $true)',
  '[IO.File]::Replace($backupPath, $Path, $rollbackDiscardPath, $true)',
  'Set-PrivateFileMode -Path $temporaryPath',
  'Write-Host "[OK] No upload, service restart, network request, or external action was performed."'
)) {
  if ($source -notmatch [regex]::Escape($required)) {
    throw "The updater is missing a required confirmation, validation, or atomic-write control."
  }
}
foreach ($forbidden in @(
  'Start-Process',
  'Invoke-Command',
  'Invoke-RestMethod',
  'Invoke-WebRequest',
  'Send-MailMessage',
  'systemctl',
  'scp ',
  'ssh '
)) {
  if ($source -match [regex]::Escape($forbidden)) {
    throw "The updater contains a forbidden network, upload, restart, or send operation."
  }
}

function Invoke-Updater {
  param(
    [string]$EnvPath,
    [AllowNull()][object]$MaxPages,
    [switch]$Confirm,
    [int]$LockTimeout = 15000,
    [string]$FailureMode = "NONE"
  )
  $arguments = @{
    Workspace = $Workspace
    EnvPath = $EnvPath
    LockTimeoutMilliseconds = $LockTimeout
    TestOnlyFailureMode = $FailureMode
  }
  if ($null -ne $MaxPages) { $arguments.MaxPagesPerCampaign = $MaxPages }
  if ($Confirm) { $arguments.ConfirmUpdate = $true }

  $output = @()
  $exitCode = 0
  try {
    $output = @(& $updaterPath @arguments *>&1)
  } catch {
    $exitCode = 1
    $output += $_
  }
  return [pscustomobject]@{
    exitCode = $exitCode
    output = ($output | ForEach-Object { [string]$_ }) -join "`n"
  }
}

function Start-ExclusiveEnvLockHolder {
  param(
    [string]$LockPath,
    [string]$ReadyPath,
    [int]$HoldMilliseconds = 1200
  )

  $lockPathEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($LockPath))
  $readyPathEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ReadyPath))
  $holderSource = @"
`$lockPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$lockPathEncoded'))
`$readyPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$readyPathEncoded'))
`$stream = [IO.File]::Open(`$lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  [IO.File]::WriteAllText(`$readyPath, 'ready', [Text.UTF8Encoding]::new(`$false))
  Start-Sleep -Milliseconds $HoldMilliseconds
} finally {
  `$stream.Dispose()
}
"@
  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($holderSource))
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = (Get-Process -Id $PID).Path
  $startInfo.Arguments = "-NoProfile -NonInteractive -EncodedCommand $encodedCommand"
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $process = [Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) { throw "Unable to start the lock holder process." }

  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while (-not (Test-Path -LiteralPath $ReadyPath -PathType Leaf)) {
    if ($process.HasExited) { throw "The lock holder process exited before acquiring the lock." }
    if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for the lock holder process." }
    Start-Sleep -Milliseconds 25
  }
  return $process
}

function Assert-OutputDoesNotLeak {
  param(
    [string]$Output,
    [string[]]$ForbiddenValues
  )
  foreach ($value in $ForbiddenValues) {
    if ($value -and $Output.Contains($value)) {
      throw "Research capacity updater output leaked protected test material."
    }
  }
  if ($Output -match '(?i)\.env(?:\b|[\\/])') {
    throw "Research capacity updater output disclosed the environment filename."
  }
}

$sandbox = Join-Path ([IO.Path]::GetTempPath()) ("crm-research-capacity-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $sandbox | Out-Null
$envPath = Join-Path $sandbox ".env"
$apiSecret = "synthetic-api-" + [guid]::NewGuid().ToString("N")
$mailSecret = "synthetic-mail-" + [guid]::NewGuid().ToString("N")
try {
  $fixture = @"
# preserved comment
OPENAI_API_KEY=$apiSecret
CUSTOM_SETTING="keep # exactly"
MAX_PAGES_PER_CAMPAIGN=200
SMTP_PASSWORD=$mailSecret
MAX_PAGES_PER_CAMPAIGN=300
OUTBOUND_ENABLED=false
"@
  [IO.File]::WriteAllText($envPath, $fixture.TrimStart() + "`r`n", [Text.UTF8Encoding]::new($false))
  $original = [IO.File]::ReadAllText($envPath)
  $protectedValues = @($sandbox, $envPath, $apiSecret, $mailSecret)

  $beforeConfirmation = (Get-FileHash -Algorithm SHA256 -LiteralPath $envPath).Hash
  $notConfirmed = Invoke-Updater -EnvPath $envPath -MaxPages $null
  if ($notConfirmed.exitCode -eq 0) { throw "Updater accepted a change without explicit confirmation." }
  Assert-OutputDoesNotLeak -Output $notConfirmed.output -ForbiddenValues $protectedValues
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $envPath).Hash -ne $beforeConfirmation) {
    throw "Updater modified the environment file without explicit confirmation."
  }

  $invalidRange = Invoke-Updater -EnvPath $envPath -MaxPages 0 -Confirm
  if ($invalidRange.exitCode -eq 0) { throw "Updater accepted a research capacity outside the allowed range." }
  Assert-OutputDoesNotLeak -Output $invalidRange.output -ForbiddenValues $protectedValues
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $envPath).Hash -ne $beforeConfirmation) {
    throw "Updater modified the environment file after range validation failed."
  }

  $lockReadyPath = Join-Path $sandbox "capacity-lock-ready"
  $lockHolder = $null
  try {
    $lockHolder = Start-ExclusiveEnvLockHolder `
      -LockPath ($envPath + ".update.lock") `
      -ReadyPath $lockReadyPath
    $lockBlocked = Invoke-Updater -EnvPath $envPath -MaxPages 1700 -Confirm -LockTimeout 200
    if ($lockBlocked.exitCode -eq 0) { throw "Updater ignored a competing environment update lock." }
    Assert-OutputDoesNotLeak -Output $lockBlocked.output -ForbiddenValues $protectedValues
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $envPath).Hash -ne $beforeConfirmation) {
      throw "Updater modified the environment file while another process held the update lock."
    }
  } finally {
    if ($null -ne $lockHolder) {
      if (-not $lockHolder.WaitForExit(5000)) {
        $lockHolder.Kill()
        $lockHolder.WaitForExit()
      }
      $lockHolder.Dispose()
    }
    Remove-Item -LiteralPath $lockReadyPath -Force -ErrorAction SilentlyContinue
  }

  $result = Invoke-Updater -EnvPath $envPath -MaxPages $null -Confirm
  if ($result.exitCode -ne 0) { throw "Confirmed research capacity update failed." }
  Assert-OutputDoesNotLeak -Output $result.output -ForbiddenValues $protectedValues

  $updated = [IO.File]::ReadAllText($envPath)
  if ([regex]::Matches($updated, '(?m)^MAX_PAGES_PER_CAMPAIGN=').Count -ne 1) {
    throw "Updater did not collapse duplicate research capacity keys."
  }
  if ($updated -notmatch '(?m)^MAX_PAGES_PER_CAMPAIGN=1600\r?$') {
    throw "Updater did not apply the default bounded research capacity."
  }
  foreach ($preserved in @(
    "# preserved comment",
    "OPENAI_API_KEY=$apiSecret",
    'CUSTOM_SETTING="keep # exactly"',
    "SMTP_PASSWORD=$mailSecret",
    "OUTBOUND_ENABLED=false"
  )) {
    if (-not $updated.Contains($preserved)) {
      throw "Updater did not preserve an unrelated environment entry exactly."
    }
  }
  $originalUnmanaged = @([regex]::Split($original, '\r\n|\n|\r') | Where-Object {
    $_ -notmatch '^\s*(?:export\s+)?MAX_PAGES_PER_CAMPAIGN\s*='
  }) -join "`n"
  $updatedUnmanaged = @([regex]::Split($updated, '\r\n|\n|\r') | Where-Object {
    $_ -notmatch '^\s*(?:export\s+)?MAX_PAGES_PER_CAMPAIGN\s*='
  }) -join "`n"
  if ($originalUnmanaged -ne $updatedUnmanaged) {
    throw "Updater changed content outside the managed research capacity key."
  }

  $beforePostReplaceFailure = (Get-FileHash -Algorithm SHA256 -LiteralPath $envPath).Hash
  $postReplaceFailure = Invoke-Updater `
    -EnvPath $envPath `
    -MaxPages 1700 `
    -Confirm `
    -FailureMode "POST_REPLACE_PERMISSION"
  if ($postReplaceFailure.exitCode -eq 0) {
    throw "Updater ignored an injected post-replace permission failure."
  }
  Assert-OutputDoesNotLeak -Output $postReplaceFailure.output -ForbiddenValues $protectedValues
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $envPath).Hash -ne $beforePostReplaceFailure) {
    throw "Updater did not restore the original file after a post-replace permission failure."
  }

  $leftovers = @(
    Get-ChildItem -LiteralPath $sandbox -Filter ".env.*.tmp" -File
    Get-ChildItem -LiteralPath $sandbox -Filter ".env.*.bak" -File
    Get-ChildItem -LiteralPath $sandbox -Filter ".env.*.rollback" -File
  )
  if ($leftovers.Count -gt 0) {
    throw "Updater left a temporary or backup environment file behind."
  }

  $beforeRollbackFailure = (Get-FileHash -Algorithm SHA256 -LiteralPath $envPath).Hash
  $rollbackFailure = Invoke-Updater `
    -EnvPath $envPath `
    -MaxPages 1800 `
    -Confirm `
    -FailureMode "POST_REPLACE_PERMISSION_AND_ROLLBACK"
  if ($rollbackFailure.exitCode -eq 0) {
    throw "Updater ignored an injected rollback failure."
  }
  Assert-OutputDoesNotLeak -Output $rollbackFailure.output -ForbiddenValues $protectedValues
  $preservedBackups = @(Get-ChildItem -LiteralPath $sandbox -Filter ".env.*.bak" -File)
  if ($preservedBackups.Count -ne 1) {
    throw "Updater did not preserve exactly one backup after rollback failed."
  }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $preservedBackups[0].FullName).Hash -ne $beforeRollbackFailure) {
    throw "The backup preserved after rollback failure does not contain the original file."
  }
  if ([IO.File]::ReadAllText($envPath) -notmatch '(?m)^MAX_PAGES_PER_CAMPAIGN=1800\r?$') {
    throw "Rollback failure injection did not occur after the replacement was committed."
  }
} finally {
  if (Test-Path -LiteralPath $sandbox) {
    Remove-Item -LiteralPath $sandbox -Recurse -Force
  }
}

Write-Host "[OK] Research capacity updater lock, rollback, preservation, and disclosure tests passed."
