param(
  [string]$Workspace = "",
  [string]$OutputDir = "",
  [string]$PackageName = "",
  [int]$ExpectedSchemaVersion = 19,
  [switch]$IncludeDemoData,
  [switch]$IncludeRealData,
  [switch]$SkipPrivateLocalValueCrossCheck
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $Workspace "dist"
}

if ([string]::IsNullOrWhiteSpace($PackageName)) {
  $PackageName = "export-ai-agent-deployment-" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".zip"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$resolvedOutputDir = (Resolve-Path -LiteralPath $OutputDir).Path

$stage = Join-Path $OutputDir "deployment-stage"
if (Test-Path -LiteralPath $stage) {
  $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
  if (-not $resolvedStage.StartsWith($resolvedOutputDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove stage outside output dir: $resolvedStage"
  }
  Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null

function Copy-RelFile {
  param([string]$Rel)
  $src = Join-Path $Workspace $Rel
  if (-not (Test-Path -LiteralPath $src)) {
    throw "Required deployment file is missing: $Rel"
  }
  $dst = Join-Path $stage $Rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  Copy-Item -LiteralPath $src -Destination $dst -Force
  Write-Host "[OK] staged file $Rel"
}

function Copy-RelDir {
  param([string]$Rel)
  $src = Join-Path $Workspace $Rel
  if (-not (Test-Path -LiteralPath $src)) {
    throw "Required deployment directory is missing: $Rel"
  }
  $dst = Join-Path $stage $Rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
  Write-Host "[OK] staged directory $Rel"
}

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

function Get-PrivateEnvValue {
  param([string]$RawValue)

  $trimmed = $RawValue.Trim()
  if ($trimmed -match '^"(.*)"\s*(?:#.*)?$') { return $matches[1] }
  if ($trimmed -match "^'(.*)'\s*(?:#.*)?$") { return $matches[1] }
  return ($trimmed -replace '\s+#.*$', '').Trim()
}

$files = @(
  ".env.example",
  "AGENT_PRODUCT_ARCHITECTURE.md",
  "AGENT_USER_GUIDE.md",
  "FEISHU_BITABLE_SCHEMA.md",
  "config\feishu-agent-scopes.json",
  "infra\support-services.compose.yml",
  "scripts\backup-production-state.ps1",
  "scripts\restore-production-state.ps1",
  "scripts\deploy-to-vps.ps1",
  "scripts\activate-vps-release.sh",
  "scripts\rollback-vps-release.sh",
  "scripts\bootstrap-vps-production.sh",
  "scripts\install-agent-service-systemd.sh",
  "scripts\install-agent-continuous-operations.sh",
  "scripts\install-public-dashboard-proxy.sh",
  "scripts\install-public-dashboard-proxy.ps1",
  "scripts\install-agent-support-services.sh",
  "scripts\run-vps-activation-acceptance.ps1",
  "scripts\run-fresh-install-acceptance.ps1",
  "scripts\check-outbound-readiness.ps1",
  "scripts\check-production-readiness.ps1",
  "scripts\audit-commercial-completion.ps1",
  "scripts\export-production-status.ps1",
  "scripts\validate-commercial-launch-inputs.ps1",
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
  "scripts\set-research-capacity.ps1",
  "scripts\test-set-research-capacity.ps1",
  "scripts\archive-and-prune-vps-old-releases.ps1",
  "scripts\test-archive-and-prune-vps-old-releases.ps1",
  "scripts\test-agent-service-persistence.ps1",
  "scripts\verify-vps-acquisition-state.ps1",
  "scripts\test-verify-vps-acquisition-state.ps1",
  "scripts\test-vps-deployment-scripts.ps1",
  "scripts\test-vps-db-aware-rollback.sh"
)

foreach ($file in $files) {
  Copy-RelFile $file
}

foreach ($file in @(
  "agent_service\package.json",
  "agent_service\package-lock.json",
  "agent_service\tsconfig.json"
)) {
  Copy-RelFile $file
}
Copy-RelDir "agent_service\src"
Copy-RelDir "agent_service\scripts"
Copy-RelDir "agents"

if ($IncludeDemoData -or $IncludeRealData) {
  throw "Commercial deployment bundles no longer support embedding demo or seller production data."
}

$packagedDbSourcePath = Join-Path $stage "agent_service\src\db.ts"
$packagedDbSource = Get-Content -LiteralPath $packagedDbSourcePath -Raw -Encoding UTF8
if ($packagedDbSource -notmatch "(?m)^export const LATEST_SCHEMA_VERSION = $ExpectedSchemaVersion;\s*$") {
  throw "Refusing to package a release that is not database schema $ExpectedSchemaVersion."
}
$agentPackage = Get-Content -LiteralPath (Join-Path $stage "agent_service\package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$deploymentManifest = [ordered]@{
  manifestSchemaVersion = 1
  databaseSchemaVersion = $ExpectedSchemaVersion
  productVersion = [string]$agentPackage.version
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
}
$deploymentManifestPath = Join-Path $stage "deployment-manifest.json"
$deploymentManifestJson = $deploymentManifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText(
  $deploymentManifestPath,
  $deploymentManifestJson + [Environment]::NewLine,
  (New-Object System.Text.UTF8Encoding($false))
)
Write-Host "[OK] Staged deployment manifest for database schema $ExpectedSchemaVersion."

$envTemplatePath = Join-Path $stage ".env.example"
$envTemplateEntries = @(Get-EnvTemplateEntries -Path $envTemplatePath)
$sensitiveEnvNames = @($envTemplateEntries | Where-Object {
  Test-IsSensitiveEnvName $_.name
} | ForEach-Object { $_.name } | Sort-Object -Unique)
if ($sensitiveEnvNames.Count -eq 0) {
  throw "Refusing to package because no sensitive keys could be derived from .env.example."
}
$nonEmptySensitiveTemplateNames = @($envTemplateEntries | Where-Object {
  $_.name -in $sensitiveEnvNames -and -not [string]::IsNullOrWhiteSpace($_.raw_value)
} | ForEach-Object { $_.name })
if ($nonEmptySensitiveTemplateNames.Count -gt 0) {
  Write-Host "[FAIL] Sensitive .env.example keys must have empty template values: $($nonEmptySensitiveTemplateNames -join ', ')"
  throw "Refusing to package a credential or private identifier in .env.example."
}
Write-Host "[OK] Derived $($sensitiveEnvNames.Count) sensitive keys from .env.example; all template values are empty."

$textFiles = @(Get-ChildItem -LiteralPath $stage -Recurse -File |
  Where-Object { $_.Extension -notin @(".xlsx", ".png", ".jpg", ".jpeg", ".node", ".dll", ".so", ".dylib", ".exe", ".bin") })
$secretHits = $textFiles |
  Select-String -Pattern '-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9._%+-]+@(gmail|googlemail|outlook|hotmail|yahoo|icloud|qq|163|126)\.com' -ErrorAction SilentlyContinue

if ($secretHits) {
  Write-Host "[FAIL] Secret-like token found in staged package:"
  $secretHits | ForEach-Object { Write-Host "  $($_.Path):$($_.LineNumber)" }
  throw "Refusing to package staged files with secret-like material or personal mailboxes."
}

$privateValues = @{}
if (-not $SkipPrivateLocalValueCrossCheck) {
  $envPath = Join-Path $Workspace ".env"
  if (Test-Path -LiteralPath $envPath) {
    foreach ($line in Get-Content -LiteralPath $envPath -Encoding UTF8) {
      if ($line -notmatch '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { continue }
      $name = $matches[1]
      if ($name -notin $sensitiveEnvNames) { continue }
      $value = Get-PrivateEnvValue $matches[2]
      if ($value.Length -ge 6) { $privateValues["env:$name"] = $value }
    }
  }
  $profileFiles = @(Get-ChildItem -LiteralPath $Workspace -Directory -Filter "real_leadgen_*" -ErrorAction SilentlyContinue | ForEach-Object {
    $candidate = Join-Path $_.FullName "company_profile_template.md"
    if (Test-Path -LiteralPath $candidate) { Get-Item -LiteralPath $candidate }
  })
  foreach ($profileFile in $profileFiles) {
    foreach ($line in Get-Content -LiteralPath $profileFile.FullName -Encoding UTF8) {
      if ($line -notmatch '^\s*-\s*(Legal company name|Website|Contact person|Email|WhatsApp):\s*(.+?)\s*$') { continue }
      $value = $matches[2].Trim()
      if ($value.Length -ge 6) { $privateValues["profile:$($matches[1])"] = $value }
    }
  }
  foreach ($name in $privateValues.Keys) {
    $hit = $textFiles | Select-String -SimpleMatch $privateValues[$name] -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) {
      Write-Host "[FAIL] Private local value found in generic deployment bundle: $name at $($hit.Path):$($hit.LineNumber)"
      throw "Refusing to package seller-specific business data or identifiers."
    }
  }
} else {
  Write-Host "[OK] Private local value cross-check skipped by explicit caller request; staged lexical and template secret scans remain active."
}

$zip = Join-Path $OutputDir $PackageName
if (Test-Path -LiteralPath $zip) {
  Remove-Item -LiteralPath $zip -Force
}

function New-PortableZipFromDirectory {
  param(
    [string]$SourceDir,
    [string]$DestinationPath
  )

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem

  $sourceFull = (Resolve-Path -LiteralPath $SourceDir).Path.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )

  $zipStream = [System.IO.File]::Open($DestinationPath, [System.IO.FileMode]::CreateNew)
  try {
    $archive = New-Object System.IO.Compression.ZipArchive(
      $zipStream,
      [System.IO.Compression.ZipArchiveMode]::Create,
      $false,
      [System.Text.Encoding]::UTF8
    )
    try {
      Get-ChildItem -LiteralPath $sourceFull -Recurse -Force -File | ForEach-Object {
        $relative = $_.FullName.Substring($sourceFull.Length).TrimStart(
          [System.IO.Path]::DirectorySeparatorChar,
          [System.IO.Path]::AltDirectorySeparatorChar
        )
        $entryName = $relative -replace '\\', '/'
        $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = [System.DateTimeOffset]$_.LastWriteTime

        $inputStream = $_.OpenRead()
        try {
          $entryStream = $entry.Open()
          try {
            $inputStream.CopyTo($entryStream)
          } finally {
            $entryStream.Dispose()
          }
        } finally {
          $inputStream.Dispose()
        }
      }
    } finally {
      $archive.Dispose()
    }
  } finally {
    $zipStream.Dispose()
  }
}

New-PortableZipFromDirectory -SourceDir $stage -DestinationPath $zip
Write-Host "[OK] Deployment bundle written: $zip"
Write-Host "[OK] Secret scan passed for staged files."
