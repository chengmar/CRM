[CmdletBinding()]
param(
  [int]$LocalPort = 18791,
  [int]$RemotePort = 18790,
  [string]$SshKeyPath = (Join-Path $HOME ".ssh\export_ai_agent_ed25519")
)

$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $workspace ".env"

function Read-EnvMap([string]$Path) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $map }
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line -split '=', 2
    $key = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    if ($key) { $map[$key] = $value }
  }
  return $map
}

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  throw "OpenSSH client is not installed."
}
if (-not (Test-Path -LiteralPath $SshKeyPath -PathType Leaf)) {
  throw "The configured SSH private key was not found."
}

$envMap = Read-EnvMap $envPath
$remoteHost = [string]$envMap["VPS_SSH_HOST"]
if (-not $remoteHost) {
  $remoteHost = [string]$envMap["VPS_IP"]
}
$remoteUser = [string]$envMap["VPS_SSH_USER"]
if (-not $remoteHost -or -not $remoteUser) {
  throw "VPS_SSH_HOST (or VPS_IP) and VPS_SSH_USER must be present in the private workspace .env file."
}

$existing = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
if (-not $existing) {
  $arguments = @(
    "-N",
    "-L", "${LocalPort}:127.0.0.1:${RemotePort}",
    "-i", $SshKeyPath,
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "${remoteUser}@${remoteHost}"
  )
  $process = Start-Process -FilePath (Get-Command ssh).Source -ArgumentList $arguments -WindowStyle Hidden -PassThru
  $ready = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) { throw "The private dashboard tunnel could not be established." }
    if (Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue) {
      $ready = $true
      break
    }
  }
  if (-not $ready) {
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    throw "The private dashboard tunnel did not become ready in time."
  }
}

$url = "http://127.0.0.1:${LocalPort}/dashboard"
Start-Process $url
Write-Host "Private monitoring dashboard opened at $url"
