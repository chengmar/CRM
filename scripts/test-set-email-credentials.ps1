param(
  [string]$Workspace = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
$updaterPath = Join-Path $Workspace "scripts\set-email-credentials.ps1"
if (-not (Test-Path -LiteralPath $updaterPath -PathType Leaf)) {
  throw "Secure email credential updater is missing."
}

$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($updaterPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "Secure email credential updater parse failed." }
$source = Get-Content -LiteralPath $updaterPath -Raw -Encoding UTF8

$parameterNames = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
$credentialParameters = @($parameterNames | Where-Object { $_ -match '(?i)password|passwd|secret|token|credential' })
if ($credentialParameters.Count -gt 0) {
  throw "The updater must not accept a credential through command-line parameters."
}
if ([regex]::Matches($source, 'Read-Host[^\r\n]+-AsSecureString').Count -lt 2) {
  throw "The updater must collect and confirm the credential through masked prompts."
}
foreach ($required in @(
  '$lockPath = $Path + ".update.lock"',
  '[IO.FileShare]::None',
  '[IO.File]::Replace($temporaryPath, $Path, $backupPath, $true)',
  'Set-PrivateFileMode -Path $temporaryPath',
  'Write-Host "[OK] No upload, service restart, authentication test, or email send was performed."'
)) {
  if ($source -notmatch [regex]::Escape($required)) {
    throw "The updater is missing a required local-only atomic-write control."
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
  'ssh ',
  'AUTH PLAIN',
  'MAIL FROM',
  'RCPT TO'
)) {
  if ($source -match [regex]::Escape($forbidden)) {
    throw "The updater contains a forbidden upload, restart, network, or send operation."
  }
}

function Invoke-Updater {
  param(
    [string]$EnvPath,
    [string]$FirstEntry,
    [string]$SecondEntry,
    [switch]$Confirm,
    [int]$LockTimeout = 15000
  )
  $entries = [Collections.Generic.Queue[string]]::new()
  $entries.Enqueue($FirstEntry)
  $entries.Enqueue($SecondEntry)

  function Read-Host {
    param(
      [string]$Prompt,
      [switch]$AsSecureString
    )
    if (-not $AsSecureString -or $entries.Count -eq 0) {
      throw "Unexpected credential prompt in updater test."
    }
    return ConvertTo-SecureString $entries.Dequeue() -AsPlainText -Force
  }

  $arguments = @{
    Workspace = $Workspace
    EnvPath = $EnvPath
    FromAddress = "sender@example.test"
    FromName = "Synthetic Sender"
    LockTimeoutMilliseconds = $LockTimeout
  }
  if ($Confirm) { $arguments.ConfirmUpdate = $true }

  $output = @()
  $exitCode = 0
  try {
    $output = @(& $updaterPath @arguments 2>&1)
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

$sandbox = Join-Path ([IO.Path]::GetTempPath()) ("crm-email-credential-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $sandbox | Out-Null
$envPath = Join-Path $sandbox ".env"
$fixtureSecret = "fixture-" + [guid]::NewGuid().ToString("N") + " # quoted"
$mismatchSecret = "mismatch-" + [guid]::NewGuid().ToString("N")
try {
  $fixture = @'
# preserved comment
OPENAI_MODEL=fixture-model
CUSTOM_SETTING="keep # exactly"
SMTP_HOST=old-smtp.example.test
SMTP_HOST=duplicate.example.test
SMTP_PASSWORD=old-placeholder
IMAP_PASSWORD=old-placeholder
OUTBOUND_ENABLED=false
'@
  [IO.File]::WriteAllText($envPath, $fixture.TrimStart() + "`r`n", [Text.UTF8Encoding]::new($false))

  $beforeConfirmation = (Get-FileHash -Algorithm SHA256 -LiteralPath $envPath).Hash
  $notConfirmed = Invoke-Updater -EnvPath $envPath -FirstEntry "" -SecondEntry ""
  if ($notConfirmed.exitCode -eq 0) { throw "Updater changed configuration without explicit confirmation." }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $envPath).Hash -ne $beforeConfirmation) {
    throw "Updater modified the environment file without explicit confirmation."
  }

  $lockReadyPath = Join-Path $sandbox "email-lock-ready"
  $lockHolder = $null
  try {
    $lockHolder = Start-ExclusiveEnvLockHolder `
      -LockPath ($envPath + ".update.lock") `
      -ReadyPath $lockReadyPath
    $lockBlocked = Invoke-Updater `
      -EnvPath $envPath `
      -FirstEntry $fixtureSecret `
      -SecondEntry $fixtureSecret `
      -Confirm `
      -LockTimeout 200
    if ($lockBlocked.exitCode -eq 0) { throw "Email updater ignored a competing environment update lock." }
    if ($lockBlocked.output.Contains($fixtureSecret)) {
      throw "Email updater lock-timeout output leaked the entered credential."
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $envPath).Hash -ne $beforeConfirmation) {
      throw "Email updater modified the environment file while another process held the shared update lock."
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

  $result = Invoke-Updater -EnvPath $envPath -FirstEntry $fixtureSecret -SecondEntry $fixtureSecret -Confirm
  if ($result.exitCode -ne 0) {
    $safeOutput = $result.output.Replace($fixtureSecret, "[REDACTED]")
    throw "Secure updater behavior test failed: $safeOutput"
  }
  if ($result.output.Contains($fixtureSecret)) { throw "Secure updater output leaked the entered credential." }

  $updated = [IO.File]::ReadAllText($envPath)
  foreach ($preserved in @(
    "# preserved comment",
    "OPENAI_MODEL=fixture-model",
    'CUSTOM_SETTING="keep # exactly"',
    "OUTBOUND_ENABLED=false"
  )) {
    if (-not $updated.Contains($preserved)) { throw "Updater did not preserve an unrelated environment entry." }
  }
  foreach ($expected in @(
    "EMAIL_FROM_ADDRESS=sender@example.test",
    'EMAIL_FROM_NAME="Synthetic Sender"',
    "EMAIL_REPLY_TO=sender@example.test",
    "SMTP_HOST=smtp.exmail.qq.com",
    "SMTP_PORT=465",
    "SMTP_USER=sender@example.test",
    "IMAP_HOST=imap.exmail.qq.com",
    "IMAP_PORT=993",
    "IMAP_USER=sender@example.test"
  )) {
    if (-not $updated.Contains($expected)) { throw "Updater did not write an expected non-secret mailbox setting." }
  }
  if ([regex]::Matches($updated, '(?m)^SMTP_HOST=').Count -ne 1) {
    throw "Updater did not collapse duplicate managed keys."
  }
  if ([regex]::Matches($updated, [regex]::Escape($fixtureSecret)).Count -ne 2) {
    throw "Updater did not write the same application password to SMTP and IMAP."
  }
  $leftovers = @(
    Get-ChildItem -LiteralPath $sandbox -Filter ".env.*.tmp" -File
    Get-ChildItem -LiteralPath $sandbox -Filter ".env.*.bak" -File
    Get-ChildItem -LiteralPath $sandbox -Filter ".env.*.rollback" -File
  )
  if ($leftovers.Count -gt 0) {
    throw "Updater left a plaintext temporary or backup file behind."
  }

  $beforeMismatch = (Get-FileHash -Algorithm SHA256 -LiteralPath $envPath).Hash
  $mismatch = Invoke-Updater -EnvPath $envPath -FirstEntry $fixtureSecret -SecondEntry $mismatchSecret -Confirm
  if ($mismatch.exitCode -eq 0) { throw "Updater accepted mismatched credential entries." }
  if ($mismatch.output.Contains($fixtureSecret) -or $mismatch.output.Contains($mismatchSecret)) {
    throw "Updater mismatch output leaked an entered credential."
  }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $envPath).Hash -ne $beforeMismatch) {
    throw "Updater modified the environment file after credential confirmation failed."
  }
} finally {
  if (Test-Path -LiteralPath $sandbox) {
    Remove-Item -LiteralPath $sandbox -Recurse -Force
  }
}

Write-Host "[OK] Secure email credential updater shared-lock and behavior tests passed."
