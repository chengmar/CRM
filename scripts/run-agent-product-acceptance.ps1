param(
  [string]$Workspace = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $Workspace = (Resolve-Path -LiteralPath $Workspace).Path
}

$serviceDir = Join-Path $Workspace "agent_service"
if (-not (Test-Path -LiteralPath (Join-Path $serviceDir "package.json"))) {
  throw "Agent service is missing: $serviceDir"
}

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$reportDir = Join-Path $Workspace "outputs\agent_product_acceptance"
$tempDir = Join-Path $reportDir "acceptance-$stamp"
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
$reportPath = Join-Path $reportDir "agent-product-acceptance-$stamp.json"
$results = New-Object System.Collections.Generic.List[object]
$testDir = Join-Path $serviceDir "test"
$sourceTests = if (Test-Path -LiteralPath $testDir) {
  @(Get-ChildItem -LiteralPath $testDir -File -Filter "*.test.ts")
} else {
  @()
}
$validationProfile = if ($sourceTests.Count -gt 0) { "source" } else { "runtime-package" }

function Add-Result {
  param([string]$Name, [string]$Status, [string]$Detail)
  $results.Add([pscustomobject]@{ name = $Name; status = $Status; detail = $Detail }) | Out-Null
  Write-Host "[$Status] $Name $Detail"
}

function Invoke-Step {
  param([string]$Name, [scriptblock]$Command)
  try {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $output = & $Command 2>&1
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
      throw (($output | Select-Object -Last 30) -join "`n")
    }
    Add-Result $Name "PASS" (($output | Select-Object -Last 8) -join " | ")
  } catch {
    Add-Result $Name "FAIL" $_.Exception.Message
  }
}

Push-Location $serviceDir
try {
  Invoke-Step "Node dependencies" { npm install --ignore-scripts }
  Invoke-Step "TypeScript typecheck" { npm run typecheck }
  if ($sourceTests.Count -gt 0) {
    Invoke-Step "Unit tests" { npm test }
  } else {
    Add-Result "Unit tests" "NOT_APPLICABLE" "Runtime deployment packages intentionally exclude development test fixtures; CLI, database and HTTP behavior are still accepted below. Source unit tests remain a separate mandatory release gate."
  }
  Invoke-Step "Production build" { npm run build }

  $safeEnvironment = [ordered]@{
    AGENT_DB_PATH = (Join-Path $tempDir "acceptance.db")
    AGENT_MODE = "dry_run"
    OUTBOUND_ENABLED = "false"
    EMAIL_OUTREACH_ENABLED = "false"
    EMAIL_INBOUND_ENABLED = "false"
    DAILY_RESEARCH_ENABLED = "false"
    DAILY_OPERATIONS_REPORT_ENABLED = "false"
    FEISHU_BOT_ENABLED = "false"
    FEISHU_BITABLE_CONTROL_SYNC_ENABLED = "false"
    WHATSAPP_BUSINESS_API_ENABLED = "false"
    INQUIRY_FORM_WEBHOOK_ENABLED = "false"
    HERMES_RESEARCH_ENABLED = "false"
    CONSUMER_EMAIL_PILOT_ENABLED = "false"
    ACQ_SEARXNG_V2_ENABLED = "false"
    ACQ_LOCAL_PUBLIC_WEB_ENABLED = "false"
    ACQ_HUNTER_V2_ENABLED = "false"
    ACQ_BOUNCER_V2_ENABLED = "false"
    OPENAI_API_KEY = ""
    SERPER_API_KEY = ""
    EXA_API_KEY = ""
    SEARXNG_BASE_URL = ""
    HUNTER_API_KEY = ""
    BOUNCER_API_KEY = ""
    FEISHU_APP_ID = ""
    FEISHU_APP_SECRET = ""
    FEISHU_BITABLE_APP_TOKEN = ""
    FEISHU_BITABLE_LEADS_TABLE_ID = ""
    FEISHU_BITABLE_EVENTS_TABLE_ID = ""
    FEISHU_BITABLE_CAMPAIGN_BRIEFS_TABLE_ID = ""
    FEISHU_BITABLE_MARKET_ALLOCATIONS_TABLE_ID = ""
    FEISHU_BITABLE_SALES_TASKS_TABLE_ID = ""
    FEISHU_BITABLE_COMMERCIAL_REPORT_TABLE_ID = ""
    SMTP_HOST = ""
    SMTP_USER = ""
    SMTP_PASSWORD = ""
    IMAP_HOST = ""
    IMAP_USER = ""
    IMAP_PASSWORD = ""
    EMAIL_FROM_ADDRESS = ""
    AGENT_HTTP_PORT = "18791"
    NODE_NO_WARNINGS = "1"
  }
  $previousEnvironment = @{}
  foreach ($entry in $safeEnvironment.GetEnumerator()) {
    $previousEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, "Process")
    [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, "Process")
  }
  $previousBusinessData = [Environment]::GetEnvironmentVariable("BUSINESS_DATA_DIR", "Process")
  try {
    Invoke-Step "Database schema and integrity" { npm run cli -- verify-db }
    $legacyDir = Join-Path $tempDir "legacy-fixture"
    New-Item -ItemType Directory -Force -Path $legacyDir | Out-Null
    @"
company,website,country,buyer_type,product,score,grade,source_url,match_reason
LEGACY_IMPORT_SIMULATION,https://example.invalid,Test,integrator,Sample Product,75,SILVER,https://example.invalid,synthetic acceptance fixture
"@ | Set-Content -LiteralPath (Join-Path $legacyDir "crm_import.csv") -Encoding UTF8
    $env:BUSINESS_DATA_DIR = $legacyDir
    Invoke-Step "Legacy lead import" { npm run cli -- import-legacy }
    $env:BUSINESS_DATA_DIR = $previousBusinessData
    Invoke-Step "Inquiry handoff simulation" { npm run cli -- simulate-inquiry }
    Invoke-Step "Dry-run dispatch plan" { npm run cli -- dispatch-plan }
    $snapshotPath = Join-Path $tempDir "acceptance-snapshot.db"
    Invoke-Step "Consistent SQLite snapshot" { npm run cli -- backup-db $snapshotPath }

    $stdout = Join-Path $tempDir "service.out.log"
    $stderr = Join-Path $tempDir "service.err.log"
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $startArguments = @{
      FilePath = $nodePath
      ArgumentList = "dist/app.js"
      WorkingDirectory = $serviceDir
      RedirectStandardOutput = $stdout
      RedirectStandardError = $stderr
      PassThru = $true
    }
    if ($IsWindows -or $env:OS -eq "Windows_NT") { $startArguments.WindowStyle = "Hidden" }
    $process = Start-Process @startArguments
    try {
      $healthy = $false
      for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 250
        try {
          $health = Invoke-RestMethod -Uri "http://127.0.0.1:18791/health" -TimeoutSec 2
          if (
            $health.ok -and
            $health.mode -eq "dry_run" -and
            -not $health.outboundEnabled -and
            $health.outboundPaused -and
            -not $health.dailyResearchEnabled -and
            -not $health.emailInboundEnabled -and
            $health.database.ok -and
            $health.schemaVersion -eq 18 -and
            $health.schemaVersion -eq $health.latestSchemaVersion -and
            $health.notificationOutbox.pendingCount -ge 1 -and
            $health.notificationOutbox.deadLetterCount -eq 0
          ) {
            $healthy = $true
            break
          }
        } catch {
          # Retry until startup timeout.
        }
      }
      if (-not $healthy) { throw "Agent health endpoint did not become ready" }
      $readiness = Invoke-RestMethod -Uri "http://127.0.0.1:18791/readiness" -TimeoutSec 3
      if ($readiness.productionSendReady -or $readiness.dailyOperationsReportEnabled) {
        throw "Isolated acceptance unexpectedly enabled production sending or daily external reporting"
      }
      Add-Result "HTTP health and readiness" "PASS" ($readiness | ConvertTo-Json -Depth 8 -Compress)
    } catch {
      Add-Result "HTTP health and readiness" "FAIL" $_.Exception.Message
    } finally {
      if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    }
  } finally {
    foreach ($entry in $safeEnvironment.GetEnumerator()) {
      [Environment]::SetEnvironmentVariable($entry.Key, $previousEnvironment[$entry.Key], "Process")
    }
    [Environment]::SetEnvironmentVariable("BUSINESS_DATA_DIR", $previousBusinessData, "Process")
  }
} finally {
  Pop-Location
}

$failed = @($results | Where-Object { $_.status -eq "FAIL" }).Count
$report = [pscustomobject]@{
  generated_at = Get-Date -Format s
  workspace = $Workspace
  validation_profile = $validationProfile
  source_unit_tests_executed = ($sourceTests.Count -gt 0)
  source_unit_test_files = $sourceTests.Count
  failed = $failed
  passed = @($results | Where-Object { $_.status -eq "PASS" }).Count
  not_applicable = @($results | Where-Object { $_.status -eq "NOT_APPLICABLE" }).Count
  results = $results
}
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Host "[OK] Report: $reportPath"
if ($failed -gt 0) { exit 1 }
exit 0
