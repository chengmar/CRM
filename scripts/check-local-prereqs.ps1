$ErrorActionPreference = "Continue"

Write-Host "== Local prerequisite check =="

$commands = @("git", "curl", "node", "python", "docker", "wsl", "hermes", "openclaw")
foreach ($cmd in $commands) {
  $found = Get-Command $cmd -ErrorAction SilentlyContinue
  if ($found) {
    Write-Host "[OK] $cmd -> $($found.Source)"
  } else {
    Write-Host "[MISS] $cmd"
  }
}

Write-Host ""
Write-Host "== Docker daemon =="
docker info --format '{{.ServerVersion}}' 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "[WARN] Docker CLI exists but Docker daemon is not running or not reachable."
}

Write-Host ""
Write-Host "== WSL =="
wsl --status 2>$null

Write-Host ""
Write-Host "== OpenClaw =="
openclaw status 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "[WARN] OpenClaw status failed; run 'openclaw doctor' when you want to repair it."
}
