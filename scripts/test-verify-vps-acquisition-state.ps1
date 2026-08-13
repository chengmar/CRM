param(
  [string]$Workspace = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $Workspace = (Resolve-Path -LiteralPath $Workspace).Path
}

$verifierPath = Join-Path $Workspace "scripts\verify-vps-acquisition-state.ps1"
if (-not (Test-Path -LiteralPath $verifierPath -PathType Leaf)) {
  throw "Missing VPS acquisition-state verifier: $verifierPath"
}

$verifierText = Get-Content -LiteralPath $verifierPath -Raw -Encoding UTF8
foreach ($required in @(
  'AUTHORIZED_CAMPAIGN_COUNT',
  'ACTIVE_AUTHORIZED_CAMPAIGN_COUNT',
  'INVALID_CAMPAIGN_SEND_AUTH_COUNT',
  'INVALID_MESSAGE_SEND_AUTH_COUNT',
  'Step = "ASSERT_RUNTIME_SWITCHES"',
  'Step = "ASSERT_AUTHORIZATION_LEDGER"',
  '[int]$state.DB_SCHEMA -ge 18',
  '$state.EXPANDED_OUTBOUND_COUNT -eq "0"'
)) {
  if ($verifierText -notmatch [regex]::Escape($required)) {
    throw "VPS acquisition-state verifier is missing: $required"
  }
}
foreach ($forbidden in @(
  'Step = "ASSERT_SAFETY_SWITCHES"',
  'Step = "ASSERT_ZERO_OUTBOUND"',
  '$state.DB_SCHEMA -eq "17"'
)) {
  if ($verifierText -match [regex]::Escape($forbidden)) {
    throw "VPS acquisition-state verifier retains an obsolete assertion: $forbidden"
  }
}

$powershell = Get-Command powershell.exe -ErrorAction Stop
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("verify-vps-acquisition-state-" + [guid]::NewGuid().ToString("N"))
$mockBin = Join-Path $tempRoot "bin"
$stateDirectory = Join-Path $tempRoot "states"
$fixtureWorkspace = Join-Path $tempRoot "workspace"
$baseSpecDirectory = Join-Path $fixtureWorkspace "config\production-research-specs-20260721"
$expandedSpecDirectory = Join-Path $fixtureWorkspace "config\production-research-specs-expanded-20260721"
New-Item -ItemType Directory -Path $mockBin, $stateDirectory, $baseSpecDirectory, $expandedSpecDirectory -Force | Out-Null
foreach ($directory in @($baseSpecDirectory, $expandedSpecDirectory)) {
  foreach ($name in @("manifest", "malaysia", "vietnam", "philippines", "indonesia", "mexico")) {
    $fixturePath = Join-Path $directory "$name.json"
    [IO.File]::WriteAllText($fixturePath, "{`"fixture`":`"$name`"}", [Text.UTF8Encoding]::new($false))
  }
}

try {
  $keyPath = Join-Path $tempRoot "fixture-key"
  New-Item -ItemType File -Path $keyPath -Force | Out-Null
  $envPath = Join-Path $tempRoot "fixture.env"
  $envText = @"
VPS_IP=192.0.2.10
VPS_SSH_USER=fixture
VPS_SSH_KEY_PATH="$keyPath"
"@
  [IO.File]::WriteAllText($envPath, $envText, [Text.UTF8Encoding]::new($false))

  $mockSshPath = Join-Path $mockBin "ssh.cmd"
  $mockSsh = @"
@echo off
more >nul
if not defined VERIFY_MOCK_STATE_PATH exit /b 90
type "%VERIFY_MOCK_STATE_PATH%"
exit /b 0
"@
  [IO.File]::WriteAllText($mockSshPath, $mockSsh, [Text.Encoding]::ASCII)

  $baseState = [ordered]@{
    SERVICE_ACTIVE = "active"
    SERVICE_ENABLED = "enabled"
    BACKUP_TIMER_ACTIVE = "active"
    BACKUP_TIMER_ENABLED = "enabled"
    DAILY_TIMER_ACTIVE = "inactive"
    DAILY_TIMER_ENABLED = "disabled"
    PROCESS_CONFIG_CURRENT = "true"
    PROCESS_CODE_CURRENT = "true"
    RUNTIME_PAGE_BUDGET = "1600"
    BROAD_ICP_FIT_RANK_ONLY = "true"
    BROAD_ICP_PRODUCT_MIN_1 = "true"
    BROAD_ICP_PUBLIC_EVIDENCE_GATE = "true"
    BROAD_ICP_NO_INTENT_REQUIRED = "true"
    DB_SCHEMA = "18"
    DB_QUICK_CHECK = "ok"
    DB_FOREIGN_KEY_VIOLATIONS = "0"
    OUTBOUND_PAUSED = "false"
    DAILY_RESEARCH_ENABLED = "false"
    CAMPAIGN_COUNT = "22"
    CAMPAIGN_TARGET_TOTAL = "1000"
    LEAD_COUNT = "497"
    CONTACT_COUNT = "192"
    OUTBOUND_MESSAGE_COUNT = "0"
    CAMPAIGN_SEND_AUTH_COUNT = "5"
    MESSAGE_SEND_AUTH_COUNT = "0"
    AUTHORIZED_CAMPAIGN_COUNT = "5"
    ACTIVE_AUTHORIZED_CAMPAIGN_COUNT = "5"
    INVALID_CAMPAIGN_SEND_AUTH_COUNT = "0"
    INVALID_MESSAGE_SEND_AUTH_COUNT = "0"
    EXPANDED_JOB_COUNT = "5"
    EXPANDED_JOB_QUEUED = "0"
    EXPANDED_JOB_RUNNING = "0"
    EXPANDED_JOB_COMPLETED = "5"
    EXPANDED_JOB_FAILED = "0"
    EXPANDED_LEAD_COUNT = "488"
    EXPANDED_CONTACT_COUNT = "186"
    EXPANDED_CONTACT_WITH_EMAIL_COUNT = "186"
    EXPANDED_TIER_A_COUNT = "0"
    EXPANDED_TIER_B_COUNT = "0"
    EXPANDED_TIER_C_COUNT = "186"
    EXPANDED_OUTBOUND_COUNT = "0"
    PRIVATE_ROOT_PRESENT = "true"
    PRIVATE_ROOT_MODE = "700"
    OLD_PREVIOUS_RELEASE_PRESENT = "false"
    OLD_ROLLBACK_STATE_PRESENT = "false"
    OLD_HOME_PACKAGE_COUNT = "0"
    PRIVATE_ACTIVE_MANIFEST_COUNT = "2"
    PRIVATE_BACKUP_MANIFEST_COUNT = "0"
    PRIVATE_EXPANDED_LABEL_COUNT = "1"
    PRIVATE_EXPANDED_POLICY_COUNT = "1"
    PRIVATE_EXPANDED_FIVE_SPEC_COUNT = "1"
    PRIVATE_EXPANDED_TARGET_COUNT = "1"
    PRIVATE_EXPANDED_ACTION_COUNT = "1"
    PRIVATE_EXPANDED_TRANSPORT_COUNT = "1"
    PRIVATE_BASE_FINGERPRINT_MATCH_COUNT = "1"
    PRIVATE_EXPANDED_FINGERPRINT_MATCH_COUNT = "1"
    PRIVATE_OLD_SPEC_DIR_COUNT = "0"
    PRIVATE_SCAN_OK = "true"
    PRIVATE_BASE_PRESENT = "true"
    PRIVATE_BASE_DIR_MODE = "700"
    PRIVATE_BASE_FILE_COUNT = "6"
    PRIVATE_BASE_BAD_FILE_MODE_COUNT = "0"
    PRIVATE_EXPANDED_PRESENT = "true"
    PRIVATE_EXPANDED_DIR_MODE = "700"
    PRIVATE_EXPANDED_FILE_COUNT = "6"
    PRIVATE_EXPANDED_BAD_FILE_MODE_COUNT = "0"
  }

  function Copy-State {
    $copy = [ordered]@{}
    foreach ($entry in $baseState.GetEnumerator()) {
      $copy[$entry.Key] = $entry.Value
    }
    return $copy
  }

  function Invoke-VerificationCase {
    param(
      [string]$Name,
      [System.Collections.IDictionary]$State,
      [bool]$ShouldPass,
      [string]$ExpectedFailedStep = ""
    )

    $safeName = $Name -replace '[^A-Za-z0-9_-]', '_'
    $statePath = Join-Path $stateDirectory "$safeName.state"
    $stateLines = @($State.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })
    [IO.File]::WriteAllLines($statePath, [string[]]$stateLines, [Text.UTF8Encoding]::new($false))

    $previousPath = $env:PATH
    $previousStatePath = $env:VERIFY_MOCK_STATE_PATH
    try {
      $env:PATH = "$mockBin$([IO.Path]::PathSeparator)$previousPath"
      $env:VERIFY_MOCK_STATE_PATH = $statePath
      $output = @(& $powershell.Source -NoProfile -NonInteractive -ExecutionPolicy Bypass `
        -File $verifierPath -Workspace $fixtureWorkspace -EnvPath $envPath 2>&1)
      $exitCode = $LASTEXITCODE
    } finally {
      $env:PATH = $previousPath
      $env:VERIFY_MOCK_STATE_PATH = $previousStatePath
    }

    $detail = ($output | ForEach-Object { [string]$_ }) -join "`n"
    if ($ShouldPass) {
      if ($exitCode -ne 0 -or $detail -notmatch '(?m)^VERIFY_STATUS=PASS$') {
        throw "$Name should pass but exited $exitCode.`n$detail"
      }
    } else {
      if ($exitCode -eq 0) {
        throw "$Name should fail but exited 0.`n$detail"
      }
      if ($detail -notmatch "(?m)^FAILED_STEP=$([regex]::Escape($ExpectedFailedStep))$") {
        throw "$Name failed at the wrong assertion; expected $ExpectedFailedStep.`n$detail"
      }
    }
    Write-Host "[OK] $Name"
  }

  Invoke-VerificationCase -Name "schema-18-five-active-authorizations" `
    -State (Copy-State) -ShouldPass $true

  $forwardCompatible = Copy-State
  $forwardCompatible.DB_SCHEMA = "19"
  $forwardCompatible.OUTBOUND_PAUSED = "true"
  $forwardCompatible.CAMPAIGN_SEND_AUTH_COUNT = "7"
  $forwardCompatible.AUTHORIZED_CAMPAIGN_COUNT = "6"
  $forwardCompatible.ACTIVE_AUTHORIZED_CAMPAIGN_COUNT = "6"
  $forwardCompatible.OUTBOUND_MESSAGE_COUNT = "2"
  $forwardCompatible.MESSAGE_SEND_AUTH_COUNT = "2"
  Invoke-VerificationCase -Name "schema-19-authorized-messages" `
    -State $forwardCompatible -ShouldPass $true

  $obsoleteSchema = Copy-State
  $obsoleteSchema.DB_SCHEMA = "17"
  Invoke-VerificationCase -Name "schema-17-rejected" -State $obsoleteSchema `
    -ShouldPass $false -ExpectedFailedStep "ASSERT_DATABASE"

  $insufficientCampaigns = Copy-State
  $insufficientCampaigns.ACTIVE_AUTHORIZED_CAMPAIGN_COUNT = "4"
  Invoke-VerificationCase -Name "four-active-authorizations-rejected" -State $insufficientCampaigns `
    -ShouldPass $false -ExpectedFailedStep "ASSERT_AUTHORIZATION_LEDGER"

  $unboundMessageAuthorization = Copy-State
  $unboundMessageAuthorization.OUTBOUND_MESSAGE_COUNT = "1"
  $unboundMessageAuthorization.MESSAGE_SEND_AUTH_COUNT = "2"
  Invoke-VerificationCase -Name "message-authorization-count-exceeds-outbound" -State $unboundMessageAuthorization `
    -ShouldPass $false -ExpectedFailedStep "ASSERT_AUTHORIZATION_LEDGER"

  $invalidCampaignLedger = Copy-State
  $invalidCampaignLedger.INVALID_CAMPAIGN_SEND_AUTH_COUNT = "1"
  Invoke-VerificationCase -Name "invalid-campaign-authorization-rejected" -State $invalidCampaignLedger `
    -ShouldPass $false -ExpectedFailedStep "ASSERT_AUTHORIZATION_LEDGER"

  $invalidMessageLedger = Copy-State
  $invalidMessageLedger.OUTBOUND_MESSAGE_COUNT = "1"
  $invalidMessageLedger.MESSAGE_SEND_AUTH_COUNT = "1"
  $invalidMessageLedger.INVALID_MESSAGE_SEND_AUTH_COUNT = "1"
  Invoke-VerificationCase -Name "invalid-message-authorization-rejected" -State $invalidMessageLedger `
    -ShouldPass $false -ExpectedFailedStep "ASSERT_AUTHORIZATION_LEDGER"
} finally {
  $resolvedTempRoot = [IO.Path]::GetFullPath($tempRoot)
  $resolvedSystemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolvedTempRoot.StartsWith($resolvedSystemTemp, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "[OK] VPS acquisition-state verifier behavior validated."
