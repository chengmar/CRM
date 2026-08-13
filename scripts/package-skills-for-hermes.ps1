param(
  [string]$CodexSkills = "$env:USERPROFILE\.codex\skills",
  [string]$OutputDir = "$PWD\dist",
  [string]$PackageName = "export-ai-skills-20260709.zip"
)

$ErrorActionPreference = "Stop"

$skillNames = @(
  "personalized-email",
  "feishu-sheets",
  "export-customer-research",
  "customer-discovery-pro",
  "b2b-search-keywords",
  "monthly-report",
  "competitor-intel-pro",
  "openclaw-collaboration",
  "colleague-profiler",
  "multi-bot-team-setup",
  "wife-tone",
  "oneesan-tone",
  "master-tone",
  "butler",
  "maid"
)

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$resolvedOutputDir = (Resolve-Path -LiteralPath $OutputDir).Path

$stage = Join-Path $OutputDir "skills-stage"
if (Test-Path $stage) {
  $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
  if (-not $resolvedStage.StartsWith($resolvedOutputDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove stage outside output dir: $resolvedStage"
  }
  Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null

foreach ($name in $skillNames) {
  $src = Join-Path $CodexSkills $name
  $dst = Join-Path $stage $name
  if (-not (Test-Path $src)) {
    Write-Warning "Missing Codex skill: $src"
    continue
  }
  Copy-Item -LiteralPath $src -Destination $dst -Recurse
  Write-Host "[OK] staged $name"
}

$zip = Join-Path $OutputDir $PackageName
if (Test-Path $zip) {
  Remove-Item -LiteralPath $zip -Force
}

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
Write-Host "[OK] package written: $zip"
