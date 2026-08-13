param(
  [string]$Workspace = "",
  [string]$EnvPath = "",
  [string]$PackagePath = "",
  [string]$VpsIp = "",
  [string]$SshUser = "",
  [string]$SshKeyPath = "",
  [string]$SshPassword = "",
  [string]$SshHostKey = "",
  [string]$RemoteAppDir = "",
  [switch]$UploadPrivateEnv,
  [switch]$ConfirmUploadPrivateEnv,
  [switch]$ConfirmDeploy
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($EnvPath)) {
  $EnvPath = Join-Path $Workspace ".env"
}
if ([string]::IsNullOrWhiteSpace($RemoteAppDir)) {
  $RemoteAppDir = '$HOME/export-ai-agent'
} elseif ($RemoteAppDir -eq "~") {
  $RemoteAppDir = '$HOME'
} elseif ($RemoteAppDir.StartsWith("~/")) {
  $RemoteAppDir = '$HOME/' + $RemoteAppDir.Substring(2)
}

function Get-EnvMap {
  param([string]$Path)
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line -split '=', 2
    $map[$parts[0].Trim()] = $parts[1].Trim()
  }
  return $map
}

function Require-Command {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "$Name not found in PATH."
  }
}

function Read-ZipEntryText {
  param(
    [System.IO.Compression.ZipArchive]$Archive,
    [string]$EntryName
  )
  $entry = $Archive.GetEntry($EntryName)
  if ($null -eq $entry) { return $null }
  $stream = $entry.Open()
  try {
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8, $true)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
  } finally {
    $stream.Dispose()
  }
}

function Assert-DeploymentPackage {
  param([string]$Path)

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $requiredEntries = @(
      "deployment-manifest.json",
      "agent_service/src/acquisition/manual-research-launch.ts",
      "agent_service/src/db.ts",
      "agent_service/src/inbound/email-health.ts",
      "agent_service/src/inbound/email-listener.ts",
      "agent_service/src/outreach/dispatcher.ts",
      "agent_service/src/dashboard/routes.ts",
      "agent_service/src/dashboard/public/index.html",
      "scripts/run-vps-activation-acceptance.ps1"
    )
    $entryNames = @($archive.Entries | ForEach-Object { $_.FullName -replace '\\', '/' })
    $missing = @($requiredEntries | Where-Object { $_ -notin $entryNames })
    if ($missing.Count -gt 0) {
      throw "Deployment package is missing schema-19 runtime files: $($missing -join ', ')"
    }

    $manifestText = Read-ZipEntryText -Archive $archive -EntryName "deployment-manifest.json"
    try { $manifest = $manifestText | ConvertFrom-Json } catch { throw "Deployment package manifest is invalid." }
    if ([int]$manifest.manifestSchemaVersion -ne 1 -or [int]$manifest.databaseSchemaVersion -ne 19) {
      throw "Deployment package must explicitly declare database schema 19."
    }

    $dbSource = Read-ZipEntryText -Archive $archive -EntryName "agent_service/src/db.ts"
    if ($dbSource -notmatch '(?m)^export const LATEST_SCHEMA_VERSION = 19;\s*$') {
      throw "Deployment package database source is not schema 19."
    }
    $activationAcceptance = Read-ZipEntryText -Archive $archive -EntryName "scripts/run-vps-activation-acceptance.ps1"
    if ($activationAcceptance -notmatch [regex]::Escape('$ExpectedSchemaVersion = 19')) {
      throw "Deployment package VPS activation acceptance does not require schema 19."
    }
  } finally {
    $archive.Dispose()
  }
}

if (-not $ConfirmDeploy) {
  throw "deploy-to-vps.ps1 requires -ConfirmDeploy."
}
if ($UploadPrivateEnv -and -not $ConfirmUploadPrivateEnv) {
  throw "Uploading private .env requires -ConfirmUploadPrivateEnv."
}
if ([string]::IsNullOrWhiteSpace($PackagePath)) {
  throw "deploy-to-vps.ps1 requires an explicit -PackagePath to a validated schema-19 deployment ZIP."
}
if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) {
  throw "Package not found: $PackagePath"
}
$PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
if ([System.IO.Path]::GetExtension($PackagePath) -ne ".zip") {
  throw "Deployment package must be a ZIP file."
}
Assert-DeploymentPackage -Path $PackagePath

$envMap = Get-EnvMap $EnvPath
if ([string]::IsNullOrWhiteSpace($VpsIp)) { $VpsIp = $envMap.VPS_IP }
if ([string]::IsNullOrWhiteSpace($SshUser)) { $SshUser = $envMap.VPS_SSH_USER }
if ([string]::IsNullOrWhiteSpace($SshKeyPath)) { $SshKeyPath = $envMap.VPS_SSH_KEY_PATH }
if ([string]::IsNullOrWhiteSpace($SshPassword)) { $SshPassword = $envMap.VPS_SSH_PASSWORD }
if ([string]::IsNullOrWhiteSpace($SshHostKey)) { $SshHostKey = $envMap.VPS_SSH_HOSTKEY }

if ([string]::IsNullOrWhiteSpace($VpsIp) -or [string]::IsNullOrWhiteSpace($SshUser)) {
  throw "Missing VPS IP or SSH user. Fill VPS_IP and VPS_SSH_USER in .env or pass -VpsIp/-SshUser."
}
$usePassword = [string]::IsNullOrWhiteSpace($SshKeyPath)
if (-not $usePassword -and -not (Test-Path -LiteralPath $SshKeyPath)) {
  throw "SSH private key path does not exist: $SshKeyPath"
}
if ($usePassword -and [string]::IsNullOrWhiteSpace($SshPassword)) {
  throw "Missing SSH auth. Fill VPS_SSH_KEY_PATH or VPS_SSH_PASSWORD in .env, or pass -SshKeyPath/-SshPassword."
}

$remote = "$SshUser@$VpsIp"
$packageName = Split-Path -Leaf $PackagePath
$remoteZip = "/tmp/$packageName"
$remotePrivateDir = if ($UploadPrivateEnv) {
  "/tmp/export-ai-agent-private-$([guid]::NewGuid().ToString('N'))"
} else {
  ""
}
$remoteEnv = if ($UploadPrivateEnv) { "$remotePrivateDir/.env" } else { "" }
$usingOpenSsh = -not $usePassword
if ($usingOpenSsh) {
  Require-Command "ssh"
  Require-Command "scp"
  $keyArgs = @("-i", $SshKeyPath, "-o", "StrictHostKeyChecking=accept-new")
} else {
  Require-Command "plink"
  Require-Command "pscp"
}

function Invoke-PuttyTrust {
  param([string]$Remote)
  function Quote-Arg {
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
    return '"' + ($Value -replace '\\', '\\' -replace '"', '\"') + '"'
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "plink"
  $args = @("-ssh", "-pw", $SshPassword, "-no-antispoof")
  if (-not [string]::IsNullOrWhiteSpace($SshHostKey)) {
    $args += @("-hostkey", $SshHostKey)
  }
  $args += @($Remote, "echo connected")
  $psi.Arguments = ($args | ForEach-Object { Quote-Arg $_ }) -join " "
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  $proc.StandardInput.WriteLine("y")
  $proc.StandardInput.Close()
  $stdout = $proc.StandardOutput.ReadToEnd()
  $stderr = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) {
    $safe = (($stdout + "`n" + $stderr) -replace [regex]::Escape($SshPassword), "REDACTED")
    throw "PuTTY SSH connection failed. $safe"
  }
}

function Invoke-PuttyCommand {
  param(
    [string]$Remote,
    [string]$Command
  )
  $puttyArgs = @("-ssh", "-batch", "-pw", $SshPassword, "-no-antispoof")
  if (-not [string]::IsNullOrWhiteSpace($SshHostKey)) {
    $puttyArgs += @("-hostkey", $SshHostKey)
  }
  $puttyArgs += @($Remote, $Command)
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & plink @puttyArgs 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    $safe = (($output | ForEach-Object { [string]$_ }) -join "`n") -replace [regex]::Escape($SshPassword), "REDACTED"
    throw "plink command failed with exit code $exitCode. $safe"
  }
}

function Invoke-PuttyCopy {
  param(
    [object[]]$Arguments,
    [string]$Area
  )
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & pscp @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    $safe = (($output | ForEach-Object { [string]$_ }) -join "`n") -replace [regex]::Escape($SshPassword), "REDACTED"
    throw "$Area failed with exit code $exitCode. $safe"
  }
}

Write-Host "== Deploy export AI agent to VPS =="
Write-Host "Workspace: $Workspace"
Write-Host "Package: $PackagePath"
Write-Host "Remote: configured SSH target"
Write-Host "Remote app dir: $RemoteAppDir"
Write-Host "Upload private env: $UploadPrivateEnv"
Write-Host "Safety: external actions remain disabled unless remote .env enables them after tests."

$tempEnvForUpload = ""
if ($UploadPrivateEnv) {
  if (-not (Test-Path -LiteralPath $EnvPath)) {
    throw "Private env not found for upload: $EnvPath"
  }
  $tempEnvForUpload = Join-Path ([System.IO.Path]::GetTempPath()) ("export-ai-agent-env-" + [guid]::NewGuid().ToString("N") + ".env")
  $excludeEnvKeys = @("VPS_SSH_PASSWORD", "VPS_SSH_KEY_PATH", "VPS_SSH_HOSTKEY")
  $envLines = foreach ($line in Get-Content -LiteralPath $EnvPath -Encoding UTF8) {
    if ($line -match '^\s*([^#][^=]+)=') {
      $key = $matches[1].Trim()
      if ($excludeEnvKeys -contains $key) { continue }
    }
    $line
  }
  $envLines | Set-Content -LiteralPath $tempEnvForUpload -Encoding UTF8
}

$remoteCommand = @"
set -euo pipefail
STAGE_DIR=`$(mktemp -d /tmp/export-ai-agent-release.XXXXXX)
REMOTE_ENV_PATH="$remoteEnv"
REMOTE_ENV_DIR="$remotePrivateDir"
cleanup() {
  rm -rf -- "`$STAGE_DIR"
  if [[ -n "`$REMOTE_ENV_DIR" ]]; then rm -rf -- "`$REMOTE_ENV_DIR"; fi
  rm -f -- "$remoteZip"
}
trap cleanup EXIT
unzip -q -o "$remoteZip" -d "`$STAGE_DIR"
APP_DIR="$RemoteAppDir" REMOTE_ENV_PATH="`$REMOTE_ENV_PATH" bash "`$STAGE_DIR/scripts/activate-vps-release.sh" "`$STAGE_DIR"
"@
$remoteCommandBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteCommand))
$remoteBootstrapCommand = "printf '%s' '$remoteCommandBase64' | base64 -d | bash"

try {
  if ($usingOpenSsh) {
    & scp @keyArgs $PackagePath "${remote}:${remoteZip}"
    if ($LASTEXITCODE -ne 0) { throw "scp package failed with exit code $LASTEXITCODE" }
    if ($UploadPrivateEnv) {
      & ssh @keyArgs $remote "umask 077; mkdir -m 700 -- '$remotePrivateDir'"
      if ($LASTEXITCODE -ne 0) { throw "remote private-env staging failed with exit code $LASTEXITCODE" }
      & scp @keyArgs $tempEnvForUpload "${remote}:${remoteEnv}"
      if ($LASTEXITCODE -ne 0) { throw "scp private env failed with exit code $LASTEXITCODE" }
      & ssh @keyArgs $remote "chmod 600 -- '$remoteEnv'"
      if ($LASTEXITCODE -ne 0) { throw "remote private-env permission check failed with exit code $LASTEXITCODE" }
    }

    & ssh @keyArgs $remote $remoteBootstrapCommand
    if ($LASTEXITCODE -ne 0) {
      throw "remote deployment command failed with exit code $LASTEXITCODE"
    }
  } else {
    Invoke-PuttyTrust -Remote $remote
    $pscpArgs = @("-batch", "-pw", $SshPassword)
    if (-not [string]::IsNullOrWhiteSpace($SshHostKey)) {
      $pscpArgs += @("-hostkey", $SshHostKey)
    }
    $pscpArgs += @($PackagePath, "${remote}:${remoteZip}")
    Invoke-PuttyCopy -Arguments $pscpArgs -Area "pscp package"
    if ($UploadPrivateEnv) {
      Invoke-PuttyCommand -Remote $remote -Command "umask 077; mkdir -m 700 -- '$remotePrivateDir'"
      $envPscpArgs = @("-batch", "-pw", $SshPassword)
      if (-not [string]::IsNullOrWhiteSpace($SshHostKey)) {
        $envPscpArgs += @("-hostkey", $SshHostKey)
      }
      $envPscpArgs += @($tempEnvForUpload, "${remote}:${remoteEnv}")
      Invoke-PuttyCopy -Arguments $envPscpArgs -Area "pscp private env"
      Invoke-PuttyCommand -Remote $remote -Command "chmod 600 -- '$remoteEnv'"
    }
    Invoke-PuttyCommand -Remote $remote -Command $remoteBootstrapCommand
  }
} finally {
  if ($UploadPrivateEnv -and -not [string]::IsNullOrWhiteSpace($remotePrivateDir)) {
    try {
      if ($usingOpenSsh) {
        & ssh @keyArgs $remote "rm -rf -- '$remotePrivateDir'" 2>$null | Out-Null
      } else {
        Invoke-PuttyCommand -Remote $remote -Command "rm -rf -- '$remotePrivateDir'"
      }
    } catch {
      Write-Warning "Remote private-env staging cleanup could not be confirmed."
    }
  }
  if ($UploadPrivateEnv -and -not [string]::IsNullOrWhiteSpace($tempEnvForUpload) -and (Test-Path -LiteralPath $tempEnvForUpload)) {
    Remove-Item -LiteralPath $tempEnvForUpload -Force
  }
}

Write-Host "[OK] VPS deployment completed and acceptance ran."
