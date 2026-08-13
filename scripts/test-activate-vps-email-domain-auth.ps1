param(
  [string]$Workspace = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
$scriptPath = Join-Path $Workspace "scripts\activate-vps-email-domain-auth.ps1"
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
  throw "VPS email domain-auth activator is missing."
}

$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "VPS email domain-auth activator parse failed." }
$source = Get-Content -LiteralPath $scriptPath -Raw -Encoding UTF8

$parameterNames = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
if (@($parameterNames | Where-Object { $_ -match '(?i)password|passwd|secret|token|credential' }).Count -gt 0) {
  throw "Domain-auth activation must not accept credentials through command-line parameters."
}
foreach ($requiredParameter in @("Domain", "ExpectedSenderAddress", "DkimSelector", "ConfirmActivate")) {
  if ($requiredParameter -notin $parameterNames) {
    throw "Domain-auth activation is missing required parameter $requiredParameter."
  }
}
foreach ($requiredControl in @(
  'https://cloudflare-dns.com/dns-query',
  'Assert-SpfRecords',
  'Assert-DmarcRecords',
  'Assert-DkimRecords',
  'managed = "EMAIL_DOMAIN_AUTH_VERIFIED"',
  'f"{managed}=true"',
  'exec 8>"$DEPLOY_LOCK"',
  'exec 9>"$ENV_LOCK"',
  'flock -w 15',
  'BACKUP_READY=true',
  'trap on_exit EXIT',
  'rollback_activation',
  'REMOTE_RESULT=ROLLBACK_FAILED',
  'sha256sum "$BACKUP_PATH"',
  'run_root systemctl is-active --quiet',
  'rollback_ready=true',
  'os.replace(temporary, path)',
  'os.fsync(stream.fileno())',
  'chmod 600 "$BACKUP_PATH"',
  'health.get("outboundPaused") is not True',
  'readiness.get("productionSendReady") is not False',
  '"global outbound pause is active" not in blockers',
  'EMAIL_SENT=false'
)) {
  if ($source -notmatch [regex]::Escape($requiredControl)) {
    throw "Domain-auth activation is missing a required DNS, atomicity, rollback, or no-send control."
  }
}
foreach ($forbidden in @(
  'StrictHostKeyChecking=accept-new',
  'VPS_SSH_PASSWORD',
  'plink',
  'pscp',
  'Send-MailMessage',
  '.sendMail(',
  'EMAIL_DOMAIN_AUTH_VERIFIED=false" -replace',
  'cat "$ENV_PATH"'
)) {
  if ($source -match [regex]::Escape($forbidden)) {
    throw "Domain-auth activation contains a forbidden credential, trust, or email-send path."
  }
}

$beforeUnconfirmed = (Get-FileHash -Algorithm SHA256 -LiteralPath $scriptPath).Hash
$unconfirmedOutput = @()
$unconfirmedFailed = $false
try {
  $unconfirmedOutput = @(& $scriptPath -Domain "example.test" -ExpectedSenderAddress "sender@example.test" -DkimSelector "selector1" 2>&1)
} catch {
  $unconfirmedFailed = $true
  $unconfirmedOutput += $_
}
if (-not $unconfirmedFailed) { throw "Domain-auth activation did not require explicit confirmation." }
if (($unconfirmedOutput | Out-String) -notmatch 'No remote connection or change was attempted') {
  throw "Unconfirmed activation did not fail before DNS and SSH work."
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $scriptPath).Hash -ne $beforeUnconfirmed) {
  throw "Unconfirmed activation changed the source artifact."
}

$previousImportMode = $env:CRM_IMPORT_EMAIL_DOMAIN_AUTH_FUNCTIONS_ONLY
try {
  $env:CRM_IMPORT_EMAIL_DOMAIN_AUTH_FUNCTIONS_ONLY = "true"
  . $scriptPath -Domain "example.test" -ExpectedSenderAddress "sender@example.test" -DkimSelector "selector1"
} finally {
  $env:CRM_IMPORT_EMAIL_DOMAIN_AUTH_FUNCTIONS_ONLY = $previousImportMode
}

$validSpf = @("v=spf1 include:_spf.example.test -all")
$validDmarc = @("v=DMARC1; p=quarantine; rua=mailto:dmarc@example.test")
$validDkim = @("v=DKIM1; k=rsa; p=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789abcdefghijklmnopqrstuvwxyzABCD")
Assert-SpfRecords -Records $validSpf
Assert-DmarcRecords -Records $validDmarc
Assert-DkimRecords -Records $validDkim

$syntheticResponse = [pscustomobject]@{
  Status = 0
  Answer = @(
    [pscustomobject]@{ type = 16; data = '"v=DKIM1; k=rsa; " "p=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789abcdefghijklmnopqrstuvwxyzABCD"' }
  )
}
$parsedRecords = @(Get-DohTxtRecordsFromResponse -Response $syntheticResponse)
if ($parsedRecords.Count -ne 1 -or $parsedRecords[0] -ne $validDkim[0]) {
  throw "DNS presentation-string parsing did not join split TXT chunks correctly."
}

function Assert-Rejected {
  param([scriptblock]$Action, [string]$Name)
  $rejected = $false
  try { & $Action } catch { $rejected = $true }
  if (-not $rejected) { throw "Invalid $Name DNS fixture was accepted." }
}

Assert-Rejected { Assert-SpfRecords -Records @($validSpf[0], "v=spf1 -all") } "duplicate SPF"
Assert-Rejected { Assert-DmarcRecords -Records @("v=DMARC1; rua=mailto:dmarc@example.test") } "policy-less DMARC"
Assert-Rejected { Assert-DkimRecords -Records @("v=DKIM1; k=rsa; p=") } "revoked DKIM"
Assert-Rejected { Assert-DkimRecords -Records @("v=DKIM1; p=not-a-valid-key!") } "malformed DKIM"

$remoteAssignment = $ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left.Extent.Text -eq '$remoteScript'
}, $true) | Select-Object -First 1
if (-not $remoteAssignment) { throw "Embedded remote activation script is missing." }
$remoteLiteral = $remoteAssignment.Right.Extent.Text
if (-not $remoteLiteral.StartsWith("@'") -or -not $remoteLiteral.EndsWith("'@")) {
  throw "Embedded remote activation script must remain a literal single-quoted here-string."
}
$remoteSource = $remoteLiteral.Substring(2, $remoteLiteral.Length - 4)
$bashCandidates = New-Object Collections.Generic.List[string]
$gitCommand = Get-Command git -ErrorAction SilentlyContinue
if ($gitCommand) {
  $gitRoot = Split-Path -Parent (Split-Path -Parent $gitCommand.Source)
  $bashCandidates.Add((Join-Path $gitRoot "bin\bash.exe"))
  $bashCandidates.Add((Join-Path $gitRoot "usr\bin\bash.exe"))
}
foreach ($candidate in @(
  "C:\Program Files\Git\bin\bash.exe",
  "C:\Program Files\Git\usr\bin\bash.exe",
  "C:\Program Files (x86)\Git\bin\bash.exe"
)) {
  $bashCandidates.Add($candidate)
}
$pathBash = Get-Command bash -ErrorAction SilentlyContinue
if ($pathBash) { $bashCandidates.Add($pathBash.Source) }

$bashPath = $null
foreach ($candidate in @($bashCandidates | Select-Object -Unique)) {
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
  & $candidate --noprofile --norc -c 'exit 0' *> $null
  if ($LASTEXITCODE -eq 0) {
    $bashPath = $candidate
    break
  }
}
if (-not $bashPath) { throw "A working Bash runtime is required to syntax-check the embedded remote activation script." }
$temporaryBash = Join-Path ([IO.Path]::GetTempPath()) ("crm-domain-auth-" + [guid]::NewGuid().ToString("N") + ".sh")
try {
  [IO.File]::WriteAllText($temporaryBash, $remoteSource, [Text.UTF8Encoding]::new($false))
  & $bashPath --noprofile --norc -n $temporaryBash
  if ($LASTEXITCODE -ne 0) { throw "Embedded remote domain-auth activation script has invalid Bash syntax." }
} finally {
  Remove-Item -LiteralPath $temporaryBash -Force -ErrorAction SilentlyContinue
}

Write-Host "[OK] VPS email domain-auth DNS validation, atomic activation, rollback, and no-send controls passed."
