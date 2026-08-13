param(
  [string]$Workspace = "",
  [string]$PackagePath = "",
  [string]$OutputDir = "",
  [int]$ExpectedSchemaVersion = 19
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $Workspace = (Resolve-Path -LiteralPath $Workspace).Path
}
if ([string]::IsNullOrWhiteSpace($PackagePath)) {
  $latest = Get-ChildItem -LiteralPath (Join-Path $Workspace "dist") -Filter "export-ai-agent-deployment-*.zip" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $latest) { throw "No deployment package found." }
  $PackagePath = $latest.FullName
} else {
  $PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $Workspace "outputs\package_smoke"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$resolvedOutputDir = (Resolve-Path -LiteralPath $OutputDir).Path
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$extractDir = Join-Path $resolvedOutputDir "package-smoke-$stamp"
$reportPath = Join-Path $resolvedOutputDir "package-smoke-$stamp.json"
$results = New-Object System.Collections.Generic.List[object]

function Get-EnvTemplateEntries {
  param([string]$Path)

  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -notmatch '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { continue }
    [pscustomobject]@{
      name = $matches[1]
      raw_value = $matches[2].Trim()
    }
  }
}

function Test-IsSensitiveEnvName {
  param([string]$Name)

  if ($Name -match '(?i)(?:^|_)(?:TOKEN|SECRET|PASSWORD|KEY|PAIRING_CODE|HOSTKEY)$') { return $true }
  if ($Name -match '(?i)^(?:FEISHU|CRM)_.*(?:APP_ID|TABLE_ID|SHEET_ID|USERS|USER_ROLES|CHATS|DESTINATIONS|CHANNEL|OPEN_IDS|CHAT_ID|WIKI_URL)$') { return $true }
  return $Name -match '(?i)^(?:EMAIL_(?:FROM_ADDRESS|FROM_NAME|REPLY_TO|UNSUBSCRIBE_TEXT)|COMPANY_POSTAL_ADDRESS|SMTP_USER|IMAP_USER|WHATSAPP_PHONE_NUMBER_ID|VPS_(?:IP|SSH_KEY_PATH)|OPENAI_BASE_URL|REACHER_BASE_URL)$'
}

function Protect-Detail {
  param([AllowNull()][object]$Text)
  $safe = [string]$Text
  if ([string]::IsNullOrEmpty($safe)) { return "" }
  $safe = $safe -replace '(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}', '[EMAIL_REDACTED]'
  $safe = $safe -replace '(?i)(://)[^/\s:@]+:[^@/\s]+@', '${1}REDACTED@'
  $safe = $safe -replace '(?i)(["'']?(?:Authorization|x-api-key)["'']?\s*[:=]\s*)(?:"[^"\r\n]*"|''[^''\r\n]*''|(?:Bearer|Basic)\s+[^\s,;&}\]\r\n]+|[^\s,;&}\]\r\n]+)', '${1}REDACTED'
  $safe = $safe -replace '(?i)((?:--?|/)[A-Za-z0-9_.-]*(?:password|token|secret|hostkey|(?:api|private|access|app|x)[_.-]?key|[_-]key)[A-Za-z0-9_.-]*\s+)(?:"[^"\r\n]*"|''[^''\r\n]*''|[^\s,;&}\]\r\n]+)', '${1}REDACTED'
  $safe = $safe -replace '(?i)(["'']?key["'']?\s*[:=]\s*)(?:"[^"\r\n]*"|''[^''\r\n]*''|[^\s,;&}\]\r\n]+)', '${1}REDACTED'
  $safe = $safe -replace '(?i)(["'']?[A-Za-z0-9_.-]*(?:password|token|secret|hostkey|(?:api|private|access|app|x)[_.-]?key|[_-]key)[A-Za-z0-9_.-]*["'']?\s*[:=]\s*)(?:"[^"\r\n]*"|''[^''\r\n]*''|[^\s,;&}\]\r\n]+)', '${1}REDACTED'
  $safe = $safe -replace '(?i)(\b(?:Bearer|Basic)\s+)[^\s,;&}\]\r\n]+', '${1}REDACTED'
  $safe = $safe -replace 'sk-[A-Za-z0-9_-]{12,}', 'sk-REDACTED'
  return $safe
}

function ConvertFrom-PowerShellCliXml {
  param([AllowNull()][string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text) -or $Text -notmatch '^\s*#< CLIXML\r?\n') {
    return [string]$Text
  }
  try {
    $payload = $Text -replace '^\s*#< CLIXML\r?\n', ''
    $items = @([System.Management.Automation.PSSerializer]::Deserialize($payload))
    return (($items | Where-Object {
      -not ($_.PSObject.Properties.Name -contains "Record") -and
        -not ($_.PSObject.Properties.Name -contains "MessageData")
    } | ForEach-Object { [string]$_ }) -join [Environment]::NewLine)
  } catch {
    return "[PowerShell diagnostic output omitted]"
  }
}

function Add-Result {
  param([string]$Area, [string]$Status, [string]$Detail)
  $safeDetail = Protect-Detail $Detail
  $results.Add([pscustomobject]@{ area = $Area; status = $Status; detail = $safeDetail }) | Out-Null
  $tag = if ($Status -eq "OK") { "[OK]" } elseif ($Status -eq "WARN") { "[WARN]" } else { "[BLOCKED]" }
  Write-Host "$tag $Area $safeDetail"
}

function Invoke-PackageCommand {
  param([string]$Area, [string]$Command)

  $lateClearLines = @($lateClearedEnvironmentNames | ForEach-Object {
    $escapedName = $_.Replace("'", "''")
    "[Environment]::SetEnvironmentVariable('$escapedName', `$null, 'Process')"
  })
  $childCommand = (@('$ErrorActionPreference = "Stop"') + $lateClearLines + @($Command)) -join [Environment]::NewLine
  $encodedCommand = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($childCommand))
  $powerShellPath = (Get-Command powershell -ErrorAction Stop).Source
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $powerShellPath
  $startInfo.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encodedCommand"
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($name in $isolatedEnvironmentNames) {
    [void]$startInfo.EnvironmentVariables.Remove($name)
  }
  foreach ($entry in $smokeEnvironment.GetEnumerator()) {
    $startInfo.EnvironmentVariables[[string]$entry.Key] = [string]$entry.Value
  }

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw "PowerShell child process did not start." }
    $standardOutputTask = $process.StandardOutput.ReadToEndAsync()
    $standardErrorTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $standardOutput = ConvertFrom-PowerShellCliXml $standardOutputTask.Result
    $standardError = ConvertFrom-PowerShellCliXml $standardErrorTask.Result
    $exitCode = $process.ExitCode
    $output = @($standardOutput, $standardError) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  } catch {
    Add-Result $Area "BLOCKED" $_.Exception.Message
    return
  } finally {
    $process.Dispose()
  }
  $detail = Protect-Detail (($output | ForEach-Object { [string]$_ }) -join " | ")
  if ($detail.Length -gt 1200) { $detail = $detail.Substring($detail.Length - 1200) }
  if ($exitCode -eq 0) {
    Add-Result $Area "OK" $detail
  } else {
    Add-Result $Area "BLOCKED" "exit=$exitCode; $detail"
  }
}

Write-Host "== Deployment package isolated extraction smoke test =="
Write-Host "Package: $PackagePath"
if (-not (Test-Path -LiteralPath $PackagePath)) { throw "Package not found: $PackagePath" }
$packageSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $PackagePath).Hash.ToLowerInvariant()

New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
Expand-Archive -LiteralPath $PackagePath -DestinationPath $extractDir -Force
Add-Result "Package extraction" "OK" "extracted_to=$extractDir"

$envTemplatePath = Join-Path $extractDir ".env.example"
$envTemplateEntries = @(Get-EnvTemplateEntries -Path $envTemplatePath)
$sensitiveTemplateEntries = @($envTemplateEntries | Where-Object { Test-IsSensitiveEnvName $_.name })
$nonEmptySensitiveTemplateNames = @($sensitiveTemplateEntries | Where-Object {
  -not [string]::IsNullOrWhiteSpace($_.raw_value)
} | ForEach-Object { $_.name })
if ($sensitiveTemplateEntries.Count -eq 0) {
  Add-Result "Sensitive env template" "BLOCKED" "no sensitive keys were derived from .env.example"
} elseif ($nonEmptySensitiveTemplateNames.Count -gt 0) {
  Add-Result "Sensitive env template" "BLOCKED" ("sensitive template keys must be empty: " + ($nonEmptySensitiveTemplateNames -join ", "))
} else {
  Add-Result "Sensitive env template" "OK" "derived $($sensitiveTemplateEntries.Count) sensitive keys; all template values are empty"
}

$isolationNamePattern = '(?i)^(?:OPENAI|OPENROUTER|NOUS|SERPER|EXA|FIRECRAWL|APIFY|HUNTER|BOUNCER|REACHER|SEARXNG|CUSTOMS|ACQ|EMAIL|SMTP|IMAP|OUTBOUND|WHATSAPP|FEISHU|CRM|INQUIRY|DATABASE|DB)_'
$inheritedIsolationNames = @(Get-ChildItem Env: | Where-Object {
  $_.Name -match $isolationNamePattern -or $_.Name -in @(
    "AGENT_DB_PATH",
    "AUTO_FOLLOWUP_ENABLED",
    "CONSUMER_EMAIL_PILOT_ENABLED",
    "DAILY_RESEARCH_ENABLED",
    "DOTENV_CONFIG_PATH",
    "EXTERNAL_SEND_REQUIRES_CONFIRMATION",
    "HERMES_RESEARCH_ENABLED",
    "REQUIRE_HUMAN_APPROVAL_BEFORE_SEND"
  )
} | ForEach-Object { $_.Name })
$isolatedEnvironmentNames = @(
  $envTemplateEntries.name + $inheritedIsolationNames + @("DATABASE_URL", "DOTENV_CONFIG_PATH") |
    Sort-Object -Unique
)
$lateClearedEnvironmentNames = @(Get-ChildItem Env: | Where-Object {
  Test-IsSensitiveEnvName $_.Name -and $_.Name -notin $isolatedEnvironmentNames
} | ForEach-Object { $_.Name } | Sort-Object -Unique)
$smokeDbPath = Join-Path $extractDir "agent_service\data\package-smoke.db"
$smokeEnvironment = [ordered]@{
  AGENT_MODE = "dry_run"
  AGENT_DB_PATH = $smokeDbPath
  OUTBOUND_ENABLED = "false"
  EMAIL_OUTREACH_ENABLED = "false"
  EMAIL_INBOUND_ENABLED = "false"
  EMAIL_SEND_REQUIRES_CONFIRMATION = "true"
  CONSUMER_EMAIL_PILOT_ENABLED = "false"
  AUTO_FOLLOWUP_ENABLED = "false"
  WHATSAPP_OUTREACH_ENABLED = "false"
  WHATSAPP_BUSINESS_API_ENABLED = "false"
  WHATSAPP_SEND_REQUIRES_CONFIRMATION = "true"
  FEISHU_BOT_ENABLED = "false"
  FEISHU_CRM_SYNC_ENABLED = "false"
  FEISHU_BITABLE_CONTROL_SYNC_ENABLED = "false"
  HERMES_RESEARCH_ENABLED = "false"
  DAILY_RESEARCH_ENABLED = "false"
  SEARCH_PROVIDER = "none"
  ACQ_SEARXNG_V2_ENABLED = "false"
  ACQ_LOCAL_PUBLIC_WEB_ENABLED = "false"
  ACQ_HUNTER_V2_ENABLED = "false"
  ACQ_BOUNCER_V2_ENABLED = "false"
  INQUIRY_FORM_WEBHOOK_ENABLED = "false"
  EXTERNAL_SEND_REQUIRES_CONFIRMATION = "true"
  REQUIRE_HUMAN_APPROVAL_BEFORE_SEND = "true"
  OUTREACH_APPROVAL_REQUIRED = "true"
}
Add-Result "Smoke process isolation" "OK" "provider, mail, Feishu, database, and inherited credential environment is cleared; outbound integrations are disabled"

$required = @(
  ".env.example",
  "deployment-manifest.json",
  "AGENT_PRODUCT_ARCHITECTURE.md",
  "AGENT_USER_GUIDE.md",
  "FEISHU_BITABLE_SCHEMA.md",
  "config/feishu-agent-scopes.json",
  "infra/support-services.compose.yml",
  "scripts/activate-vps-release.sh",
  "scripts/rollback-vps-release.sh",
  "scripts/bootstrap-vps-production.sh",
  "scripts/install-agent-service-systemd.sh",
  "scripts/install-agent-continuous-operations.sh",
  "scripts/install-public-dashboard-proxy.sh",
  "scripts/install-public-dashboard-proxy.ps1",
  "scripts/install-agent-support-services.sh",
  "scripts/run-vps-activation-acceptance.ps1",
  "scripts/run-fresh-install-acceptance.ps1",
  "scripts/check-outbound-readiness.ps1",
  "scripts/check-production-readiness.ps1",
  "scripts/audit-commercial-completion.ps1",
  "scripts/export-production-status.ps1",
  "scripts/validate-commercial-launch-inputs.ps1",
  "scripts/backup-production-state.ps1",
  "scripts/restore-production-state.ps1",
  "scripts/test-agent-service-persistence.ps1",
  "scripts/email-staged-launch-policy.ps1",
  "scripts/test-email-staged-launch-policy.ps1",
  "scripts/test-email-auth.ps1",
  "scripts/set-email-credentials.ps1",
  "scripts/test-set-email-credentials.ps1",
  "scripts/activate-vps-email-domain-auth.ps1",
  "scripts/test-activate-vps-email-domain-auth.ps1",
  "scripts/configure-vps-feishu-owner-roles.ps1",
  "scripts/test-configure-vps-feishu-owner-roles.ps1",
  "scripts/set-research-capacity.ps1",
  "scripts/test-set-research-capacity.ps1",
  "scripts/archive-and-prune-vps-old-releases.ps1",
  "scripts/test-archive-and-prune-vps-old-releases.ps1",
  "scripts/verify-vps-acquisition-state.ps1",
  "scripts/test-verify-vps-acquisition-state.ps1",
  "scripts/test-vps-deployment-scripts.ps1",
  "scripts/test-vps-db-aware-rollback.sh",
  "agent_service/package.json",
  "agent_service/package-lock.json",
  "agent_service/tsconfig.json",
  "agent_service/src/acquisition/manual-research-launch.ts",
  "agent_service/src/app.ts",
  "agent_service/src/db.ts",
  "agent_service/src/inbound/email-health.ts",
  "agent_service/src/inbound/email-listener.ts",
  "agent_service/src/integrations/bitable.ts",
  "agent_service/src/integrations/feishu/cards.ts",
  "agent_service/src/outreach/dispatcher.ts"
)
$missing = @($required | Where-Object {
  -not (Test-Path -LiteralPath (Join-Path $extractDir ($_ -replace '/', [System.IO.Path]::DirectorySeparatorChar)))
})
if ($missing.Count -eq 0) {
  Add-Result "Runtime whitelist" "OK" "all required runtime files present"
} else {
  Add-Result "Runtime whitelist" "BLOCKED" ("missing " + ($missing -join ", "))
}

$deploymentManifestPath = Join-Path $extractDir "deployment-manifest.json"
if (Test-Path -LiteralPath $deploymentManifestPath) {
  try {
    $deploymentManifest = Get-Content -LiteralPath $deploymentManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$deploymentManifest.manifestSchemaVersion -ne 1 -or
        [int]$deploymentManifest.databaseSchemaVersion -ne $ExpectedSchemaVersion -or
        [string]::IsNullOrWhiteSpace([string]$deploymentManifest.productVersion)) {
      throw "manifest does not declare database schema $ExpectedSchemaVersion and a product version"
    }
    Add-Result "Deployment manifest" "OK" "format=1; schema=$ExpectedSchemaVersion"
  } catch {
    Add-Result "Deployment manifest" "BLOCKED" $_.Exception.Message
  }
} else {
  Add-Result "Deployment manifest" "BLOCKED" "deployment-manifest.json is missing"
}

$packagedDbSource = Join-Path $extractDir "agent_service\src\db.ts"
if (Test-Path -LiteralPath $packagedDbSource) {
  $dbSourceText = Get-Content -LiteralPath $packagedDbSource -Raw -Encoding UTF8
  if ($dbSourceText -match "(?m)^export const LATEST_SCHEMA_VERSION = $ExpectedSchemaVersion;$") {
    Add-Result "Expected database schema" "OK" "schema=$ExpectedSchemaVersion"
  } else {
    Add-Result "Expected database schema" "BLOCKED" "package is not schema $ExpectedSchemaVersion"
  }
} else {
  Add-Result "Expected database schema" "BLOCKED" "agent_service/src/db.ts is missing"
}

$forbidden = @(
  ".env",
  "case_inputs",
  "customer_business_data",
  "workbook_build",
  "dist",
  "backups",
  "agent_service/data",
  "agent_service/logs",
  "agent_service/test",
  "PRODUCTION_ACCEPTANCE.md",
  "NEXT_PRODUCTION_INPUTS.md",
  "MANUAL_ACTIONS.md"
)
$forbiddenFound = @($forbidden | Where-Object {
  Test-Path -LiteralPath (Join-Path $extractDir ($_ -replace '/', [System.IO.Path]::DirectorySeparatorChar))
})
$forbiddenFound += @(Get-ChildItem -LiteralPath $extractDir -Force -Directory | Where-Object {
  $_.Name -like "real_leadgen_*" -or $_.Name -like "local_mvp_*"
} | ForEach-Object { $_.Name })
if ($forbiddenFound.Count -eq 0) {
  Add-Result "Private and non-runtime exclusion" "OK" "no seller cases, leads, databases, tests, local tools, or production notes"
} else {
  Add-Result "Private and non-runtime exclusion" "BLOCKED" ("found " + ($forbiddenFound -join ", "))
}

$privateEnv = Get-ChildItem -LiteralPath $extractDir -Recurse -Force -File |
  Where-Object { $_.Name -eq ".env" -or ($_.Name -like ".env.*" -and $_.Name -ne ".env.example") }
if ($privateEnv) {
  Add-Result "Private env exclusion" "BLOCKED" "private env files found"
} else {
  Add-Result "Private env exclusion" "OK" "no private env file in package"
}

$secretHits = Get-ChildItem -LiteralPath $extractDir -Recurse -File |
  Where-Object { $_.Extension -notin @(".node", ".dll", ".so", ".dylib", ".exe", ".bin") } |
  Select-String -Pattern '-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9._%+-]+@(gmail|googlemail|outlook|hotmail|yahoo|icloud|qq|163|126)\.com' -ErrorAction SilentlyContinue
if ($secretHits) {
  Add-Result "Secret and personal identity scan" "BLOCKED" "secret-like material or personal mailbox found"
} else {
  Add-Result "Secret and personal identity scan" "OK" "no secret-like material or personal mailbox found"
}

$envText = Get-Content -LiteralPath (Join-Path $extractDir ".env.example") -Raw -Encoding UTF8
$safeDefaults =
  $envText -match '(?m)^OUTBOUND_ENABLED=false$' -and
  $envText -match '(?m)^DAILY_RESEARCH_ENABLED=false$' -and
  $envText -match '(?m)^EXTERNAL_SEND_REQUIRES_CONFIRMATION=true$' -and
  $envText -match '(?m)^REQUIRE_HUMAN_APPROVAL_BEFORE_SEND=true$' -and
  $envText -match '(?m)^OUTREACH_APPROVAL_REQUIRED=true$'
if ($safeDefaults) {
  Add-Result "Outbound safety defaults" "OK" "external sending and daily research disabled; approval gates enabled"
} else {
  Add-Result "Outbound safety defaults" "BLOCKED" "required outbound and daily-research safety flags are missing"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $smokeDbPath) | Out-Null

Invoke-PackageCommand `
  -Area "Packaged VPS deployment scripts" `
  -Command "& '$extractDir\scripts\test-vps-deployment-scripts.ps1' -Workspace '$extractDir'"

Invoke-PackageCommand `
  -Area "Packaged research capacity updater" `
  -Command "& '$extractDir\scripts\test-set-research-capacity.ps1' -Workspace '$extractDir'"

Invoke-PackageCommand `
  -Area "Packaged server old-version archive and prune" `
  -Command "& '$extractDir\scripts\test-archive-and-prune-vps-old-releases.ps1' -Workspace '$extractDir'"

Invoke-PackageCommand `
  -Area "Packaged Agent clean install, typecheck, and build" `
  -Command "Push-Location '$extractDir\agent_service'; try { `$env:NODE_NO_WARNINGS='1'; npm ci; if (`$LASTEXITCODE -ne 0) { exit 1 }; npm run typecheck; if (`$LASTEXITCODE -ne 0) { exit 1 }; npm run build } finally { Pop-Location }; if (`$LASTEXITCODE -ne 0) { exit 1 }"

Invoke-PackageCommand `
  -Area "Packaged Agent database initialization" `
  -Command "Push-Location '$extractDir\agent_service'; try { `$env:NODE_NO_WARNINGS='1'; node dist/cli.js verify-db } finally { Pop-Location }; if (`$LASTEXITCODE -ne 0) { exit 1 }"

Invoke-PackageCommand `
  -Area "Packaged Agent V18 safe database defaults" `
  -Command "Push-Location '$extractDir\agent_service'; try { `$env:NODE_NO_WARNINGS='1'; node --input-type=module -e `"const module = await import('./dist/db.js'); const db = new module.AgentDatabase(process.env.AGENT_DB_PATH); const migration = db.getMigrationStatus(); const dailyResearch = db.getSetting('daily_research_enabled'); db.close(); if (module.LATEST_SCHEMA_VERSION !== $ExpectedSchemaVersion || migration.currentVersion !== $ExpectedSchemaVersion || migration.latestVersion !== $ExpectedSchemaVersion || dailyResearch !== 'false') process.exit(18);`" } finally { Pop-Location }; if (`$LASTEXITCODE -ne 0) { exit 1 }"

$defaultPackageDbPath = Join-Path $extractDir "agent_service\data\agent.db"
if ((Test-Path -LiteralPath $smokeDbPath) -and -not (Test-Path -LiteralPath $defaultPackageDbPath)) {
  Add-Result "Packaged Agent database isolation" "OK" "database initialized only at the package-smoke path inside the extracted package"
} else {
  Add-Result "Packaged Agent database isolation" "BLOCKED" "isolated database missing or default database path was used"
}

Invoke-PackageCommand `
  -Area "Packaged email auth disabled skip" `
  -Command "& '$extractDir\scripts\test-email-auth.ps1' -Workspace '$extractDir' -EnvPath '$extractDir\.env.example'"

$summary = [pscustomobject]@{
  generated_at = (Get-Date -Format s)
  package = $PackagePath
  package_sha256 = $packageSha256
  extract_dir = $extractDir
  blocked = @($results | Where-Object { $_.status -eq "BLOCKED" }).Count
  warnings = @($results | Where-Object { $_.status -eq "WARN" }).Count
  results = $results
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Host ""
Write-Host "Blocked: $($summary.blocked)"
Write-Host "Warnings: $($summary.warnings)"
Write-Host "[OK] Report written: $reportPath"
if ($summary.blocked -gt 0) { exit 1 }
exit 0
