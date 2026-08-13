param(
  [string]$Workspace = "",
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $Workspace = (Resolve-Path -LiteralPath $Workspace).Path
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) { $OutputDir = Join-Path $Workspace "dist" }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path
$stage = Join-Path $OutputDir "commercial-source-stage"
if (Test-Path -LiteralPath $stage) {
  $resolved = (Resolve-Path -LiteralPath $stage).Path
  if (-not $resolved.StartsWith($OutputDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove source stage outside output directory."
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null

function Copy-RelFile {
  param([string]$Rel)
  $source = Join-Path $Workspace $Rel
  if (-not (Test-Path -LiteralPath $source)) { throw "Missing commercial source file: $Rel" }
  $target = Join-Path $stage $Rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
}

function Copy-RelDir {
  param([string]$Rel)
  $source = Join-Path $Workspace $Rel
  if (-not (Test-Path -LiteralPath $source)) { throw "Missing commercial source directory: $Rel" }
  $target = Join-Path $stage $Rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
}

$files = @(
  ".env.example",
  ".gitattributes",
  ".gitignore",
  "README.md",
  "SECURITY.md",
  "AGENT_PRODUCT_ARCHITECTURE.md",
  "AGENT_USER_GUIDE.md",
  "COMMERCIAL_INSTALLER_RELEASE_CHECKLIST.md",
  "FEISHU_BITABLE_SCHEMA.md",
  "INSTALLER_ARCHITECTURE.md",
  "WINDOWS_INSTALLER_USER_GUIDE.md",
  ".github\workflows\build-windows-installer.yml",
  ".github\ISSUE_TEMPLATE\bug_report.yml",
  ".github\ISSUE_TEMPLATE\feature_request.yml",
  ".github\ISSUE_TEMPLATE\config.yml",
  "config\feishu-agent-scopes.json",
  "infra\support-services.compose.yml",
  "agent_service\package.json",
  "agent_service\package-lock.json",
  "agent_service\tsconfig.json",
  "installer\package.json",
  "installer\package-lock.json",
  "installer\electron.vite.config.ts",
  "installer\tsconfig.node.json",
  "installer\tsconfig.web.json",
  "scripts\activate-vps-release.sh",
  "scripts\audit-commercial-installer-release.ps1",
  "scripts\backup-production-state.ps1",
  "scripts\bootstrap-vps-production.sh",
  "scripts\check-outbound-readiness.ps1",
  "scripts\check-production-readiness.ps1",
  "scripts\audit-commercial-completion.ps1",
  "scripts\export-production-status.ps1",
  "scripts\validate-commercial-launch-inputs.ps1",
  "scripts\export-commercial-source.ps1",
  "scripts\install-agent-service-systemd.sh",
  "scripts\install-agent-support-services.sh",
  "scripts\package-deployment-bundle.ps1",
  "scripts\rollback-vps-release.sh",
  "scripts\run-fresh-install-acceptance.ps1",
  "scripts\run-vps-activation-acceptance.ps1",
  "scripts\run-windows-compatibility-acceptance.ps1",
  "scripts\run-windows-defender-scan.ps1",
  "scripts\run-windows-package-acceptance.ps1",
  "scripts\test-agent-service-persistence.ps1",
  "scripts\test-commercial-source.ps1",
  "scripts\test-deployment-package.ps1",
  "scripts\email-staged-launch-policy.ps1",
  "scripts\test-email-staged-launch-policy.ps1",
  "scripts\test-email-auth.ps1",
  "scripts\test-vps-deployment-scripts.ps1"
)
foreach ($file in $files) { Copy-RelFile $file }
foreach ($dir in @(
  "agent_service\src",
  "agent_service\test",
  "installer\src",
  "installer\test",
  "installer\scripts"
)) { Copy-RelDir $dir }

$forbiddenPaths = @(
  ".env", ".git", "node_modules", "outputs", "backups", "case_inputs",
  "memory", "installer\payload", "installer\release", "installer\out",
  "agent_service\data", "agent_service\logs", "workbook_build"
)
$foundForbidden = @($forbiddenPaths | Where-Object {
  Test-Path -LiteralPath (Join-Path $stage $_)
})
$foundForbidden += @(Get-ChildItem -LiteralPath $stage -Force -Directory | Where-Object {
  $_.Name -like "real_leadgen_*" -or $_.Name -like "local_mvp_*"
} | ForEach-Object { $_.Name })
if ($foundForbidden.Count -gt 0) { throw "Forbidden source paths exported: $($foundForbidden -join ', ')" }

$textFiles = @(Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object {
  $_.Extension -notin @(".png", ".jpg", ".jpeg", ".ico", ".node", ".dll", ".so", ".dylib", ".exe", ".bin")
})
$patternHits = $textFiles | Select-String -Pattern '-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9._%+-]+@(gmail|googlemail|outlook|hotmail|yahoo|icloud|qq|163|126)\.com' -ErrorAction SilentlyContinue
if ($patternHits) { throw "Secret-like material or personal mailbox found in commercial source export." }

$envPath = Join-Path $Workspace ".env"
if (Test-Path -LiteralPath $envPath) {
  $sensitiveNames = @(
    "OPENAI_API_KEY", "OPENROUTER_API_KEY", "NOUS_API_KEY", "FEISHU_APP_ID", "FEISHU_APP_SECRET",
    "FEISHU_BITABLE_APP_TOKEN", "FEISHU_ALERT_CHAT_ID", "FEISHU_PAIRING_CODE", "CRM_WIKI_URL", "CRM_SPREADSHEET_TOKEN", "CRM_SHEET_ID",
    "SMTP_PASSWORD", "IMAP_PASSWORD", "EMAIL_FROM_ADDRESS", "EMAIL_FROM_NAME", "EMAIL_REPLY_TO", "SMTP_USER", "IMAP_USER",
    "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_WEBHOOK_VERIFY_TOKEN", "VPS_IP", "VPS_SSH_PASSWORD",
    "VPS_SSH_HOSTKEY", "VPS_SSH_KEY_PATH", "COMPANY_POSTAL_ADDRESS", "OPENAI_BASE_URL", "REACHER_BASE_URL",
    "SERPER_API_KEY", "EXA_API_KEY", "FIRECRAWL_API_KEY", "APIFY_API_TOKEN", "CUSTOMS_API_KEY"
  )
  $envValues = @{}
  foreach ($line in Get-Content -LiteralPath $envPath -Encoding UTF8) {
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { continue }
    $name = $matches[1]
    if ($name -notin $sensitiveNames) { continue }
    $value = $matches[2].Trim().Trim('"').Trim("'")
    if ($value.Length -ge 6) { $envValues[$name] = $value }
  }
  foreach ($name in $envValues.Keys) {
    $hit = $textFiles | Select-String -SimpleMatch $envValues[$name] -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { throw "A local sensitive value for $name appears in exported source: $($hit.Path)" }
  }
}

$privateProfileValues = @{}
$profileFiles = @(Get-ChildItem -LiteralPath $Workspace -Directory -Filter "real_leadgen_*" -ErrorAction SilentlyContinue | ForEach-Object {
  $candidate = Join-Path $_.FullName "company_profile_template.md"
  if (Test-Path -LiteralPath $candidate) { Get-Item -LiteralPath $candidate }
})
foreach ($profileFile in $profileFiles) {
  foreach ($line in Get-Content -LiteralPath $profileFile.FullName -Encoding UTF8) {
    if ($line -notmatch '^\s*-\s*(Legal company name|Website|Contact person|Email|WhatsApp):\s*(.+?)\s*$') { continue }
    $value = $matches[2].Trim()
    if ($value.Length -ge 6) { $privateProfileValues["$($profileFile.Directory.Name):$($matches[1])"] = $value }
  }
}
foreach ($name in $privateProfileValues.Keys) {
  $hit = $textFiles | Select-String -SimpleMatch $privateProfileValues[$name] -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { throw "A private company-profile value for $name appears in exported source: $($hit.Path)" }
}

$manifestEntries = @(Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName | ForEach-Object {
  [pscustomobject]@{
    path = $_.FullName.Substring($stage.Length + 1).Replace("\", "/")
    bytes = $_.Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
  }
})
$manifest = [pscustomobject]@{
  schema_version = 1
  generated_at = (Get-Date -Format s)
  files = $manifestEntries
}
$manifestJson = $manifest | ConvertTo-Json -Depth 6
$manifestJson = (($manifestJson -split '\r?\n') | ForEach-Object { $_.TrimEnd() }) -join "`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $stage "source-manifest.json"), $manifestJson + "`n", $utf8NoBom)

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$zipPath = Join-Path $OutputDir "crm-agent-commercial-source-$stamp.zip"
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -CompressionLevel Optimal -Force
$zipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
Write-Host "[OK] Commercial source: $zipPath"
Write-Host "[OK] SHA-256: $zipHash"
Write-Host "[OK] Files: $($manifestEntries.Count + 1)"
