param(
  [string]$CodexSkills = "$env:USERPROFILE\.codex\skills",
  [string]$HermesSkills = "$env:USERPROFILE\.hermes\skills"
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

New-Item -ItemType Directory -Force -Path $HermesSkills | Out-Null
$resolvedHermesSkills = (Resolve-Path -LiteralPath $HermesSkills).Path

foreach ($name in $skillNames) {
  $src = Join-Path $CodexSkills $name
  $dst = Join-Path $HermesSkills $name
  if (-not (Test-Path $src)) {
    Write-Warning "Missing Codex skill: $src"
    continue
  }
  if (Test-Path $dst) {
    $resolvedDst = (Resolve-Path -LiteralPath $dst).Path
    if (-not $resolvedDst.StartsWith($resolvedHermesSkills, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove skill outside Hermes skill dir: $resolvedDst"
    }
    Remove-Item -Recurse -Force $dst
  }
  Copy-Item -Recurse $src $dst
  Write-Host "[OK] Synced $name -> $dst"
}

Write-Host "Done. Restart Hermes or reload skills after syncing."
