param(
  [string]$Workspace = "",
  [string]$EnvPath = "",
  [string]$AccessFile = "",
  [string]$DashboardUser = "operator"
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $Workspace = (Resolve-Path -LiteralPath $Workspace).Path
}
if ([string]::IsNullOrWhiteSpace($EnvPath)) { $EnvPath = Join-Path $Workspace ".env" }
if ([string]::IsNullOrWhiteSpace($AccessFile)) {
  $AccessFile = Join-Path $Workspace "private\dashboard-access.txt"
}

$envMap = @{}
foreach ($line in Get-Content -LiteralPath $EnvPath -Encoding UTF8) {
  if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
  $parts = $line -split '=', 2
  $envMap[$parts[0].Trim()] = $parts[1].Trim()
}
foreach ($name in @("VPS_IP", "VPS_SSH_USER", "VPS_SSH_KEY_PATH")) {
  if ([string]::IsNullOrWhiteSpace([string]$envMap[$name])) { throw "Missing private VPS setting: $name" }
}
if (-not (Test-Path -LiteralPath $envMap.VPS_SSH_KEY_PATH -PathType Leaf)) {
  throw "The configured SSH private key is unavailable."
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue) -or -not (Get-Command scp -ErrorAction SilentlyContinue)) {
  throw "OpenSSH ssh and scp are required."
}
if ($DashboardUser -notmatch '^[A-Za-z0-9._-]{3,64}$') { throw "Invalid dashboard user name." }

$ipAddress = $null
if (-not [Net.IPAddress]::TryParse([string]$envMap.VPS_IP, [ref]$ipAddress) -or
    $ipAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
  throw "The public dashboard installer currently requires an IPv4 VPS address."
}
$dashboardHost = "$($ipAddress.ToString()).sslip.io"
$dashboardUrl = "https://$dashboardHost/dashboard"

$passwordBytes = [byte[]]::new(24)
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $random.GetBytes($passwordBytes)
} finally {
  $random.Dispose()
}
$dashboardPassword = [Convert]::ToBase64String($passwordBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

$privateDirectory = Split-Path -Parent $AccessFile
$resolvedWorkspace = [IO.Path]::GetFullPath($Workspace).TrimEnd('\') + '\'
$resolvedPrivate = [IO.Path]::GetFullPath($privateDirectory).TrimEnd('\') + '\'
if (-not $resolvedPrivate.StartsWith($resolvedWorkspace, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Access file must remain inside the workspace."
}
New-Item -ItemType Directory -Force -Path $privateDirectory | Out-Null
& icacls $privateDirectory /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not protect the local private directory." }

$credentialFile = Join-Path ([IO.Path]::GetTempPath()) ("dashboard-credentials-" + [guid]::NewGuid().ToString("N"))
$remoteCredential = ".cache/.dashboard-credentials-$([guid]::NewGuid().ToString('N'))"
$remote = "$($envMap.VPS_SSH_USER)@$($envMap.VPS_IP)"
$sshOptions = @(
  "-i", $envMap.VPS_SSH_KEY_PATH,
  "-o", "BatchMode=yes",
  "-o", "IdentitiesOnly=yes",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "LogLevel=ERROR"
)

try {
  $credentialPayload = (@($dashboardHost, $DashboardUser, $dashboardPassword) -join "`n") + "`n"
  [IO.File]::WriteAllText($credentialFile, $credentialPayload, [Text.UTF8Encoding]::new($false))
  & icacls $credentialFile /inheritance:r /grant:r "$($env:USERNAME):F" "SYSTEM:F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not protect the temporary credential file." }

  & ssh @sshOptions $remote "umask 077; mkdir -p -- .cache"
  if ($LASTEXITCODE -ne 0) { throw "Remote private staging failed." }
  & scp -q @sshOptions $credentialFile "${remote}:$remoteCredential"
  if ($LASTEXITCODE -ne 0) { throw "Credential staging failed." }
  & ssh @sshOptions $remote "chmod 600 -- '$remoteCredential' && bash export-ai-agent/scripts/install-public-dashboard-proxy.sh '$remoteCredential'"
  if ($LASTEXITCODE -ne 0) { throw "Public dashboard installation failed." }

  [IO.File]::WriteAllLines($AccessFile, @(
    "URL=$dashboardUrl",
    "USERNAME=$DashboardUser",
    "PASSWORD=$dashboardPassword"
  ), [Text.UTF8Encoding]::new($false))
  & icacls $AccessFile /inheritance:r /grant:r "$($env:USERNAME):F" "SYSTEM:F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not protect the dashboard access file." }
  Write-Host "[OK] Public dashboard is ready. Access details were written to a protected local file."
  Write-Host "ACCESS_FILE=$AccessFile"
} finally {
  Remove-Item -LiteralPath $credentialFile -Force -ErrorAction SilentlyContinue
  & ssh @sshOptions $remote "rm -f -- '$remoteCredential'" 2>$null | Out-Null
  [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
  $dashboardPassword = $null
}
