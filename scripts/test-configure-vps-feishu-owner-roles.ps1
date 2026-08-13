param([string]$Workspace = "")

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $Workspace = (Resolve-Path -LiteralPath $Workspace).Path
}

$scriptPath = Join-Path $Workspace "scripts\configure-vps-feishu-owner-roles.ps1"
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
  throw "Feishu owner-role configuration script is missing."
}
$source = Get-Content -LiteralPath $scriptPath -Raw -Encoding UTF8
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
  $scriptPath,
  [ref]$tokens,
  [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
  throw "Feishu owner-role configuration script has invalid PowerShell syntax."
}

foreach ($required in @(
  '[switch]$ConfirmConfigure',
  'DEPLOY_LOCK="${APP_DIR}.deploy.lock"',
  'ENV_LOCK="${ENV_PATH}.update.lock"',
  'OPERATOR_CANDIDATE_NOT_UNIQUE',
  'FEISHU_TRUSTED_USER_ROLES',
  '"SALES_MANAGER"',
  'os.replace(temporary, path)',
  'os.fchmod(fd, 0o600)',
  'health.get("outboundPaused") is not True',
  'health.get("sensitiveOperatorConfigured") is not True',
  'SENSITIVE_OPERATOR_CONFIGURED=true',
  'OUTBOUND_PAUSED=true',
  'EMAIL_SENT=false'
)) {
  if (-not $source.Contains($required)) {
    throw "Feishu owner-role configuration script is missing required control: $required"
  }
}

$refused = $false
try {
  & $scriptPath -Workspace $Workspace
} catch {
  $refused = $_.Exception.Message -match 'requires -ConfirmConfigure'
}
if (-not $refused) {
  throw "Feishu owner-role configuration did not refuse an unconfirmed invocation."
}

$remoteAssignment = $ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left.Extent.Text -eq '$remoteScript'
}, $true) | Select-Object -First 1
if (-not $remoteAssignment) { throw "Embedded remote owner-role script is missing." }
$remoteLiteral = $remoteAssignment.Right.Extent.Text
if (-not $remoteLiteral.StartsWith("@'") -or -not $remoteLiteral.EndsWith("'@")) {
  throw "Embedded remote owner-role script must remain a literal single-quoted here-string."
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
if (-not $bashPath) { throw "A working Bash runtime is required to syntax-check the embedded owner-role script." }

$temporaryBash = Join-Path ([IO.Path]::GetTempPath()) ("crm-feishu-owner-" + [guid]::NewGuid().ToString("N") + ".sh")
try {
  [IO.File]::WriteAllText($temporaryBash, $remoteSource, [Text.UTF8Encoding]::new($false))
  & $bashPath --noprofile --norc -n $temporaryBash
  if ($LASTEXITCODE -ne 0) { throw "Embedded remote owner-role script has invalid Bash syntax." }
} finally {
  Remove-Item -LiteralPath $temporaryBash -Force -ErrorAction SilentlyContinue
}

Write-Host "[OK] VPS Feishu owner-role atomic configuration, rollback, safe-state, and syntax controls passed."
