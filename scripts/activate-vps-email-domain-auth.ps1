param(
  [string]$Workspace = "",
  [string]$EnvPath = "",
  [Parameter(Mandatory = $true)]
  [ValidatePattern('(?i)^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')]
  [string]$Domain,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('(?i)^[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$')]
  [string]$ExpectedSenderAddress,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('(?i)^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?)*$')]
  [string]$DkimSelector,
  [switch]$ConfirmActivate,
  [ValidateRange(5, 60)]
  [int]$DnsTimeoutSeconds = 15,
  [ValidateRange(5, 60)]
  [int]$SshConnectTimeoutSeconds = 15
)

$ErrorActionPreference = "Stop"

function Get-PrivateEnvMap {
  param([string]$Path)

  $map = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line -split '=', 2
    $name = $parts[0].Trim()
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    $map[$name] = $parts[1].Trim().Trim('"').Trim("'")
  }
  return $map
}

function Get-DohResponse {
  param(
    [string]$Name,
    [ValidateSet("TXT")]
    [string]$Type,
    [int]$TimeoutSeconds
  )

  $uri = "https://cloudflare-dns.com/dns-query?name=$([uri]::EscapeDataString($Name))&type=$Type"
  return Invoke-RestMethod `
    -Method Get `
    -Uri $uri `
    -Headers @{ Accept = "application/dns-json" } `
    -TimeoutSec $TimeoutSeconds
}

function ConvertFrom-DnsPresentationString {
  param([string]$Value)

  $chunks = [regex]::Matches($Value, '"(?:\\.|[^"\\])*"')
  if ($chunks.Count -eq 0) { return $Value.Trim() }
  $text = New-Object Text.StringBuilder
  foreach ($chunk in $chunks) {
    try {
      [void]$text.Append(($chunk.Value | ConvertFrom-Json))
    } catch {
      throw "DNS TXT response contains an invalid presentation string."
    }
  }
  return $text.ToString()
}

function Get-DohTxtRecordsFromResponse {
  param([object]$Response)

  if ($null -eq $Response -or [int]$Response.Status -ne 0) { return @() }
  return @(
    @($Response.Answer) |
      Where-Object { $null -ne $_ -and [int]$_.type -eq 16 -and -not [string]::IsNullOrWhiteSpace([string]$_.data) } |
      ForEach-Object { ConvertFrom-DnsPresentationString ([string]$_.data) }
  )
}

function Resolve-PublicTxtRecords {
  param(
    [string]$Name,
    [int]$TimeoutSeconds
  )

  $current = $Name.TrimEnd('.').ToLowerInvariant()
  $visited = New-Object Collections.Generic.HashSet[string]
  for ($depth = 0; $depth -lt 6; $depth += 1) {
    if (-not $visited.Add($current)) { throw "DNS CNAME loop detected." }
    $response = Get-DohResponse -Name $current -Type TXT -TimeoutSeconds $TimeoutSeconds
    $records = @(Get-DohTxtRecordsFromResponse -Response $response)
    if ($records.Count -gt 0) { return $records }
    if ([int]$response.Status -ne 0) { return @() }
    $cname = @($response.Answer | Where-Object { $null -ne $_ -and [int]$_.type -eq 5 } | Select-Object -First 1)
    if ($cname.Count -eq 0) { return @() }
    $current = ([string]$cname[0].data).Trim().Trim('"').TrimEnd('.').ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($current)) { return @() }
  }
  throw "DNS CNAME chain is too deep."
}

function Assert-SpfRecords {
  param([string[]]$Records)

  $matches = @($Records | Where-Object { $_ -match '(?i)^v=spf1(?:\s|$)' })
  if ($matches.Count -ne 1) {
    throw "The sender domain must publish exactly one valid SPF TXT record."
  }
}

function Assert-DmarcRecords {
  param([string[]]$Records)

  $matches = @($Records | Where-Object {
    $_ -match '(?i)^v=DMARC1\s*;' -and $_ -match '(?i)(?:^|;)\s*p=(?:none|quarantine|reject)(?:;|\s|$)'
  })
  if ($matches.Count -ne 1) {
    throw "The sender domain must publish exactly one valid DMARC TXT record with a policy."
  }
}

function Assert-DkimRecords {
  param([string[]]$Records)

  $matches = @($Records | Where-Object { $_ -match '(?i)^v=DKIM1(?:\s*;|\s*$)' })
  if ($matches.Count -ne 1) {
    throw "The selected DKIM name must publish exactly one valid DKIM1 TXT record."
  }
  $publicKeyMatch = [regex]::Match($matches[0], '(?i)(?:^|;)\s*p=([^;]*)')
  if (-not $publicKeyMatch.Success) {
    throw "The selected DKIM record does not contain a public key."
  }
  $publicKey = ($publicKeyMatch.Groups[1].Value -replace '\s', '')
  if ($publicKey.Length -lt 40 -or $publicKey -notmatch '^[A-Za-z0-9+/]+={0,2}$') {
    throw "The selected DKIM record contains an empty or invalid public key."
  }
}

function Assert-PublicEmailDns {
  param(
    [string]$DomainName,
    [string]$Selector,
    [int]$TimeoutSeconds
  )

  $spf = @(Resolve-PublicTxtRecords -Name $DomainName -TimeoutSeconds $TimeoutSeconds)
  Assert-SpfRecords -Records $spf
  Write-Host "[OK] SPF DNS record verified."

  $dmarc = @(Resolve-PublicTxtRecords -Name "_dmarc.$DomainName" -TimeoutSeconds $TimeoutSeconds)
  Assert-DmarcRecords -Records $dmarc
  Write-Host "[OK] DMARC DNS record verified."

  $dkim = @(Resolve-PublicTxtRecords -Name "$Selector._domainkey.$DomainName" -TimeoutSeconds $TimeoutSeconds)
  Assert-DkimRecords -Records $dkim
  Write-Host "[OK] DKIM DNS record verified for the specified selector."
}

# Tests dot-source the pure DNS validators and stop here. This hook can only
# suppress work; it cannot authorize or mutate a production environment.
if ($env:CRM_IMPORT_EMAIL_DOMAIN_AUTH_FUNCTIONS_ONLY -eq "true") { return }

if (-not $ConfirmActivate) {
  throw "Domain-auth activation requires -ConfirmActivate. No remote connection or change was attempted."
}
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $Workspace = (Resolve-Path -LiteralPath $Workspace).Path
}
if ([string]::IsNullOrWhiteSpace($EnvPath)) { $EnvPath = Join-Path $Workspace ".env" }
if (-not (Test-Path -LiteralPath $EnvPath -PathType Leaf)) {
  throw "Private environment file is missing."
}

$Domain = $Domain.TrimEnd('.').ToLowerInvariant()
$ExpectedSenderAddress = $ExpectedSenderAddress.Trim().ToLowerInvariant()
if ($ExpectedSenderAddress.Split('@')[-1] -ne $Domain) {
  throw "Expected sender address must belong to the verified domain."
}
$DkimSelector = $DkimSelector.TrimEnd('.').ToLowerInvariant()
Assert-PublicEmailDns -DomainName $Domain -Selector $DkimSelector -TimeoutSeconds $DnsTimeoutSeconds

$envMap = Get-PrivateEnvMap -Path $EnvPath
foreach ($name in @("VPS_IP", "VPS_SSH_USER", "VPS_SSH_KEY_PATH")) {
  if ([string]::IsNullOrWhiteSpace([string]$envMap[$name])) {
    throw "Private SSH configuration is incomplete."
  }
}
if (-not (Test-Path -LiteralPath $envMap.VPS_SSH_KEY_PATH -PathType Leaf)) {
  throw "The configured SSH private key file is unavailable."
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { throw "ssh is not available." }

$remoteScript = @'
set -euo pipefail

DOMAIN_NAME="${1:-}"
EXPECTED_SENDER="${2:-}"
APP_DIR="$HOME/export-ai-agent"
ENV_PATH="$APP_DIR/.env"
SERVICE_NAME="export-ai-agent-service"
DEPLOY_LOCK="${APP_DIR}.deploy.lock"
ENV_LOCK="${ENV_PATH}.update.lock"
BACKUP_PATH=""
HEALTH_FILE=""
READINESS_FILE=""
ACTIVATION_COMPLETE=false
BACKUP_READY=false

if [[ "${EUID}" -eq 0 ]]; then
  ROOT=()
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  ROOT=(sudo -n)
else
  printf 'REMOTE_RESULT=PREREQUISITE_FAILED\n'
  exit 20
fi

run_root() {
  "${ROOT[@]}" "$@"
}

restart_service() {
  run_root systemctl restart "${SERVICE_NAME}.service" >/dev/null 2>&1
}

rollback_activation() {
  set +e
  rollback_ok=true
  if [[ "$BACKUP_READY" == true && -f "$BACKUP_PATH" ]]; then
    rollback_tmp="$(mktemp -p "$APP_DIR" .env.domain-auth.rollback.XXXXXX)"
    cp -- "$BACKUP_PATH" "$rollback_tmp" >/dev/null 2>&1 || rollback_ok=false
    chmod 600 "$rollback_tmp" >/dev/null 2>&1 || rollback_ok=false
    if [[ "$rollback_ok" == true ]]; then
      mv -f -- "$rollback_tmp" "$ENV_PATH" >/dev/null 2>&1 || rollback_ok=false
    fi
    if [[ "$rollback_ok" == true ]] &&
       [[ "$(sha256sum "$BACKUP_PATH" 2>/dev/null | awk '{print $1}')" != "$(sha256sum "$ENV_PATH" 2>/dev/null | awk '{print $1}')" ]]; then
      rollback_ok=false
    fi
    if [[ "$rollback_ok" == true ]]; then
      restart_service || rollback_ok=false
    fi
    rollback_health="$(mktemp)"
    if [[ "$rollback_ok" == true ]]; then
      rollback_ready=false
      for _ in $(seq 1 30); do
        if run_root systemctl is-active --quiet "${SERVICE_NAME}.service" &&
           curl -fsS --max-time 5 http://127.0.0.1:18790/health -o "$rollback_health" &&
           python3 - "$rollback_health" <<'PY'
import json, pathlib, sys
health = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
if not health.get("ok") or health.get("outboundPaused") is not True:
    raise SystemExit(1)
PY
        then
          rollback_ready=true
          break
        fi
        sleep 1
      done
      [[ "$rollback_ready" == true ]] || rollback_ok=false
    fi
    rm -f -- "$rollback_tmp" "$rollback_health" >/dev/null 2>&1
    if [[ "$rollback_ok" == true ]]; then
      rm -f -- "$BACKUP_PATH" >/dev/null 2>&1
      printf 'REMOTE_RESULT=ROLLED_BACK\n'
    else
      printf 'REMOTE_RESULT=ROLLBACK_FAILED\n'
    fi
  else
    printf 'REMOTE_RESULT=UNCHANGED\n'
  fi
  [[ -n "$HEALTH_FILE" ]] && rm -f -- "$HEALTH_FILE" >/dev/null 2>&1
  [[ -n "$READINESS_FILE" ]] && rm -f -- "$READINESS_FILE" >/dev/null 2>&1
}

on_exit() {
  exit_code=$?
  if [[ "$ACTIVATION_COMPLETE" != true ]]; then
    rollback_activation
  fi
  exit "$exit_code"
}
trap on_exit EXIT
trap 'exit 130' HUP INT TERM

if [[ ! -f "$ENV_PATH" ]] || [[ "$(stat -c %a "$ENV_PATH")" != "600" ]]; then
  printf 'REMOTE_RESULT=PREREQUISITE_FAILED\n'
  exit 21
fi
if ! command -v flock >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  printf 'REMOTE_RESULT=PREREQUISITE_FAILED\n'
  exit 22
fi

exec 8>"$DEPLOY_LOCK"
if ! flock -w 15 8; then
  printf 'REMOTE_RESULT=LOCKED\n'
  exit 23
fi
exec 9>"$ENV_LOCK"
if ! flock -w 15 9; then
  printf 'REMOTE_RESULT=LOCKED\n'
  exit 24
fi

HEALTH_FILE="$(mktemp)"
READINESS_FILE="$(mktemp)"
chmod 600 "$HEALTH_FILE" "$READINESS_FILE"
if ! curl -fsS --max-time 10 http://127.0.0.1:18790/health -o "$HEALTH_FILE"; then
  printf 'REMOTE_RESULT=PREREQUISITE_FAILED\n'
  exit 25
fi
python3 - "$HEALTH_FILE" <<'PY'
import json, pathlib, sys
health = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
if not health.get("ok") or health.get("outboundPaused") is not True:
    raise SystemExit(1)
if not health.get("emailChannel", {}).get("configured"):
    raise SystemExit(1)
if not health.get("emailInboundEnabled"):
    raise SystemExit(1)
PY

BACKUP_PATH="$(mktemp -p "$APP_DIR" .env.domain-auth.XXXXXX.bak)"
cp -- "$ENV_PATH" "$BACKUP_PATH"
chmod 600 "$BACKUP_PATH"
BACKUP_READY=true

MUTATION_CHANGED="$(python3 - "$ENV_PATH" "$DOMAIN_NAME" "$EXPECTED_SENDER" <<'PY'
import os, pathlib, re, sys, tempfile

path = pathlib.Path(sys.argv[1]).resolve()
domain = sys.argv[2].strip().lower().rstrip(".")
expected_sender = sys.argv[3].strip().lower()
raw = path.read_bytes()
if raw.startswith(b"\xef\xbb\xbf"):
    raise SystemExit(1)
text = raw.decode("utf-8")
newline = "\r\n" if "\r\n" in text else "\n"
lines = re.split(r"\r\n|\n|\r", text)
entry = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")
values = {}
indexes = {}
for index, line in enumerate(lines):
    if re.match(r"^\s*#", line):
        continue
    match = entry.match(line)
    if not match:
        continue
    name, value = match.group(1), match.group(2).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    values.setdefault(name, []).append(value)
    indexes.setdefault(name, []).append(index)

for required in ("EMAIL_FROM_ADDRESS", "SMTP_USER", "IMAP_USER"):
    if len(values.get(required, [])) != 1:
        raise SystemExit(1)
sender = values["EMAIL_FROM_ADDRESS"][0].strip().lower()
if sender != expected_sender or "@" not in sender or sender.rsplit("@", 1)[1] != domain:
    raise SystemExit(1)
if values["SMTP_USER"][0].strip().lower() != sender or values["IMAP_USER"][0].strip().lower() != sender:
    raise SystemExit(1)
for required, expected in (
    ("AGENT_MODE", "production"),
    ("OUTBOUND_ENABLED", "true"),
    ("EMAIL_OUTREACH_ENABLED", "true"),
    ("EMAIL_INBOUND_ENABLED", "true"),
):
    if len(values.get(required, [])) != 1 or values[required][0].strip().lower() != expected:
        raise SystemExit(1)

managed = "EMAIL_DOMAIN_AUTH_VERIFIED"
if len(indexes.get(managed, [])) > 1:
    raise SystemExit(1)
changed = True
if len(indexes.get(managed, [])) == 1:
    current = values[managed][0].strip().lower()
    if current not in ("true", "false"):
        raise SystemExit(1)
    if current == "true":
        changed = False
    else:
        lines[indexes[managed][0]] = f"{managed}=true"
else:
    if lines and lines[-1] == "":
        lines.insert(len(lines) - 1, f"{managed}=true")
    else:
        lines.append(f"{managed}=true")

if changed:
    output = newline.join(lines)
    if text.endswith(("\r", "\n")) and not output.endswith(newline):
        output += newline
    fd, temporary = tempfile.mkstemp(prefix=".env.domain-auth.", suffix=".tmp", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb", closefd=True) as stream:
            stream.write(output.encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
print("true" if changed else "false")
PY
)"
if [[ "$MUTATION_CHANGED" != "true" && "$MUTATION_CHANGED" != "false" ]]; then
  exit 26
fi
if [[ "$MUTATION_CHANGED" == "true" ]]; then
  restart_service
fi

READY=false
for _ in $(seq 1 45); do
  if curl -fsS --max-time 5 http://127.0.0.1:18790/health -o "$HEALTH_FILE" &&
     curl -fsS --max-time 5 http://127.0.0.1:18790/readiness -o "$READINESS_FILE" &&
     python3 - "$HEALTH_FILE" "$READINESS_FILE" <<'PY'
import json, pathlib, sys
health = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
readiness = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
if not health.get("ok") or health.get("outboundPaused") is not True:
    raise SystemExit(1)
if not health.get("emailChannel", {}).get("configured"):
    raise SystemExit(1)
if not health.get("imapRuntimeHealth", {}).get("sendReady"):
    raise SystemExit(1)
if not readiness.get("ok") or not readiness.get("emailConfigured"):
    raise SystemExit(1)
if not readiness.get("emailChannelState", {}).get("configured"):
    raise SystemExit(1)
if readiness.get("productionSendReady") is not False:
    raise SystemExit(1)
blockers = set(readiness.get("productionSendBlockers", []))
if "global outbound pause is active" not in blockers:
    raise SystemExit(1)
if any("domain authentication" in str(value).lower() for value in readiness.get("productionBlockers", [])):
    raise SystemExit(1)
PY
  then
    READY=true
    break
  fi
  sleep 1
done
if [[ "$READY" != true ]]; then
  exit 27
fi
if [[ "$(stat -c %a "$ENV_PATH")" != "600" ]]; then
  exit 28
fi

SELF_TEST_PASSED="$(python3 - "$READINESS_FILE" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")).get("emailChannelState", {}).get("selfTestPassed")
print("true" if value is True else "false")
PY
)"
rm -f -- "$BACKUP_PATH" "$HEALTH_FILE" "$READINESS_FILE"
BACKUP_READY=false
ACTIVATION_COMPLETE=true
printf 'REMOTE_RESULT=ACTIVATED\n'
printf 'DOMAIN_AUTH_VERIFIED=true\n'
printf 'EMAIL_CONFIGURED=true\n'
printf 'IMAP_SEND_READY=true\n'
printf 'OUTBOUND_PAUSED=true\n'
printf 'SELF_TEST_PASSED=%s\n' "$SELF_TEST_PASSED"
printf 'EMAIL_SENT=false\n'
'@

$remote = "$($envMap.VPS_SSH_USER)@$($envMap.VPS_IP)"
$sshArguments = @(
  "-i", $envMap.VPS_SSH_KEY_PATH,
  "-o", "BatchMode=yes",
  "-o", "IdentitiesOnly=yes",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "ConnectTimeout=$SshConnectTimeoutSeconds",
  "-o", "LogLevel=ERROR"
)
$remoteCommand = "bash -s -- '$Domain' '$ExpectedSenderAddress'"
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  $remoteOutput = $remoteScript | & ssh @sshArguments $remote $remoteCommand 2>$null
  $remoteExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousPreference
}
$remoteText = (($remoteOutput | ForEach-Object { [string]$_ }) -join "`n")
if ($remoteExitCode -ne 0 -or $remoteText -notmatch '(?m)^REMOTE_RESULT=ACTIVATED$') {
  throw "Remote domain-auth activation failed. The production environment was unchanged or automatically rolled back."
}
foreach ($required in @(
  "DOMAIN_AUTH_VERIFIED=true",
  "EMAIL_CONFIGURED=true",
  "IMAP_SEND_READY=true",
  "OUTBOUND_PAUSED=true",
  "EMAIL_SENT=false"
)) {
  if ($remoteText -notmatch "(?m)^$([regex]::Escape($required))$") {
    throw "Remote domain-auth activation returned an incomplete safe-state attestation."
  }
}

Write-Host "[OK] Production email domain authentication activated."
Write-Host "[OK] Service restarted only if configuration changed; readiness and IMAP health passed."
Write-Host "[OK] Global outbound remains paused; no email was sent."
Write-Host "[NEXT] Run the sender-to-self mailbox test before any explicit resume."
