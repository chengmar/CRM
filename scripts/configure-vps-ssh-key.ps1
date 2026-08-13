param(
  [string]$Workspace = "",
  [string]$EnvPath = "",
  [string]$KeyPath = "",
  [switch]$ClearStoredPassword
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $Workspace = (Resolve-Path -LiteralPath $Workspace).Path
}
if ([string]::IsNullOrWhiteSpace($EnvPath)) { $EnvPath = Join-Path $Workspace ".env" }
if ([string]::IsNullOrWhiteSpace($KeyPath)) {
  $KeyPath = Join-Path $HOME ".ssh\export_ai_agent_ed25519"
}

$envMap = @{}
foreach ($line in Get-Content -LiteralPath $EnvPath -Encoding UTF8) {
  if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
  $parts = $line -split '=', 2
  $envMap[$parts[0].Trim()] = $parts[1].Trim()
}
foreach ($key in @("VPS_IP", "VPS_SSH_USER", "VPS_SSH_PASSWORD")) {
  if ([string]::IsNullOrWhiteSpace($envMap[$key])) { throw "Missing $key in private env" }
}
foreach ($command in @("ssh-keygen", "ssh", "plink", "pscp")) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command not found" }
}

$keyDir = Split-Path -Parent $KeyPath
New-Item -ItemType Directory -Force -Path $keyDir | Out-Null
if (-not (Test-Path -LiteralPath $KeyPath)) {
  $keygen = Start-Process `
    -FilePath (Get-Command ssh-keygen -ErrorAction Stop).Source `
    -ArgumentList "-q -t ed25519 -f `"$KeyPath`" -N `"`" -C `"export-ai-agent-vps`"" `
    -Wait `
    -PassThru `
    -NoNewWindow
  if ($keygen.ExitCode -ne 0) { throw "ssh-keygen failed with exit code $($keygen.ExitCode)" }
}
if (-not (Test-Path -LiteralPath ($KeyPath + ".pub"))) { throw "SSH public key is missing" }

$remote = "$($envMap.VPS_SSH_USER)@$($envMap.VPS_IP)"
$copyArgs = @("-batch", "-pw", $envMap.VPS_SSH_PASSWORD)
$plinkArgs = @("-ssh", "-batch", "-pw", $envMap.VPS_SSH_PASSWORD, "-no-antispoof")
if (-not [string]::IsNullOrWhiteSpace($envMap.VPS_SSH_HOSTKEY)) {
  $copyArgs += @("-hostkey", $envMap.VPS_SSH_HOSTKEY)
  $plinkArgs += @("-hostkey", $envMap.VPS_SSH_HOSTKEY)
}

$previousPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  $copyOutput = & pscp @copyArgs ($KeyPath + ".pub") "${remote}:/tmp/export-ai-agent.pub" 2>&1
  $copyExit = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousPreference
}
if ($copyExit -ne 0) {
  $safe = (($copyOutput | ForEach-Object { [string]$_ }) -join "`n") -replace [regex]::Escape($envMap.VPS_SSH_PASSWORD), "REDACTED"
  throw "Public key upload failed: $safe"
}

$remoteCommand = @'
set -euo pipefail
config=/etc/ssh/sshd_config
backup="${config}.pre-export-agent-$(date +%Y%m%d%H%M%S)"
cp -a "$config" "$backup"
install -d -m 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
tr ' ' '\n' < /tmp/export-ai-agent.pub > /tmp/export-ai-agent.fragments
grep -vxF -f /tmp/export-ai-agent.fragments "$HOME/.ssh/authorized_keys" > /tmp/export-ai-agent.authorized_keys || true
cat /tmp/export-ai-agent.pub >> /tmp/export-ai-agent.authorized_keys
sort -u /tmp/export-ai-agent.authorized_keys -o /tmp/export-ai-agent.authorized_keys
install -m 600 /tmp/export-ai-agent.authorized_keys "$HOME/.ssh/authorized_keys"
if grep -Eq '^[[:space:]]*PubkeyAuthentication[[:space:]]+no[[:space:]]*$' "$config"; then
  sed -i -E 's/^[[:space:]]*PubkeyAuthentication[[:space:]]+no[[:space:]]*$/PubkeyAuthentication yes/' "$config"
elif ! grep -Eq '^[[:space:]]*PubkeyAuthentication[[:space:]]+yes[[:space:]]*$' "$config"; then
  printf '\nPubkeyAuthentication yes\n' >> "$config"
fi
if ! sshd -t; then
  cp -a "$backup" "$config"
  exit 1
fi
systemctl reload ssh.service 2>/dev/null || systemctl reload sshd.service
rm -f /tmp/export-ai-agent.pub /tmp/export-ai-agent.fragments /tmp/export-ai-agent.authorized_keys
sshd -T | grep '^pubkeyauthentication yes$'
'@

$previousPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  $remoteOutput = & plink @plinkArgs $remote $remoteCommand 2>&1
  $remoteExit = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousPreference
}
if ($remoteExit -ne 0) {
  $safe = (($remoteOutput | ForEach-Object { [string]$_ }) -join "`n") -replace [regex]::Escape($envMap.VPS_SSH_PASSWORD), "REDACTED"
  throw "Remote SSH key configuration failed: $safe"
}

$previousPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  $verifyOutput = & ssh -i $KeyPath -o BatchMode=yes -o StrictHostKeyChecking=accept-new $remote "echo key-auth-ok" 2>&1
  $verifyExit = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousPreference
}
if ($verifyExit -ne 0 -or ($verifyOutput -join "`n") -notmatch "key-auth-ok") {
  throw "SSH private-key verification failed"
}

function Update-EnvValues {
  param([hashtable]$Values)
  $current = Get-Content -LiteralPath $EnvPath -Encoding UTF8
  $pending = @{}
  foreach ($key in $Values.Keys) { $pending[$key] = [string]$Values[$key] }
  $updated = foreach ($line in $current) {
    if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=' -and $pending.ContainsKey($matches[1])) {
      $key = $matches[1]
      $value = $pending[$key]
      $pending.Remove($key)
      "$key=$value"
    } else {
      $line
    }
  }
  foreach ($key in $pending.Keys) { $updated += "$key=$($pending[$key])" }
  $updated | Set-Content -LiteralPath $EnvPath -Encoding UTF8
}

$values = @{ VPS_SSH_KEY_PATH = $KeyPath }
if ($ClearStoredPassword) { $values.VPS_SSH_PASSWORD = "" }
Update-EnvValues $values

Write-Host "[OK] SSH key authentication enabled and verified."
Write-Host "[OK] Key path: $KeyPath"
Write-Host "[OK] Existing authorized keys and password authentication were preserved."
Write-Host "[OK] Stored password cleared: $([bool]$ClearStoredPassword)"
