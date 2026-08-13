param(
  [switch]$StartDockerDesktop,
  [switch]$StartHermesGateway
)

$ErrorActionPreference = "Continue"

function Write-Check {
  param(
    [string]$Name,
    [string]$Status,
    [string]$Detail = ""
  )
  $tag = if ($Status -eq "OK") { "[OK]" } elseif ($Status -eq "WARN") { "[WARN]" } else { "[FAIL]" }
  Write-Host "$tag $Name $Detail"
}

Write-Host "== Local agent services =="

try {
  $task = Get-ScheduledTask | Where-Object { $_.TaskName -eq "OpenClaw Gateway" } | Select-Object -First 1
  if ($task -and $task.State -ne "Running") {
    Start-ScheduledTask -TaskName "OpenClaw Gateway"
    Start-Sleep -Seconds 5
  }
  $status = openclaw gateway status 2>&1
  $text = ($status -join "`n")
  if ($text -match "Connectivity probe:\s+ok") {
    Write-Check "OpenClaw gateway" "OK" "connectivity probe ok"
  } elseif ($text -match "Port 18789 is already in use" -and $text -match "Listening:\s+127\.0\.0\.1:18789") {
    Write-Check "OpenClaw gateway" "OK" "already running on 127.0.0.1:18789"
  } else {
    Write-Check "OpenClaw gateway" "WARN" (($status | Select-Object -Last 5) -join " ")
  }
} catch {
  Write-Check "OpenClaw gateway" "FAIL" $_.Exception.Message
}

if ($StartDockerDesktop) {
  try {
    $dockerInfo = docker info --format "{{.ServerVersion}}" 2>$null
    if ($LASTEXITCODE -eq 0) {
      Write-Check "Docker daemon" "OK" $dockerInfo
    } else {
      $desktop = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
      if (Test-Path -LiteralPath $desktop) {
        Start-Process -FilePath $desktop -WindowStyle Hidden
        Start-Sleep -Seconds 20
        $dockerInfo = docker info --format "{{.ServerVersion}}" 2>$null
        if ($LASTEXITCODE -eq 0) {
          Write-Check "Docker daemon" "OK" $dockerInfo
        } else {
          Write-Check "Docker daemon" "WARN" "Docker Desktop launched but daemon is not reachable yet."
        }
      } else {
        Write-Check "Docker daemon" "WARN" "Docker Desktop executable not found."
      }
    }
  } catch {
    Write-Check "Docker daemon" "WARN" $_.Exception.Message
  }
} else {
  Write-Check "Docker daemon" "WARN" "skipped; use -StartDockerDesktop if Docker is needed."
}

try {
  $hermesExe = "C:\Users\your-user\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe"
  if (Test-Path -LiteralPath $hermesExe) {
    $status = & $hermesExe gateway status 2>&1
    $text = ($status -join "`n")
    if ($text -match "Gateway is not running") {
      if ($StartHermesGateway) {
        & $hermesExe gateway install --force --start-now --start-on-login | Out-Host
        Start-Sleep -Seconds 5
        $status = & $hermesExe gateway status 2>&1
        $text = ($status -join "`n")
        if ($text -match "Gateway process running|Status:\s+.*running|Gateway Service.*running") {
          Write-Check "Hermes gateway" "OK" "installed and running; messaging channels remain disabled until configured"
        } else {
          Write-Check "Hermes gateway" "WARN" (($status | Select-Object -Last 5) -join " ")
        }
      } else {
        Write-Check "Hermes gateway" "WARN" "not running; use -StartHermesGateway to install/start login item."
      }
    } else {
      Write-Check "Hermes gateway" "OK" (($status | Select-Object -First 2) -join " ")
    }
  } else {
    Write-Check "Hermes gateway" "FAIL" "Hermes executable not found."
  }
} catch {
  Write-Check "Hermes gateway" "WARN" $_.Exception.Message
}

Write-Host ""
Write-Host "[OK] Service check complete."
