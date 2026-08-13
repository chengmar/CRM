param(
  [string]$Workspace = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$windowsPowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
& $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File (Join-Path $Workspace "scripts\test-verify-vps-acquisition-state.ps1") -Workspace $Workspace
if ($LASTEXITCODE -ne 0) {
  throw "VPS acquisition-state verifier tests failed with exit code $LASTEXITCODE"
}

$bashCandidates = @(
  "D:\Git\bin\bash.exe",
  "C:\Program Files\Git\bin\bash.exe",
  "C:\Program Files\Git\usr\bin\bash.exe"
)
$bashPath = ""
foreach ($candidate in $bashCandidates) {
  if (Test-Path -LiteralPath $candidate) {
    $bashPath = $candidate
    break
  }
}
if ([string]::IsNullOrWhiteSpace($bashPath)) {
  $bash = Get-Command bash -ErrorAction SilentlyContinue
  if ($bash) { $bashPath = $bash.Source }
}
if ([string]::IsNullOrWhiteSpace($bashPath)) {
  Write-Host "[WARN] bash not found; skipping shell syntax checks."
}

$shellScripts = @(
  "scripts/activate-vps-release.sh",
  "scripts/rollback-vps-release.sh",
  "scripts/bootstrap-vps-production.sh",
  "scripts/install-agent-service-systemd.sh",
  "scripts/install-agent-continuous-operations.sh",
  "scripts/install-public-dashboard-proxy.sh",
  "scripts/install-agent-support-services.sh",
  "scripts/test-vps-db-aware-rollback.sh"
)

foreach ($rel in $shellScripts) {
  $path = Join-Path $Workspace $rel
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing VPS shell script: $path"
  }
  if (-not [string]::IsNullOrWhiteSpace($bashPath)) {
    & $bashPath -n $path
    if ($LASTEXITCODE -ne 0) {
      throw "bash syntax failed for $rel with exit code $LASTEXITCODE"
    }
    Write-Host "[OK] bash syntax: $rel"
  } else {
    Write-Host "[WARN] skipped bash syntax: $rel"
  }
}

$supportInstallerText = Get-Content -LiteralPath (
  Join-Path $Workspace "scripts\install-agent-support-services.sh"
) -Raw -Encoding UTF8
foreach ($engine in @("mojeek", "presearch", "dogpile", "yandex")) {
  $pattern = "(?ms)- name: $([regex]::Escape($engine))\s+disabled: false"
  if ($supportInstallerText -notmatch $pattern) {
    throw "SearXNG production engine must be enabled: $engine"
  }
}
foreach ($engine in @("bing", "yahoo", "brave", "duckduckgo", "google cse", "startpage")) {
  $pattern = "(?ms)- name: $([regex]::Escape($engine))\s+disabled: true"
  if ($supportInstallerText -notmatch $pattern) {
    throw "Known-bad SearXNG production engine must be disabled: $engine"
  }
}
foreach ($required in @(
  "sample+product+supplier+Malaysia",
  'text.includes("product")',
  'text.includes("malaysia")',
  'search_relevant',
  'did not return relevant industrial acquisition results'
)) {
  if ($supportInstallerText -notmatch [regex]::Escape($required)) {
    throw "SearXNG deployment acceptance is missing relevance enforcement: $required"
  }
}
Write-Host "[OK] SearXNG defaults use verified engines and enforce industrial-result relevance"

$bootstrapText = Get-Content -LiteralPath (Join-Path $Workspace "scripts\bootstrap-vps-production.sh") -Raw -Encoding UTF8
foreach ($required in @(
  "docker-ce",
  "docker-compose-plugin",
  "systemctl enable --now docker",
  'HERMES_COMMIT="46e87b14fd6c943ef0d6671fb0d74c5dde5d4c6b"',
  'HERMES_INSTALLER_SHA256="c2e4326c1660bd45f64321996eb15bda35e7a4649e32a310495a61972a2804c8"',
  'OPENCLAW_VERSION="2026.7.1"',
  'sha256sum -c -',
  'openclaw@${OPENCLAW_VERSION}',
  'base_runtime_ready=true',
  'command -v "${required_command}"',
  '/etc/ssl/certs/ca-certificates.crt',
  'if [[ "${base_runtime_ready}" != "true" ]]',
  'Base VPS runtime is already installed; skipping OS package refresh.'
)) {
  if ($bootstrapText -notmatch [regex]::Escape($required)) {
    throw "VPS bootstrap is missing required Docker setup: $required"
  }
}
Write-Host "[OK] VPS bootstrap installs Docker Engine and Compose"

$composeText = Get-Content -LiteralPath (Join-Path $Workspace "infra\support-services.compose.yml") -Raw -Encoding UTF8
if ($composeText -match '(?m)^\s*image:\s*\S+:latest\s*$') {
  throw "Support service images must not use latest tags"
}
foreach ($digest in @(
  "sha256:11ffedd387dc9cf99e881250c67861470384e55194a86f76df76aa0034a28a1a",
  "sha256:cb73c2ee5bd684e014174aba64316d6cd567260f6c6c97fcda47de3fc95f7266"
)) {
  if ($composeText -notmatch [regex]::Escape($digest)) {
    throw "Support service image digest is missing: $digest"
  }
}
Write-Host "[OK] Support service images are digest-pinned"

foreach ($rel in @(
  "scripts\run-vps-activation-acceptance.ps1",
  "scripts\backup-production-state.ps1",
  "scripts\restore-production-state.ps1",
  "scripts\package-deployment-bundle.ps1",
  "scripts\test-deployment-package.ps1",
  "scripts\email-staged-launch-policy.ps1",
  "scripts\test-email-staged-launch-policy.ps1",
  "scripts\test-email-auth.ps1",
  "scripts\set-email-credentials.ps1",
  "scripts\test-set-email-credentials.ps1",
  "scripts\activate-vps-email-domain-auth.ps1",
  "scripts\test-activate-vps-email-domain-auth.ps1",
  "scripts\configure-vps-feishu-owner-roles.ps1",
  "scripts\test-configure-vps-feishu-owner-roles.ps1",
  "scripts\archive-and-prune-vps-old-releases.ps1",
  "scripts\test-archive-and-prune-vps-old-releases.ps1",
  "scripts\test-agent-service-persistence.ps1",
  "scripts\run-fresh-install-acceptance.ps1"
)) {
  $scriptPath = Join-Path $Workspace $rel
  if (-not (Test-Path -LiteralPath $scriptPath)) { throw "Missing $rel" }
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile(
    $scriptPath,
    [ref]$tokens,
    [ref]$errors
  )
  if ($errors.Count -gt 0) { throw "$rel parse failed: $($errors[0].Message)" }
  Write-Host "[OK] PowerShell syntax: $rel"
}

$privacyScripts = @(
  "scripts\test-email-auth.ps1",
  "scripts\run-vps-activation-acceptance.ps1",
  "scripts\run-fresh-install-acceptance.ps1",
  "scripts\test-deployment-package.ps1"
)
$privateMarker = "private-value-" + [guid]::NewGuid().ToString("N")
$privateMailbox = "operator@$privateMarker.example"
$unsafeDetail = @"
mailbox=$privateMailbox Authorization: Bearer $privateMarker x-api-key=$privateMarker SMTP_PASSWORD=$privateMarker --access-token $privateMarker "api_key": "$privateMarker" client_secret=$privateMarker --private-key $privateMarker https://login:$privateMarker@service.example/
"@
foreach ($rel in $privacyScripts) {
  $scriptPath = Join-Path $Workspace $rel
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $scriptPath,
    [ref]$tokens,
    [ref]$errors
  )
  $protectAst = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -eq "Protect-Detail"
  }, $true)
  if ($null -eq $protectAst) { throw "$rel must define Protect-Detail." }
  Invoke-Expression $protectAst.Extent.Text
  $safeDetail = Protect-Detail $unsafeDetail
  if ($safeDetail.Contains($privateMarker) -or $safeDetail.Contains($privateMailbox)) {
    throw "$rel Protect-Detail leaked a private fixture value."
  }
  foreach ($requiredMarker in @("[EMAIL_REDACTED]", "Authorization: REDACTED", "x-api-key=REDACTED", "SMTP_PASSWORD=REDACTED", "--access-token REDACTED")) {
    if (-not $safeDetail.Contains($requiredMarker)) {
      throw "$rel Protect-Detail did not redact $requiredMarker."
    }
  }
}
Write-Host "[OK] Acceptance logs redact mailbox and credential-bearing details"

$emailAuthText = Get-Content -LiteralPath (Join-Path $Workspace "scripts\test-email-auth.ps1") -Raw -Encoding UTF8
foreach ($required in @(
  'Write-Host "[OK] SMTP auth=accepted"',
  'Write-Host "[OK] IMAP auth=accepted"',
  'if ($Port -eq 465)',
  '$writer.WriteLine("STARTTLS")',
  'Test-SmtpAuth -HostName $envMap.SMTP_HOST -Port $smtpPort',
  'Test-ImapAuth -HostName $envMap.IMAP_HOST -Port $imapPort',
  'Write-Host "email_sent=false"'
)) {
  if ($emailAuthText -notmatch [regex]::Escape($required)) {
    throw "Email auth smoke must emit identity-free success status: $required"
  }
}
foreach ($forbidden in @(
  "smtp.googlemail.com",
  "smtp.gmail.com",
  "imap.googlemail.com",
  "imap.gmail.com",
  "Get-HostCandidates",
  "Invoke-EmailAuthWithFallback"
)) {
  if ($emailAuthText -match [regex]::Escape($forbidden)) {
    throw "Email auth smoke must use only the configured mail hosts: $forbidden"
  }
}
$implicitTlsBlock = [regex]::Match(
  $emailAuthText,
  '(?s)if \(\$Port -eq 465\) \{(?<body>.*?)\r?\n\s*\}'
)
if (-not $implicitTlsBlock.Success -or
    $implicitTlsBlock.Groups["body"].Value -notmatch [regex]::Escape('$ssl.AuthenticateAsClient($HostName)') -or
    $implicitTlsBlock.Groups["body"].Value -match [regex]::Escape('STARTTLS')) {
  throw "Email auth smoke must establish implicit TLS before SMTP protocol reads on port 465."
}
foreach ($forbiddenCommand in @('MAIL FROM', 'RCPT TO', 'DATA')) {
  if ($emailAuthText -match [regex]::Escape($forbiddenCommand)) {
    throw "Email auth smoke must authenticate without sending mail: $forbiddenCommand"
  }
}
if ($emailAuthText -match 'Write-Host[^\r\n]*(?:\$Workspace|\$EnvPath|\$hostName|\$envMap\.(?:SMTP|IMAP)_USER)') {
  throw "Email auth smoke must not write workspace, env path, host, or mailbox identity."
}
Write-Host "[OK] Email auth smoke supports configured-host implicit TLS and STARTTLS without sending mail"
& (Join-Path $Workspace "scripts\test-email-staged-launch-policy.ps1") -Workspace $Workspace
if ($LASTEXITCODE -ne 0) {
  throw "Email staged launch policy tests failed with exit code $LASTEXITCODE"
}
& (Join-Path $Workspace "scripts\test-set-email-credentials.ps1") -Workspace $Workspace
if ($LASTEXITCODE -ne 0) {
  throw "Secure email credential updater tests failed with exit code $LASTEXITCODE"
}
& (Join-Path $Workspace "scripts\test-activate-vps-email-domain-auth.ps1") -Workspace $Workspace
if ($LASTEXITCODE -ne 0) {
  throw "VPS email domain-auth activator tests failed with exit code $LASTEXITCODE"
}
& (Join-Path $Workspace "scripts\test-configure-vps-feishu-owner-roles.ps1") -Workspace $Workspace
if ($LASTEXITCODE -ne 0) {
  throw "VPS Feishu owner-role configurator tests failed with exit code $LASTEXITCODE"
}
foreach ($rel in @(
  "scripts\run-vps-activation-acceptance.ps1",
  "scripts\run-fresh-install-acceptance.ps1"
)) {
  $acceptancePrivacyText = Get-Content -LiteralPath (Join-Path $Workspace $rel) -Raw -Encoding UTF8
  foreach ($required in @(
    'workspace = Protect-Detail $Workspace',
    'business_data_dir = Protect-Detail $businessDataDir',
    'Write-Host "[OK] Report: $(Protect-Detail $reportPath)"'
  )) {
    if ($acceptancePrivacyText -notmatch [regex]::Escape($required)) {
      throw "$rel must redact report fields and the displayed report path."
    }
  }
}
Write-Host "[OK] Acceptance JSON and report paths use redacted values"

$activationText = Get-Content -LiteralPath (Join-Path $Workspace "scripts\activate-vps-release.sh") -Raw -Encoding UTF8
if ($activationText -notmatch [regex]::Escape("scripts/run-vps-activation-acceptance.ps1")) {
  throw "Release activation must run the generic pre-pair acceptance."
}
if ($activationText -match [regex]::Escape("scripts/run-vps-production-acceptance.ps1")) {
  throw "Release activation still references the seller-specific legacy acceptance."
}
if ($activationText -notmatch [regex]::Escape('"${BUSINESS_DATA_RELATIVE}"')) {
  throw "Release activation must preserve the configured business data directory."
}
if ([regex]::Matches($activationText, [regex]::Escape('"private"')).Count -lt 2) {
  throw "Release activation must preserve the private runtime directory across upgrades."
}
foreach ($required in @(
  'ROLLBACK_STATE_DIR="${APP_DIR}.rollback-state"',
  'assert_supported_database_path',
  'force_safe_database_settings',
  'snapshot_predeploy_database',
  'restore_predeploy_database_to "${PREVIOUS_DIR}"',
  'systemctl disable --now "${DAILY_SERVICE_NAME}.timer"',
  'systemctl enable --now "${BACKUP_SERVICE_NAME}.timer"'
)) {
  if ($activationText -notmatch [regex]::Escape($required)) {
    throw "Release activation is missing database-aware safety: $required"
  }
}
if ($activationText -match 'for relative in "agent_service/data"') {
  throw "Release rollback must not copy a migrated database into the previous release."
}
$serviceStopIndex = $activationText.IndexOf('systemctl stop "${SERVICE_NAME}.service"')
$databaseRestoreIndex = $activationText.IndexOf('restore_directory "agent_service/data"')
if ($serviceStopIndex -lt 0 -or $databaseRestoreIndex -lt 0 -or $serviceStopIndex -gt $databaseRestoreIndex) {
  throw "Release activation must stop the Agent before copying its SQLite directory."
}
Write-Host "[OK] Release activation uses generic pre-pair acceptance"

$activationAcceptanceText = Get-Content -LiteralPath (Join-Path $Workspace "scripts\run-vps-activation-acceptance.ps1") -Raw -Encoding UTF8
if ($activationAcceptanceText -notmatch [regex]::Escape("Wait-AgentEndpoint")) {
  throw "Activation acceptance must wait for the Agent health endpoint."
}
Write-Host "[OK] Release activation preserves business data and waits for service readiness"

$rollbackText = Get-Content -LiteralPath (Join-Path $Workspace "scripts\rollback-vps-release.sh") -Raw -Encoding UTF8
foreach ($required in @(
  'DEPLOY_LOCK="${APP_DIR}.deploy.lock"',
  'flock -n 9',
  'Release rollback supports only the managed default AGENT_DB_PATH.',
  'ROLLBACK_STATE_DIR="${APP_DIR}.rollback-state"',
  'stage_non_database_runtime',
  'restore_predeploy_database_to "${PREVIOUS_DIR}"',
  'mv "${APP_DIR}" "${REPLACED_DIR}"',
  'systemctl disable --now "${DAILY_SERVICE_NAME}.timer"'
)) {
  if ($rollbackText -notmatch [regex]::Escape($required)) {
    throw "Manual rollback is missing database-aware safety: $required"
  }
}
if ($rollbackText -match 'for relative in "agent_service/data"') {
  throw "Manual rollback must retain the current database with the replaced release."
}
Write-Host "[OK] Automatic and manual rollback keep database versions paired with their releases"

foreach ($expectation in @(
  @{ rel = "scripts\run-vps-activation-acceptance.ps1"; schema = 19 },
  @{ rel = "scripts\run-fresh-install-acceptance.ps1"; schema = 18 }
)) {
  $rel = $expectation.rel
  $expectedSchema = $expectation.schema
  $acceptanceText = Get-Content -LiteralPath (Join-Path $Workspace $rel) -Raw -Encoding UTF8
  if ($acceptanceText -notmatch [regex]::Escape("`$ExpectedSchemaVersion = $expectedSchema") -or
      $acceptanceText -notmatch [regex]::Escape('$health.latestSchemaVersion') -or
      $acceptanceText -notmatch [regex]::Escape('systemctl is-active --quiet export-ai-agent-backup.timer') -or
      $acceptanceText -notmatch [regex]::Escape('systemctl is-enabled --quiet export-ai-agent-daily.timer')) {
    throw "$rel must explicitly require database schema v$expectedSchema."
  }
  foreach ($requiredCapabilityGate in @(
    '$emailOutreachEnabled = (Get-EnvValue $envText "EMAIL_OUTREACH_ENABLED" "false")',
    '$expectedOutboundCapability',
    'OUTBOUND_ENABLED',
    '$emailOutreachEnabled -and -not $health.outboundEnabled',
    '-not $emailOutreachEnabled -and $health.outboundEnabled',
    'if (-not $health.outboundPaused)',
    'enterprise SMTP/IMAP send-receive self-test has not passed',
    '!ensureEmailChannelState(this.config, this.db).selfTestPassed',
    'email_send_receive_self_test_required = [bool]$enterpriseEmail'
  )) {
    if ($acceptanceText -notmatch [regex]::Escape($requiredCapabilityGate)) {
      throw "$rel is missing the enterprise capability/pause/self-test gate: $requiredCapabilityGate"
    }
  }
}
Write-Host "[OK] Existing VPS activation requires schema v19 while fresh installation remains on v18"

foreach ($required in @(
  '$health.feishuConnected',
  '$health.dailyResearchEnabled',
  'Strict search runtime is not configured.',
  'ACQ_LOCAL_PUBLIC_WEB_ENABLED'
)) {
  if ($activationAcceptanceText -notmatch [regex]::Escape($required)) {
    throw "Activation acceptance is missing strict runtime requirement: $required"
  }
}
Write-Host "[OK] Activation acceptance requires Feishu and strict paused research runtime"

foreach ($requiredDeploymentSafeEmailGate in @(
  '$domainAuthVerified',
  '$health.outboundPaused',
  'SMTP and IMAP no-send authentication'
)) {
  if ($activationAcceptanceText -notmatch [regex]::Escape($requiredDeploymentSafeEmailGate)) {
    throw "Activation acceptance is missing deployment-safe enterprise email gating: $requiredDeploymentSafeEmailGate"
  }
}
if ($activationAcceptanceText -match '@\("EMAIL_DOMAIN_AUTH_VERIFIED",\s*"true"\)') {
  throw "Activation acceptance must allow a paused code deployment before domain authentication is complete."
}
Write-Host "[OK] Activation accepts paused enterprise email before DKIM while preserving the send-ready gate"

$deployText = Get-Content -LiteralPath (Join-Path $Workspace "scripts\deploy-to-vps.ps1") -Raw -Encoding UTF8
foreach ($required in @(
  'requires an explicit -PackagePath to a validated schema-19 deployment ZIP',
  'function Assert-DeploymentPackage',
  'deployment-manifest.json',
  'agent_service/src/acquisition/manual-research-launch.ts',
  'agent_service/src/inbound/email-health.ts',
  'databaseSchemaVersion -ne 19',
  'if ($UploadPrivateEnv)',
  'if ($UploadPrivateEnv -and -not $ConfirmUploadPrivateEnv)',
  'export-ai-agent-private-$([guid]::NewGuid()',
  '("export-ai-agent-env-" + [guid]::NewGuid()',
  'mkdir -m 700 -- ''$remotePrivateDir''',
  'chmod 600 -- ''$remoteEnv''',
  'REMOTE_ENV_PATH="$remoteEnv"',
  '$remoteCommandBase64',
  "base64 -d | bash",
  'finally {',
  'rm -rf -- ''$remotePrivateDir''',
  'Remove-Item -LiteralPath $tempEnvForUpload -Force'
)) {
  if ($deployText -notmatch [regex]::Escape($required)) {
    throw "VPS deploy script is missing private-env cleanup safety: $required"
  }
}
if ($deployText -match [regex]::Escape('/tmp/export-ai-agent.env')) {
  throw "VPS deploy script must not reuse a fixed remote private-env path."
}
Write-Host "[OK] VPS deploy uses a unique optional private-env path and guaranteed cleanup"

$packageScriptPath = Join-Path $Workspace "scripts\package-deployment-bundle.ps1"
$packageText = Get-Content -LiteralPath $packageScriptPath -Raw -Encoding UTF8
if ($packageText -notmatch [regex]::Escape('scripts\restore-production-state.ps1')) {
  throw "Deployment bundle must include restore-production-state.ps1."
}
foreach ($requiredPolicyFile in @(
  'scripts\check-outbound-readiness.ps1',
  'scripts\check-production-readiness.ps1',
  'scripts\audit-commercial-completion.ps1',
  'scripts\export-production-status.ps1',
  'scripts\validate-commercial-launch-inputs.ps1',
  'scripts\email-staged-launch-policy.ps1',
  'scripts\test-email-staged-launch-policy.ps1',
  'scripts\configure-vps-feishu-owner-roles.ps1',
  'scripts\test-configure-vps-feishu-owner-roles.ps1'
)) {
  if ($packageText -notmatch [regex]::Escape($requiredPolicyFile)) {
    throw "Deployment bundle must include $requiredPolicyFile."
  }
}
foreach ($required in @(
  'deployment-manifest.json',
  'databaseSchemaVersion = $ExpectedSchemaVersion',
  "function Get-EnvTemplateEntries",
  "function Test-IsSensitiveEnvName",
  '$sensitiveEnvNames = @($envTemplateEntries',
  'Get-PrivateEnvValue $matches[2]',
  'all template values are empty'
)) {
  if ($packageText -notmatch [regex]::Escape($required)) {
    throw "Deployment bundle is missing automatic sensitive-env enforcement: $required"
  }
}
$packageTokens = $null
$packageErrors = $null
$packageAst = [System.Management.Automation.Language.Parser]::ParseFile(
  $packageScriptPath,
  [ref]$packageTokens,
  [ref]$packageErrors
)
foreach ($functionName in @("Get-EnvTemplateEntries", "Test-IsSensitiveEnvName", "Get-PrivateEnvValue")) {
  $functionAst = $packageAst.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -eq $functionName
  }, $true)
  if ($null -eq $functionAst) {
    throw "Deployment bundle must define $functionName."
  }
  Invoke-Expression $functionAst.Extent.Text
}
$templateEntries = @(Get-EnvTemplateEntries -Path (Join-Path $Workspace ".env.example"))
$derivedSensitiveEntries = @($templateEntries | Where-Object { Test-IsSensitiveEnvName $_.name })
foreach ($requiredName in @("OPENAI_API_KEY", "FEISHU_APP_ID", "SMTP_PASSWORD", "HUNTER_API_KEY", "BOUNCER_API_KEY")) {
  if ($requiredName -notin $derivedSensitiveEntries.name) {
    throw ".env.example sensitive-key derivation missed $requiredName."
  }
}
if ($derivedSensitiveEntries | Where-Object { -not [string]::IsNullOrWhiteSpace($_.raw_value) }) {
  throw ".env.example contains a non-empty sensitive template value."
}
if ((Get-PrivateEnvValue '"fixture#value"') -ne "fixture#value") {
  throw "Deployment bundle private-env parser does not preserve a quoted value."
}

$packageSmokeText = Get-Content -LiteralPath (Join-Path $Workspace "scripts\test-deployment-package.ps1") -Raw -Encoding UTF8
foreach ($required in @(
  'deployment-manifest.json',
  'agent_service/src/acquisition/manual-research-launch.ts',
  'agent_service/src/inbound/email-health.ts',
  '$deploymentManifest.databaseSchemaVersion -ne $ExpectedSchemaVersion',
  '$envTemplateEntries.name + $inheritedIsolationNames',
  '$lateClearedEnvironmentNames = @(Get-ChildItem Env:',
  'Test-IsSensitiveEnvName $_.Name -and $_.Name -notin $isolatedEnvironmentNames',
  '$lateClearLines = @($lateClearedEnvironmentNames',
  'AGENT_DB_PATH = $smokeDbPath',
  'OUTBOUND_ENABLED = "false"',
  'EMAIL_OUTREACH_ENABLED = "false"',
  'FEISHU_BOT_ENABLED = "false"',
  'ACQ_HUNTER_V2_ENABLED = "false"',
  'ACQ_BOUNCER_V2_ENABLED = "false"',
  '-EncodedCommand $encodedCommand',
  '$startInfo.EnvironmentVariables.Remove($name)',
  '$startInfo.EnvironmentVariables[[string]$entry.Key] = [string]$entry.Value',
  '$safeDetail = Protect-Detail $Detail',
  'ConvertFrom-PowerShellCliXml',
  'Packaged Agent database isolation',
  'Packaged Agent V18 safe database defaults',
  "db.getSetting('daily_research_enabled')"
)) {
  if ($packageSmokeText -notmatch [regex]::Escape($required)) {
    throw "Package smoke is missing process-isolation or privacy enforcement: $required"
  }
}
Write-Host "[OK] Deployment bundle and package smoke enforce automatic secret checks and isolated no-send execution"

$freshAcceptanceText = Get-Content -LiteralPath (Join-Path $Workspace "scripts\run-fresh-install-acceptance.ps1") -Raw -Encoding UTF8
foreach ($required in @(
  'if ($health.dailyResearchEnabled)',
  'daily_research_enabled = $false'
)) {
  if ($freshAcceptanceText -notmatch [regex]::Escape($required)) {
    throw "Fresh-install acceptance is missing the daily-research disabled assertion: $required"
  }
}
Write-Host "[OK] Fresh-install acceptance requires daily research to remain disabled"

$appText = Get-Content -LiteralPath (Join-Path $Workspace "agent_service\src\app.ts") -Raw -Encoding UTF8
if ($appText -notmatch [regex]::Escape('dailyResearchEnabled: dailyResearch.isEnabled()')) {
  throw "Health must report the effective daily-research scheduler state."
}
Write-Host "[OK] Health reports the effective daily-research scheduler state"

$serviceText = Get-Content -LiteralPath (Join-Path $Workspace "scripts\install-agent-service-systemd.sh") -Raw -Encoding UTF8
if ($serviceText -notmatch [regex]::Escape('mkdir -p data logs "${APP_DIR}/outputs"')) {
  throw "Agent service installation must create the writable outputs directory."
}
Write-Host "[OK] Agent service installer creates all writable directories"

if ($serviceText -notmatch 'Environment=PATH=.*\.local/bin' -or
    $serviceText -notmatch 'ReadWritePaths=.*\.hermes.*\.cache') {
  throw "Agent service installer must expose Hermes on PATH and allow its private runtime directories."
}
Write-Host "[OK] Agent service can execute Hermes with private writable runtime directories"

$continuousText = Get-Content -LiteralPath (Join-Path $Workspace "scripts\install-agent-continuous-operations.sh") -Raw -Encoding UTF8
foreach ($required in @(
  "schedule-continuous-acquisition",
  "replay-autonomous-messages --confirm-enqueue",
  "OnUnitActiveSec=",
  "Persistent=true",
  'SERVICE_NAME="export-ai-agent-continuous"'
)) {
  if ($continuousText -notmatch [regex]::Escape($required)) {
    throw "Continuous operations installer is missing: $required"
  }
}
Write-Host "[OK] Continuous operations safely schedules acquisition and replenishes authorized messages"

$dashboardProxyText = Get-Content -LiteralPath (Join-Path $Workspace "scripts\install-public-dashboard-proxy.sh") -Raw -Encoding UTF8
foreach ($required in @(
  "caddy:2.10.2-alpine",
  "basic_auth @dashboard",
  "reverse_proxy @dashboard 127.0.0.1:18790",
  "respond 404",
  "DASHBOARD_PROXY_AUTH=REQUIRED"
)) {
  if ($dashboardProxyText -notmatch [regex]::Escape($required)) {
    throw "Public dashboard proxy installer is missing: $required"
  }
}
$dashboardProxyPowerShell = Join-Path $Workspace "scripts\install-public-dashboard-proxy.ps1"
$parseErrors = $null
[Management.Automation.Language.Parser]::ParseFile($dashboardProxyPowerShell, [ref]$null, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count -gt 0) { throw "Public dashboard PowerShell installer has syntax errors." }
Write-Host "[OK] Public dashboard uses authenticated HTTPS and a protected local access file"

if (-not [string]::IsNullOrWhiteSpace($bashPath)) {
  $nativePython = Get-Command python -ErrorAction SilentlyContinue
  $previousTestPython = $env:VPS_ROLLBACK_TEST_PYTHON
  try {
    if ($nativePython) { $env:VPS_ROLLBACK_TEST_PYTHON = $nativePython.Source }
    & $bashPath (Join-Path $Workspace "scripts\test-vps-db-aware-rollback.sh")
    if ($LASTEXITCODE -ne 0) {
      throw "Database-aware VPS rollback behavior test failed with exit code $LASTEXITCODE"
    }
  } finally {
    $env:VPS_ROLLBACK_TEST_PYTHON = $previousTestPython
  }
}

Write-Host "[OK] VPS deployment scripts validated."
