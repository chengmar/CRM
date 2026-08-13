param(
  [string]$Workspace = (Split-Path -Parent $PSScriptRoot),
  [string]$Name = "",
  [switch]$NoWriteEnv
)

$ErrorActionPreference = "Stop"
$serviceDir = Join-Path $Workspace "agent_service"
if (-not (Test-Path -LiteralPath (Join-Path $serviceDir "package.json"))) {
  throw "Agent service not found: $serviceDir"
}

Push-Location $serviceDir
try {
  $arguments = @("run", "cli", "--", "bootstrap-bitable")
  if (-not [string]::IsNullOrWhiteSpace($Name)) { $arguments += $Name }
  if ($NoWriteEnv) { $arguments += "--no-write-env" }
  & npm @arguments
  if ($LASTEXITCODE -ne 0) { throw "Feishu Bitable bootstrap failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}
