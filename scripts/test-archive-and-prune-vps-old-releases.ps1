param([string]$Workspace = "")

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
$scriptPath = Join-Path $Workspace "scripts\archive-and-prune-vps-old-releases.ps1"
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
  throw "Archive-and-prune script is missing."
}

$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "Archive-and-prune script parse failed." }
$source = Get-Content -LiteralPath $scriptPath -Raw -Encoding UTF8

$parameterNames = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
foreach ($requiredParameter in @(
  "InventoryOnly",
  "ConfirmArchiveAndPrune",
  "ResumeExistingArchive",
  "ResumeNonce",
  "ResumeCandidateHash",
  "ResumeArchiveHash",
  "ConfirmResumeExistingArchive"
)) {
  if ($requiredParameter -notin $parameterNames) {
    throw "Archive-and-prune script is missing a required mode parameter."
  }
}
foreach ($forbiddenParameter in @("SshPassword", "Password", "RemoteAppDir")) {
  if ($forbiddenParameter -in $parameterNames) {
    throw "Archive-and-prune script must not expose password auth or an arbitrary remote root."
  }
}

foreach ($required in @(
  'CONFIRMATION_REQUIRED',
  'RESUME_CONFIRMATION_REQUIRED',
  'RESUME_PARAMETERS_WITHOUT_MODE',
  'RESUME_INPUT_INVALID',
  'LOCAL_SSH_KEY_REQUIRED',
  'StrictHostKeyChecking=yes',
  'BatchMode=yes',
  'IdentitiesOnly=yes',
  'ServerAliveInterval=10',
  'ServerAliveCountMax=2',
  'curl -fsS --max-time 15',
  'Invoke-BoundedNativeProcess',
  '$process.WaitForExit($TimeoutSeconds * 1000)',
  'Get-NativeProcessTreeIds',
  'Stop-NativeProcessTree',
  'Get-CimInstance -ClassName Win32_Process -OperationTimeoutSec 5',
  'System32\taskkill.exe',
  '"/PID $rootProcessId /T /F"',
  '$startInfo.RedirectStandardOutput = $true',
  '$killer.StandardOutput.ReadToEndAsync()',
  'process tree remained after termination',
  'Invoke-ResumableArchiveDownload',
  'Invoke-ProgressAwareNativeProcess',
  '"reget `"$RemoteArchive`" `"$sftpLocalPath`"`n"',
  '"-B", "65536", "-R", "64"',
  '-NoProgressTimeoutSeconds 720',
  '-MaximumRuntimeSeconds 43200',
  'return "EXISTING_PARTIAL"',
  'return "SFTP_REGET"',
  'return "SSH_STDOUT"',
  'if ($modeState.Mode -ne "RESUME" -and (Test-Path -LiteralPath $partialArchive))',
  'Get-Command sftp',
  'exec 8<"$deploy_lock"',
  'flock -s -w 15 8',
  'exec 8<>"$deploy_lock"',
  'flock -x -w 30 8',
  'exec 9<>"$spec_lock"',
  'flock -x -w 30 9',
  'value.get("outboundPaused") is not True',
  'candidateListSha256',
  'treeSha256',
  'os.walk(private, topdown=True, followlinks=False)',
  'is_research_spec_manifest',
  'value.get("schemaVersion") == "production-research-spec-manifest-v1"',
  'not isinstance(payload.get("actionId"), str)',
  'return any(".previous." in part for part in relative.parts)',
  'overlapping research-spec roots',
  'post_archive_inventory="$(collect_inventory)"',
  '[[ "$post_archive_hash" == "$candidate_hash" ]]',
  'if [[ "$mode" == "VERIFY_ARCHIVE" ]]',
  '[[ "$candidate_hash" == "$expected_candidate_hash" ]]',
  '[[ "$archive_hash" == "$expected_archive_hash" ]]',
  'verify_archive_members "$archive_path" "$candidate_hash"',
  'verify_tree_hash "$resolved" "$expected_tree_hash"',
  'O_NOFOLLOW',
  'parent_fds = [anchor_fd]',
  'os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)',
  'delete_exact_tree "$delete_anchor" "$delete_relative"',
  'resolved="$(readlink -e "$target")"',
  'flock -s -w 15 8 || exit 25',
  'flock -s -w 15 9 || exit 26',
  'check_health_and_pause || exit 27',
  'inventory_json="$(collect_inventory)" || exit 28',
  'post_prune_inventory="$(collect_inventory)"',
  'after.get("protected") != before.get("protected")',
  'set(counts) != {"candidate", "previous", "rollback", "oldSpec", "specBackup"}',
  'item["kind"] == "old_research_spec_overlay"',
  'overlay_post_checks+=("$delete_relative|$archive_relative|$expected_tree_hash|$candidate_plan|$overlay_root_identity")',
  '"$candidate_plan" "DELETE" ""',
  '"$overlay_plan" "ABSENT" "$overlay_root_identity"',
  'Test-DownloadedArchive',
  '[Security.Principal.WindowsIdentity]::GetCurrent().User',
  '[Security.Principal.SecurityIdentifier]::new("S-1-5-18")',
  '[Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")',
  '$security.SetAccessRuleProtection($true, $false)',
  '$actual.AreAccessRulesProtected',
  'Set-PrivateLocalMode -Path $backupRoot -Mode "700"',
  'Set-PrivateLocalMode -Path $partialArchive -Mode "600"',
  'Set-PrivateLocalMode -Path $finalArchive -Mode "600"',
  'tar member is outside candidate prefixes',
  'current application member is forbidden',
  'Move-Item -LiteralPath $partialArchive -Destination $finalArchive',
  '-ExpectedCandidateHash $archiveState.CANDIDATE_LIST_SHA256',
  '-ExpectedArchiveHash $archiveState.ARCHIVE_SHA256',
  'REMOTE_ARCHIVE_REMOVED=true'
)) {
  if ($source -notmatch [regex]::Escape($required)) {
    throw "Archive-and-prune implementation is missing a required safety control."
  }
}
foreach ($forbidden in @(
  'plink',
  'pscp',
  'VPS_SSH_PASSWORD',
  'StrictHostKeyChecking=accept-new',
  'rm -rf',
  'rm -r ',
  '${APP_DIR}.*'
)) {
  if ($source -match [regex]::Escape($forbidden)) {
    throw "Archive-and-prune implementation contains a forbidden auth or broad deletion pattern."
  }
}

$allowedOutputKeys = @(
  "ARCHIVE_PRUNE_STATUS",
  "FAILED_STEP",
  "FAILED_EXIT_CODE",
  "SERVICE_HEALTH_BEFORE",
  "OUTBOUND_PAUSED_BEFORE",
  "CANDIDATE_COUNT",
  "PREVIOUS_RELEASE_COUNT",
  "ROLLBACK_STATE_COUNT",
  "OLD_RESEARCH_SPEC_COUNT",
  "RESEARCH_SPEC_BACKUP_COUNT",
  "DELETED_COUNT",
  "CANDIDATE_LIST_SHA256",
  "ARCHIVE_SHA256",
  "ARCHIVE_SIZE",
  "RESUME_EXISTING_ARCHIVE",
  "ARCHIVE_REUSED",
  "TRANSFER_METHOD",
  "LOCAL_ARCHIVE_VERIFIED",
  "REMOTE_ARCHIVE_REMOVED",
  "SERVICE_HEALTH_AFTER",
  "OUTBOUND_PAUSED_AFTER"
)
$literalOutputs = @([regex]::Matches(
  $source,
  '(?:WriteLine\("|print\(f?"|printf\s+'')([A-Z][A-Z0-9_]+)='
) | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
foreach ($key in $literalOutputs) {
  if ($key -notin $allowedOutputKeys) {
    throw "Archive-and-prune script contains a non-redacted literal output key."
  }
}
foreach ($forbiddenOutputToken in @("Remote:", "Workspace:", "Package:", "VPS_IP=", "VPS_SSH_USER=")) {
  if ($source -cmatch [regex]::Escape($forbiddenOutputToken)) {
    throw "Archive-and-prune script contains a path, target, or private-setting output."
  }
}

$remoteAssignment = $ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left.Extent.Text -eq '$remoteScript'
}, $true) | Select-Object -First 1
if ($null -eq $remoteAssignment -or
    $null -eq $remoteAssignment.Right.Expression -or
    $remoteAssignment.Right.Expression.Extent.Text -notmatch "^@'\r?\nset -euo pipefail") {
  throw "Embedded remote script could not be located."
}
$remoteSource = [string]$remoteAssignment.Right.Expression.Extent.Text
$remoteSource = $remoteSource -replace "^@'\r?\n", "" -replace "\r?\n'@$", ""

$bashPath = @(
  "D:\Git\bin\bash.exe",
  "C:\Program Files\Git\bin\bash.exe",
  "C:\Program Files\Git\usr\bin\bash.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

$sandbox = Join-Path ([IO.Path]::GetTempPath()) ("crm-archive-prune-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $sandbox | Out-Null
try {
  if ($bashPath) {
    $bashSyntaxPath = Join-Path $sandbox "remote-syntax.sh"
    [IO.File]::WriteAllText($bashSyntaxPath, $remoteSource, [Text.UTF8Encoding]::new($false))
    & $bashPath -n $bashSyntaxPath
    if ($LASTEXITCODE -ne 0) { throw "Embedded remote bash syntax failed." }
  }

  foreach ($functionName in @(
    "ConvertTo-NativeProcessArgument",
    "Get-TextSha256",
    "Get-NativeProcessTreeIds",
    "Get-ResumeTransferRoot",
    "Invoke-BoundedNativeProcess",
    "Invoke-ProgressAwareNativeProcess",
    "Invoke-ResumableArchiveDownload",
    "Resolve-ArchivePruneMode",
    "Set-PrivateLocalMode",
    "Stop-NativeProcessTree",
    "Test-ArchiveTransferHash",
    "Test-ArchiveOverlayPayloads",
    "Test-DownloadedArchive",
    "Test-NativeProcessRunning"
  )) {
    $functionAst = $ast.Find({
      param($node)
      $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName
    }, $true)
    if ($null -eq $functionAst) { throw "Archive validation helper is missing." }
    Invoke-Expression $functionAst.Extent.Text
  }

  if ((ConvertTo-NativeProcessArgument -Value "plain") -ne "plain" -or
      (ConvertTo-NativeProcessArgument -Value "path with spaces") -ne '"path with spaces"') {
    throw "Native process argument quoting is invalid."
  }
  $unsafeArgumentAccepted = $false
  try {
    $null = ConvertTo-NativeProcessArgument -Value "line`nbreak"
    $unsafeArgumentAccepted = $true
  } catch {
  }
  if ($unsafeArgumentAccepted) { throw "Native process argument quoting accepted a newline." }

  function Assert-ArchiveModeRejected {
    param([hashtable]$Arguments, [string]$ExpectedMessage)
    $actualMessage = ""
    try {
      $null = Resolve-ArchivePruneMode @Arguments
    } catch {
      $actualMessage = [string]$_.Exception.Message
    }
    if ($actualMessage -ne $ExpectedMessage) {
      throw "Archive mode validation did not reject the invalid parameter combination as expected."
    }
  }

  $inventoryMode = Resolve-ArchivePruneMode `
    -Inventory $true -ConfirmArchive $false -Resume $false `
    -Nonce "" -CandidateHash "" -ArchiveHash "" -ConfirmResume $false
  $archiveMode = Resolve-ArchivePruneMode `
    -Inventory $false -ConfirmArchive $true -Resume $false `
    -Nonce "" -CandidateHash "" -ArchiveHash "" -ConfirmResume $false
  if ($inventoryMode.Mode -ne "INVENTORY" -or $archiveMode.Mode -ne "ARCHIVE") {
    throw "Archive mode resolution rejected a valid inventory or archive mode."
  }

  $validNonceUpper = "A" * 32
  $validCandidateUpper = "B" * 64
  $validArchiveUpper = "C" * 64
  $resumeMode = Resolve-ArchivePruneMode `
    -Inventory $false -ConfirmArchive $false -Resume $true `
    -Nonce $validNonceUpper -CandidateHash $validCandidateUpper `
    -ArchiveHash $validArchiveUpper -ConfirmResume $true
  if ($resumeMode.Mode -ne "RESUME" -or
      $resumeMode.Nonce -ne ("a" * 32) -or
      $resumeMode.CandidateHash -ne ("b" * 64) -or
      $resumeMode.ArchiveHash -ne ("c" * 64)) {
    throw "Archive resume mode did not normalize a valid uppercase identity."
  }

  $baseModeArguments = @{
    Inventory = $false
    ConfirmArchive = $false
    Resume = $false
    Nonce = ""
    CandidateHash = ""
    ArchiveHash = ""
    ConfirmResume = $false
  }
  $arguments = $baseModeArguments.Clone(); $arguments.Inventory = $true; $arguments.ConfirmArchive = $true
  Assert-ArchiveModeRejected -Arguments $arguments -ExpectedMessage "AMBIGUOUS_MODE"
  $arguments = $baseModeArguments.Clone(); $arguments.Resume = $true; $arguments.ConfirmArchive = $true
  Assert-ArchiveModeRejected -Arguments $arguments -ExpectedMessage "AMBIGUOUS_MODE"
  $arguments = $baseModeArguments.Clone(); $arguments.Nonce = "a" * 32
  Assert-ArchiveModeRejected -Arguments $arguments -ExpectedMessage "RESUME_PARAMETERS_WITHOUT_MODE"
  $arguments = $baseModeArguments.Clone(); $arguments.Resume = $true
  $arguments.Nonce = "a" * 32; $arguments.CandidateHash = "b" * 64; $arguments.ArchiveHash = "c" * 64
  Assert-ArchiveModeRejected -Arguments $arguments -ExpectedMessage "RESUME_CONFIRMATION_REQUIRED"
  foreach ($invalidResumeIdentity in @(
    @{ Nonce = "a" * 31; CandidateHash = "b" * 64; ArchiveHash = "c" * 64 },
    @{ Nonce = "z" * 32; CandidateHash = "b" * 64; ArchiveHash = "c" * 64 },
    @{ Nonce = "a" * 32; CandidateHash = "b" * 63; ArchiveHash = "c" * 64 },
    @{ Nonce = "a" * 32; CandidateHash = "g" * 64; ArchiveHash = "c" * 64 },
    @{ Nonce = "a" * 32; CandidateHash = "b" * 64; ArchiveHash = "c" * 63 },
    @{ Nonce = "a" * 32; CandidateHash = "b" * 64; ArchiveHash = "x" * 64 }
  )) {
    $arguments = $baseModeArguments.Clone()
    $arguments.Resume = $true
    $arguments.ConfirmResume = $true
    $arguments.Nonce = $invalidResumeIdentity.Nonce
    $arguments.CandidateHash = $invalidResumeIdentity.CandidateHash
    $arguments.ArchiveHash = $invalidResumeIdentity.ArchiveHash
    Assert-ArchiveModeRejected -Arguments $arguments -ExpectedMessage "RESUME_INPUT_INVALID"
  }

  $boundedOutput = Join-Path $sandbox "bounded-process.stdout"
  $boundedError = Join-Path $sandbox "bounded-process.stderr"
  $versionResult = Invoke-BoundedNativeProcess `
    -FilePath (Get-Command ssh).Source `
    -Arguments @("-V") `
    -StandardOutputPath $boundedOutput `
    -StandardErrorPath $boundedError `
    -TimeoutSeconds 5
  if ($versionResult.TimedOut -or $versionResult.ExitCode -ne 0) {
    throw "Bounded native process rejected a successful local command."
  }
  Remove-Item -LiteralPath $boundedOutput,$boundedError -Force -ErrorAction SilentlyContinue

  $binaryPayload = @'
$bytes = [byte[]](0..255)
$stream = [Console]::OpenStandardOutput()
$stream.Write($bytes, 0, $bytes.Length)
$stream.Flush()
'@
  $binaryCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($binaryPayload))
  $binaryResult = Invoke-BoundedNativeProcess `
    -FilePath (Get-Process -Id $PID).Path `
    -Arguments @("-NoProfile", "-EncodedCommand", $binaryCommand) `
    -StandardOutputPath $boundedOutput `
    -StandardErrorPath $boundedError `
    -TimeoutSeconds 5
  $binaryAlgorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $expectedBinaryHash = (($binaryAlgorithm.ComputeHash([byte[]](0..255)) |
      ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $binaryAlgorithm.Dispose()
  }
  $actualBinaryHash = if (Test-Path -LiteralPath $boundedOutput -PathType Leaf) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath $boundedOutput).Hash.ToLowerInvariant()
  } else {
    ""
  }
  if ($binaryResult.TimedOut -or $binaryResult.ExitCode -ne 0 -or
      (Get-Item -LiteralPath $boundedOutput).Length -ne 256 -or
      $actualBinaryHash -ne $expectedBinaryHash) {
    throw "Bounded native process stdout redirection is not binary-transparent."
  }
  Remove-Item -LiteralPath $boundedOutput,$boundedError -Force -ErrorAction SilentlyContinue

  $treePidPath = Join-Path $sandbox "bounded-process-tree.pids"
  $childExecutable = (Get-Process -Id $PID).Path.Replace("'", "''")
  $treePidLiteral = $treePidPath.Replace("'", "''")
  $treePayload = @"
`$startInfo = [Diagnostics.ProcessStartInfo]::new()
`$startInfo.FileName = '$childExecutable'
`$startInfo.Arguments = '-NoProfile -Command "Start-Sleep -Seconds 30"'
`$startInfo.UseShellExecute = `$false
`$startInfo.CreateNoWindow = `$true
`$child = [Diagnostics.Process]::Start(`$startInfo)
[IO.File]::WriteAllLines('$treePidLiteral', [string[]]@([string]`$PID, [string]`$child.Id))
Start-Sleep -Seconds 30
"@
  $treeCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($treePayload))
  $treeProcessIds = @()
  try {
    $timeoutResult = Invoke-BoundedNativeProcess `
      -FilePath (Get-Process -Id $PID).Path `
      -Arguments @("-NoProfile", "-EncodedCommand", $treeCommand) `
      -StandardOutputPath $boundedOutput `
      -StandardErrorPath $boundedError `
      -TimeoutSeconds 3
    if (Test-Path -LiteralPath $treePidPath -PathType Leaf) {
      $treeProcessIds = @(Get-Content -LiteralPath $treePidPath | ForEach-Object { [int]$_ })
    }
    if (-not $timeoutResult.TimedOut -or $timeoutResult.ExitCode -ne 124 -or
        $treeProcessIds.Count -ne 2 -or
        @($treeProcessIds | Where-Object { Test-NativeProcessRunning -ProcessId $_ }).Count -ne 0) {
      throw "Bounded native process did not terminate the parent and child process tree."
    }
  } finally {
    foreach ($treeProcessId in $treeProcessIds) {
      Stop-Process -Id $treeProcessId -Force -ErrorAction SilentlyContinue
    }
  }

  $transferHashFixture = Join-Path $sandbox "transfer-hash.fixture"
  [IO.File]::WriteAllText($transferHashFixture, "synthetic", [Text.UTF8Encoding]::new($false))
  $transferHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $transferHashFixture).Hash.ToLowerInvariant()
  if (-not (Test-ArchiveTransferHash -Path $transferHashFixture -ExpectedSha256 $transferHash) -or
      (Test-ArchiveTransferHash -Path $transferHashFixture -ExpectedSha256 ("0" * 64))) {
    throw "Archive transfer hash helper is invalid."
  }

  function Assert-ArchiveTransferRejected {
    param(
      [string]$PartialPath,
      [string]$ExpectedSha256,
      [long]$ExpectedSize,
      [string]$FailureMessage
    )
    $accepted = $false
    try {
      $null = Invoke-ResumableArchiveDownload `
        -Remote "fixture@example.invalid" `
        -RemoteArchive ("/tmp/export-ai-agent-old-versions-{0}.tar.gz" -f ("d" * 32)) `
        -PartialArchive $PartialPath `
        -ExpectedSha256 $ExpectedSha256 `
        -ExpectedSize $ExpectedSize `
        -SshArguments @()
      $accepted = $true
    } catch {
    }
    if ($accepted) { throw $FailureMessage }
  }

  $completePartial = Join-Path $sandbox "complete-resume.tar.gz.partial"
  $completeBytes = [Text.UTF8Encoding]::new($false).GetBytes("complete synthetic archive")
  [IO.File]::WriteAllBytes($completePartial, $completeBytes)
  $completeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $completePartial).Hash.ToLowerInvariant()
  $completeMethod = Invoke-ResumableArchiveDownload `
    -Remote "fixture@example.invalid" `
    -RemoteArchive ("/tmp/export-ai-agent-old-versions-{0}.tar.gz" -f ("d" * 32)) `
    -PartialArchive $completePartial `
    -ExpectedSha256 $completeHash `
    -ExpectedSize $completeBytes.Length `
    -SshArguments @()
  if ($completeMethod -ne "EXISTING_PARTIAL") {
    throw "Archive resume did not reuse a complete verified partial file."
  }

  $corruptPartial = Join-Path $sandbox "corrupt-resume.tar.gz.partial"
  $corruptBytes = [byte[]]::new($completeBytes.Length)
  [Array]::Copy($completeBytes, $corruptBytes, $completeBytes.Length)
  $corruptBytes[0] = $corruptBytes[0] -bxor 1
  [IO.File]::WriteAllBytes($corruptPartial, $corruptBytes)
  Assert-ArchiveTransferRejected `
    -PartialPath $corruptPartial `
    -ExpectedSha256 $completeHash `
    -ExpectedSize $completeBytes.Length `
    -FailureMessage "Archive resume accepted a same-length partial with the wrong hash."

  $oversizePartial = Join-Path $sandbox "oversize-resume.tar.gz.partial"
  [IO.File]::WriteAllBytes($oversizePartial, [byte[]](0..15))
  Assert-ArchiveTransferRejected `
    -PartialPath $oversizePartial `
    -ExpectedSha256 ("0" * 64) `
    -ExpectedSize 8 `
    -FailureMessage "Archive resume accepted a partial larger than the remote archive."

  $preservedPartial = Join-Path $sandbox "preserved-resume.tar.gz.partial"
  [IO.File]::WriteAllBytes($preservedPartial, [byte[]](1, 2, 3, 4))
  $preservedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $preservedPartial).Hash.ToLowerInvariant()
  $originalProgressProcess = (Get-Command Invoke-ProgressAwareNativeProcess).ScriptBlock
  try {
    Set-Item -Path "Function:\Invoke-ProgressAwareNativeProcess" -Value {
      return [pscustomobject]@{ Stalled = $true; TimedOut = $false; ExitCode = 124; Bytes = 4L }
    }
    Assert-ArchiveTransferRejected `
      -PartialPath $preservedPartial `
      -ExpectedSha256 ("0" * 64) `
      -ExpectedSize 8 `
      -FailureMessage "Archive resume unexpectedly succeeded after repeated no-progress transfers."
  } finally {
    Set-Item -Path "Function:\Invoke-ProgressAwareNativeProcess" -Value $originalProgressProcess
  }
  if (-not (Test-Path -LiteralPath $preservedPartial -PathType Leaf) -or
      (Get-FileHash -Algorithm SHA256 -LiteralPath $preservedPartial).Hash.ToLowerInvariant() -ne $preservedHash) {
    throw "Archive resume did not preserve an incomplete partial after transfer failure."
  }

  $aclDirectory = Join-Path $sandbox "acl-directory"
  $aclFile = Join-Path $aclDirectory "archive.partial"
  New-Item -ItemType Directory -Path $aclDirectory | Out-Null
  [IO.File]::WriteAllText($aclFile, "synthetic", [Text.UTF8Encoding]::new($false))
  Set-PrivateLocalMode -Path $aclDirectory -Mode "700"
  Set-PrivateLocalMode -Path $aclFile -Mode "600"
  if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    $allowedAclSids = @(
      [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
      "S-1-5-18",
      "S-1-5-32-544"
    ) | Sort-Object -Unique
    foreach ($aclTarget in @($aclDirectory, $aclFile)) {
      $targetAcl = Get-Acl -LiteralPath $aclTarget
      if (-not $targetAcl.AreAccessRulesProtected) { throw "Synthetic private ACL still inherits permissions." }
      $targetAllowSids = @($targetAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) |
        Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow } |
        ForEach-Object { $_.IdentityReference.Value } |
        Sort-Object -Unique)
      if (($targetAllowSids -join "|") -ne ($allowedAclSids -join "|")) {
        throw "Synthetic private ACL allowlist mismatch."
      }
    }
  }

  function New-ResearchSpecFixture {
    param([string]$Path, [string]$Label, [switch]$ManifestOnly)
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $specManifest = [ordered]@{
      schemaVersion = "production-research-spec-manifest-v1"
      sourcePlanId = "synthetic-$Label"
      targetTotal = 5
      campaigns = @()
      externalSendAuthorized = $false
    }
    [IO.File]::WriteAllText(
      (Join-Path $Path "manifest.json"),
      ($specManifest | ConvertTo-Json -Depth 5) + "`n",
      [Text.UTF8Encoding]::new($false)
    )
    if (-not $ManifestOnly) {
      foreach ($index in 1..5) {
        [IO.File]::WriteAllText(
          (Join-Path $Path ("spec-{0}.json" -f $index)),
          "{`"fixture`":`"$Label-$index`"}`n",
          [Text.UTF8Encoding]::new($false)
        )
      }
    }
  }

  function Get-FixtureSpecFingerprint {
    param([string]$Path)
    $files = @(Get-ChildItem -LiteralPath $Path -File -Filter "*.json" | Sort-Object Name)
    if ($files.Count -ne 6) { throw "Synthetic spec fingerprint requires six JSON files." }
    $rows = @($files | ForEach-Object {
      "$($_.Name):$((Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant())"
    })
    return Get-TextSha256 -Value ($rows -join "`n")
  }

  function New-LegacyResearchSpecFixture {
    param([string]$Path)
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $campaigns = @()
    foreach ($index in 1..7) {
      $filename = "legacy-spec-$index.json"
      $campaigns += [ordered]@{ file = $filename; market = "Market $index"; targetCount = 1 }
      $payload = [ordered]@{
        actionId = "legacy-action-$index"
        campaign = [ordered]@{ id = "legacy-campaign-$index" }
        brief = [ordered]@{ objective = "synthetic" }
      }
      [IO.File]::WriteAllText(
        (Join-Path $Path $filename),
        ($payload | ConvertTo-Json -Depth 5) + "`n",
        [Text.UTF8Encoding]::new($false)
      )
    }
    $manifest = [ordered]@{
      schemaVersion = "production-acquisition-spec-manifest-v1"
      targetTotal = 7
      campaigns = $campaigns
    }
    [IO.File]::WriteAllText(
      (Join-Path $Path "manifest.json"),
      ($manifest | ConvertTo-Json -Depth 5) + "`n",
      [Text.UTF8Encoding]::new($false)
    )
  }

  $inventoryMatch = [regex]::Match(
    $remoteSource,
    "(?s)collect_inventory\(\)\s*\{\s*python3[^\r\n]*<<'PY'\r?\n(?<body>.*?)\r?\nPY\r?\n\}"
  )
  if (-not $inventoryMatch.Success) { throw "Embedded inventory Python could not be extracted." }
  $deleteMatch = [regex]::Match(
    $remoteSource,
    "(?s)delete_exact_tree\(\)\s*\{\s*python3[^\r\n]*<<'PY'\r?\n(?<body>.*?)\r?\nPY\r?\n\}"
  )
  if (-not $deleteMatch.Success) { throw "Embedded anchored-delete Python could not be extracted." }
  $overlayDeleteMatch = [regex]::Match(
    $remoteSource,
    "(?s)delete_exact_overlay_files\(\)\s*\{\s*python3[^\r\n]*<<'PY'\r?\n(?<body>.*?)\r?\nPY\r?\n\}"
  )
  if (-not $overlayDeleteMatch.Success) { throw "Embedded overlay-delete Python could not be extracted." }
  $inventoryPython = Join-Path $sandbox "collect-inventory.py"
  $deletePython = Join-Path $sandbox "delete-exact-tree.py"
  $overlayDeletePython = Join-Path $sandbox "delete-exact-overlay-files.py"
  [IO.File]::WriteAllText($inventoryPython, $inventoryMatch.Groups["body"].Value, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($deletePython, $deleteMatch.Groups["body"].Value, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText(
    $overlayDeletePython,
    $overlayDeleteMatch.Groups["body"].Value,
    [Text.UTF8Encoding]::new($false)
  )
  $pythonCommand = @(Get-Command python3, python -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($pythonCommand.Count -ne 1) { throw "Python is required for the synthetic inventory test." }

  $dirFdSupport = @(& $pythonCommand[0].Source -c "import os; print('true' if os.open in os.supports_dir_fd and os.stat in os.supports_dir_fd else 'false')") -join ""
  if ($dirFdSupport -eq "true") {
    $deleteAnchor = Join-Path $sandbox "anchored-delete-fixture\anchor"
    $protectedSibling = Join-Path $deleteAnchor "current-spec"
    $nestedCandidate = Join-Path $deleteAnchor "history\old-spec"
    New-Item -ItemType Directory -Force -Path $protectedSibling | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $nestedCandidate "payload") | Out-Null
    [IO.File]::WriteAllText((Join-Path $protectedSibling "keep.txt"), "protected", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $nestedCandidate "payload\delete.txt"), "old", [Text.UTF8Encoding]::new($false))
    $null = & $pythonCommand[0].Source $deletePython $deleteAnchor "history/old-spec"
    if ($LASTEXITCODE -ne 0 -or
        (Test-Path -LiteralPath $nestedCandidate) -or
        -not (Test-Path -LiteralPath $protectedSibling -PathType Container) -or
        -not (Test-Path -LiteralPath $deleteAnchor -PathType Container) -or
        -not (Test-Path -LiteralPath (Join-Path $deleteAnchor "history") -PathType Container)) {
      throw "Anchored-delete dynamic fixture removed the wrong tree."
    }

    $outsideRoot = Join-Path $sandbox "anchored-delete-fixture\outside"
    $outsideChild = Join-Path $outsideRoot "child"
    New-Item -ItemType Directory -Force -Path $outsideChild | Out-Null
    [IO.File]::WriteAllText((Join-Path $outsideChild "keep.txt"), "outside", [Text.UTF8Encoding]::new($false))
    $redirect = Join-Path $deleteAnchor "redirect"
    New-Item -ItemType SymbolicLink -Path $redirect -Target $outsideRoot | Out-Null
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $null = & $pythonCommand[0].Source $deletePython $deleteAnchor "redirect/child" 2>$null
      $symlinkExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousPreference
    }
    if ($symlinkExitCode -eq 0 -or
        -not (Test-Path -LiteralPath $outsideChild -PathType Container) -or
        -not (Test-Path -LiteralPath $redirect)) {
      throw "Anchored-delete dynamic fixture followed an intermediate symlink."
    }

    $overlayAnchor = Join-Path $sandbox "overlay-delete-fixture\anchor"
    $overlayRelative = "history/legacy-overlay"
    $overlayArchivePath = "export-ai-agent/private/$overlayRelative"
    $overlayRoot = Join-Path $overlayAnchor "history\legacy-overlay"
    $overlayProtected = Join-Path $overlayRoot "current\base-current"
    New-Item -ItemType Directory -Force -Path $overlayProtected | Out-Null
    [IO.File]::WriteAllText((Join-Path $overlayRoot "manifest.json"), ('{"legacy":true}' + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $overlayRoot "legacy.json"), ('{"payload":true}' + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $overlayRoot "keep.txt"), "container", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $overlayProtected "keep.json"), ('{"current":true}' + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    $planBuilder = Join-Path $sandbox "build-overlay-plan.py"
    [IO.File]::WriteAllText($planBuilder, @'
import base64
import hashlib
import json
import pathlib
import stat
import sys
root = pathlib.Path(sys.argv[1])
archive_path = sys.argv[2]
members = []
rows = []
for name in ("legacy.json", "manifest.json"):
    path = root / name
    info = path.lstat()
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    mode = f"{stat.S_IMODE(info.st_mode):o}"
    members.append({"relativePath": name, "mode": mode, "size": info.st_size, "sha256": digest})
    rows.append(f"F|{name}|{mode}|{info.st_size}|{digest}")
tree_hash = hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()
candidate = {
    "kind": "old_research_spec_overlay",
    "archivePath": archive_path,
    "treeSha256": tree_hash,
    "members": members,
}
print(tree_hash)
print(base64.urlsafe_b64encode(json.dumps(candidate, separators=(",", ":"), sort_keys=True).encode("utf-8")).decode("ascii").rstrip("="))
'@, [Text.UTF8Encoding]::new($false))
    $planOutput = @(& $pythonCommand[0].Source $planBuilder $overlayRoot $overlayArchivePath)
    if ($LASTEXITCODE -ne 0 -or $planOutput.Count -ne 2) { throw "Synthetic overlay delete plan creation failed." }
    $overlayTreeHash = [string]$planOutput[0]
    $overlayPlan = [string]$planOutput[1]

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $null = & $pythonCommand[0].Source $overlayDeletePython $overlayAnchor $overlayRelative $overlayArchivePath ("0" * 64) $overlayPlan "DELETE" "" 2>$null
      $wrongBindingExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousPreference
    }
    if ($wrongBindingExitCode -eq 0 -or
        -not (Test-Path -LiteralPath (Join-Path $overlayRoot "manifest.json") -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $overlayRoot "legacy.json") -PathType Leaf)) {
      throw "Overlay delete accepted an unbound expected tree hash."
    }

    $rootIdentity = @(& $pythonCommand[0].Source $overlayDeletePython $overlayAnchor $overlayRelative $overlayArchivePath $overlayTreeHash $overlayPlan "DELETE" "")
    if ($LASTEXITCODE -ne 0 -or $rootIdentity.Count -ne 1 -or
        [string]$rootIdentity[0] -notmatch '^[0-9]+:[0-9]+$') {
      throw "Synthetic overlay exact-file deletion failed."
    }
    $null = & $pythonCommand[0].Source $overlayDeletePython $overlayAnchor $overlayRelative $overlayArchivePath $overlayTreeHash $overlayPlan "ABSENT" ([string]$rootIdentity[0])
    if ($LASTEXITCODE -ne 0 -or
        (Test-Path -LiteralPath (Join-Path $overlayRoot "manifest.json")) -or
        (Test-Path -LiteralPath (Join-Path $overlayRoot "legacy.json")) -or
        -not (Test-Path -LiteralPath $overlayRoot -PathType Container) -or
        -not (Test-Path -LiteralPath $overlayProtected -PathType Container) -or
        -not (Test-Path -LiteralPath (Join-Path $overlayProtected "keep.json") -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $overlayRoot "keep.txt") -PathType Leaf)) {
      throw "Overlay deletion removed its container or a protected sibling."
    }
  }

  $inventoryApp = Join-Path $sandbox "inventory-fixture\export-ai-agent"
  $inventoryPrivate = Join-Path $inventoryApp "private"
  $nestedLegacyOld = Join-Path $inventoryPrivate "legacy-container"
  $nestedBase = Join-Path $nestedLegacyOld "current\base-current"
  $directExpanded = Join-Path $inventoryPrivate "production-research-specs-expanded-current"
  $expandedBackup = Join-Path $inventoryPrivate "production-research-specs-expanded-current.previous.fixture"
  $nestedOld = Join-Path $nestedLegacyOld "history\valid-old"
  New-ResearchSpecFixture -Path $nestedBase -Label "base"
  New-ResearchSpecFixture -Path $directExpanded -Label "expanded"
  New-Item -ItemType Directory -Force -Path $expandedBackup | Out-Null
  Copy-Item -LiteralPath (Join-Path $directExpanded "manifest.json") -Destination $expandedBackup
  foreach ($index in 1..5) {
    Copy-Item -LiteralPath (Join-Path $directExpanded ("spec-{0}.json" -f $index)) -Destination $expandedBackup
  }
  New-ResearchSpecFixture -Path $nestedOld -Label "old"
  New-LegacyResearchSpecFixture -Path $nestedLegacyOld
  $unrelatedManifestRoot = Join-Path $inventoryPrivate "metadata"
  New-Item -ItemType Directory -Force -Path $unrelatedManifestRoot | Out-Null
  [IO.File]::WriteAllText(
    (Join-Path $unrelatedManifestRoot "manifest.json"),
    "{`"schemaVersion`":`"unrelated-v1`"}`n",
    [Text.UTF8Encoding]::new($false)
  )
  New-Item -ItemType Directory -Force -Path (Join-Path $inventoryApp "..\export-ai-agent.previous") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $inventoryApp "..\export-ai-agent.rollback-state") | Out-Null
  [IO.File]::WriteAllText((Join-Path $inventoryApp "..\export-ai-agent.previous\release.txt"), "old", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $inventoryApp "..\export-ai-agent.rollback-state\state.txt"), "rollback", [Text.UTF8Encoding]::new($false))

  $fixtureBaseFingerprint = Get-FixtureSpecFingerprint -Path $nestedBase
  $fixtureExpandedFingerprint = Get-FixtureSpecFingerprint -Path $directExpanded
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $inventoryOutput = @(& $pythonCommand[0].Source $inventoryPython $inventoryApp $fixtureBaseFingerprint $fixtureExpandedFingerprint 2>&1)
    $inventoryExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($inventoryExitCode -ne 0) {
    throw "Synthetic recursive inventory failed: $($inventoryOutput -join ' ')"
  }
  $inventory = (($inventoryOutput | ForEach-Object { [string]$_ }) -join "`n") | ConvertFrom-Json
  if ([int]$inventory.counts.candidate -ne 5 -or
      [int]$inventory.counts.previous -ne 1 -or
      [int]$inventory.counts.rollback -ne 1 -or
      [int]$inventory.counts.oldSpec -ne 2 -or
      [int]$inventory.counts.specBackup -ne 1 -or
      [string]$inventory.protected.baseArchivePath -ne "export-ai-agent/private/legacy-container/current/base-current" -or
      [string]$inventory.protected.expandedArchivePath -ne "export-ai-agent/private/production-research-specs-expanded-current") {
    throw "Synthetic recursive inventory did not classify protected and old roots correctly."
  }
  $inventoryRoots = @($inventory.candidates | ForEach-Object { [string]$_.archivePath })
  foreach ($requiredRoot in @(
    "export-ai-agent/private/legacy-container",
    "export-ai-agent/private/legacy-container/history/valid-old",
    "export-ai-agent/private/production-research-specs-expanded-current.previous.fixture"
  )) {
    if ($requiredRoot -notin $inventoryRoots) { throw "Synthetic recursive inventory omitted an expected old root." }
  }
  if (@($inventoryRoots | Where-Object { $_ -like "*/metadata" }).Count -ne 0) {
    throw "Synthetic recursive inventory treated an unrelated manifest as a research spec."
  }
  $overlayCandidate = @($inventory.candidates | Where-Object { $_.kind -eq "old_research_spec_overlay" })
  if ($overlayCandidate.Count -ne 1 -or @($overlayCandidate[0].members).Count -ne 8) {
    throw "Synthetic recursive inventory did not create one exact legacy overlay candidate."
  }

  function Invoke-SyntheticInventoryForExitCode {
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $null = & $pythonCommand[0].Source $inventoryPython $inventoryApp $fixtureBaseFingerprint $fixtureExpandedFingerprint 2>$null
      return $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $savedPreference
    }
  }

  $referencedPayload = Join-Path $nestedLegacyOld "legacy-spec-1.json"
  $payloadSource = Join-Path $sandbox "legacy-spec-1-source.json"
  Copy-Item -LiteralPath $referencedPayload -Destination $payloadSource
  $inventorySymlinkCreated = $false
  try {
    Remove-Item -LiteralPath $referencedPayload -Force
    New-Item -ItemType SymbolicLink -Path $referencedPayload -Target $payloadSource -ErrorAction Stop | Out-Null
    $inventorySymlinkCreated = $true
    if ((Invoke-SyntheticInventoryForExitCode) -eq 0) {
      throw "Synthetic inventory accepted a symlinked legacy overlay member."
    }
  } catch {
    if ($inventorySymlinkCreated) { throw }
  } finally {
    if (Test-Path -LiteralPath $referencedPayload) { Remove-Item -LiteralPath $referencedPayload -Force }
    Copy-Item -LiteralPath $payloadSource -Destination $referencedPayload
  }

  Remove-Item -LiteralPath $referencedPayload -Force
  New-Item -ItemType HardLink -Path $referencedPayload -Target $payloadSource | Out-Null
  $hardlinkInventoryExitCode = Invoke-SyntheticInventoryForExitCode
  Remove-Item -LiteralPath $referencedPayload -Force
  Copy-Item -LiteralPath $payloadSource -Destination $referencedPayload
  if ($hardlinkInventoryExitCode -eq 0) {
    throw "Synthetic inventory accepted a hard-linked legacy overlay member."
  }

  $overlapChild = Join-Path $nestedOld "child-spec"
  New-ResearchSpecFixture -Path $overlapChild -Label "overlap" -ManifestOnly
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $null = & $pythonCommand[0].Source $inventoryPython $inventoryApp $fixtureBaseFingerprint $fixtureExpandedFingerprint 2>$null
    $overlapExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($overlapExitCode -eq 0) { throw "Synthetic recursive inventory accepted overlapping manifest roots." }

  $script:baseSpecFingerprint = "1" * 64
  $script:expandedSpecFingerprint = "2" * 64
  $stage = Join-Path $sandbox "stage"
  $previousRoot = Join-Path $stage "export-ai-agent.previous"
  $oldSpecRoot = Join-Path $stage "export-ai-agent\private\history\legacy-spec"
  $backupSpecRoot = Join-Path $stage "export-ai-agent\private\production-research-specs-old.previous.fixture"
  $overlayArchiveRoot = "export-ai-agent/private/legacy-container"
  $overlayStageRoot = Join-Path $stage "export-ai-agent\private\legacy-container"
  $protectedBaseRoot = Join-Path $overlayStageRoot "current\base-current"
  New-Item -ItemType Directory -Force -Path (Join-Path $previousRoot "agent_service\data") | Out-Null
  New-Item -ItemType Directory -Force -Path $oldSpecRoot | Out-Null
  New-Item -ItemType Directory -Force -Path $backupSpecRoot | Out-Null
  New-Item -ItemType Directory -Force -Path $protectedBaseRoot | Out-Null
  [IO.File]::WriteAllText((Join-Path $previousRoot ".env"), "SYNTHETIC_ONLY=true`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $previousRoot "agent_service\data\agent.db"), "synthetic-db", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $oldSpecRoot "manifest.json"), "{}`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $backupSpecRoot "manifest.json"), "{}`n", [Text.UTF8Encoding]::new($false))

  [IO.File]::WriteAllText(
    (Join-Path $protectedBaseRoot "keep.json"),
    ("{}" + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
  )

  $protected = [ordered]@{
    baseArchivePath = "$overlayArchiveRoot/current/base-current"
    baseFingerprint = $script:baseSpecFingerprint
    expandedArchivePath = "export-ai-agent/private/production-research-specs-current-expanded"
    expandedFingerprint = $script:expandedSpecFingerprint
  }
  $manifestPath = Join-Path $stage "archive_manifest.json"
  function Write-ArchiveManifestFixture {
    param([object[]]$Candidates, [hashtable]$Counts)
    $identityRows = @(
      $Candidates | ForEach-Object { "$($_.kind)|$($_.archivePath)|$($_.treeSha256)" }
      "protected_base|$($protected.baseArchivePath)|$($protected.baseFingerprint)"
      "protected_expanded|$($protected.expandedArchivePath)|$($protected.expandedFingerprint)"
    ) | Sort-Object
    $hash = Get-TextSha256 -Value ($identityRows -join "`n")
    $value = [ordered]@{
      schemaVersion = "server-old-version-archive-manifest-v1"
      candidateListSha256 = $hash
      counts = $Counts
      candidates = $Candidates
      protected = $protected
    }
    [IO.File]::WriteAllText($manifestPath, ($value | ConvertTo-Json -Depth 8) + "`n", [Text.UTF8Encoding]::new($false))
    return $hash
  }

  $candidates = @(
    [ordered]@{ kind = "previous_release"; archivePath = "export-ai-agent.previous"; treeSha256 = ("a" * 64) },
    [ordered]@{ kind = "old_research_spec"; archivePath = "export-ai-agent/private/history/legacy-spec"; treeSha256 = ("b" * 64) },
    [ordered]@{ kind = "research_spec_backup"; archivePath = "export-ai-agent/private/production-research-specs-old.previous.fixture"; treeSha256 = ("c" * 64) }
  )
  $goodCounts = @{ candidate = 3; previous = 1; rollback = 0; oldSpec = 1; specBackup = 1 }
  $candidateHash = Write-ArchiveManifestFixture -Candidates $candidates -Counts $goodCounts
  $goodArchive = Join-Path $sandbox "good.tar.gz"
  & tar -czf $goodArchive -C $stage `
    "archive_manifest.json" `
    "export-ai-agent.previous" `
    "export-ai-agent/private/history/legacy-spec" `
    "export-ai-agent/private/production-research-specs-old.previous.fixture"
  if ($LASTEXITCODE -ne 0) { throw "Synthetic good archive creation failed." }
  $goodArchiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $goodArchive).Hash.ToLowerInvariant()
  Test-DownloadedArchive `
    -ArchivePath $goodArchive `
    -ExpectedArchiveHash $goodArchiveHash `
    -ExpectedCandidateHash $candidateHash `
    -ExpectedCandidateCount 3 `
    -ExpectedCounts $goodCounts

  function Assert-SyntheticArchiveRejected {
    param(
      [string]$Archive,
      [string]$ArchiveHash,
      [string]$CandidateHash,
      [int]$CandidateCount,
      [hashtable]$Counts,
      [string]$FailureMessage
    )
    $accepted = $false
    try {
      Test-DownloadedArchive -ArchivePath $Archive -ExpectedArchiveHash $ArchiveHash -ExpectedCandidateHash $CandidateHash -ExpectedCandidateCount $CandidateCount -ExpectedCounts $Counts
      $accepted = $true
    } catch {
    }
    if ($accepted) { throw $FailureMessage }
  }

  $overlayManifestPath = Join-Path $overlayStageRoot "manifest.json"
  $overlayPayloadPath = Join-Path $overlayStageRoot "legacy.json"
  [IO.File]::WriteAllText($overlayManifestPath, ('{"schemaVersion":"production-acquisition-spec-manifest-v1"}' + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($overlayPayloadPath, ('{"actionId":"legacy"}' + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  $overlayModeProbe = Join-Path $sandbox "overlay-mode-probe.tar.gz"
  & tar -czf $overlayModeProbe -C $stage "$overlayArchiveRoot/legacy.json"
  if ($LASTEXITCODE -ne 0) { throw "Synthetic overlay mode probe creation failed." }
  $tarModeReader = Join-Path $sandbox "read-tar-mode.py"
  [IO.File]::WriteAllText($tarModeReader, @'
import sys
import tarfile
with tarfile.open(sys.argv[1], "r:gz") as package:
    print(f"{package.getmember(sys.argv[2]).mode:o}")
'@, [Text.UTF8Encoding]::new($false))
  $fixtureOverlayMode = (@(& $pythonCommand[0].Source $tarModeReader $overlayModeProbe "$overlayArchiveRoot/legacy.json") -join "").Trim()
  if ($LASTEXITCODE -ne 0 -or $fixtureOverlayMode -notmatch '^[0-7]{3,4}$') {
    throw "Synthetic overlay tar mode could not be determined."
  }

  function New-OverlayArchiveMember {
    param([string]$Path, [string]$RelativePath)
    return [ordered]@{
      relativePath = $RelativePath
      mode = $fixtureOverlayMode
      size = [long](Get-Item -LiteralPath $Path).Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    }
  }

  $overlayMembers = @(
    (New-OverlayArchiveMember -Path $overlayPayloadPath -RelativePath "legacy.json"),
    (New-OverlayArchiveMember -Path $overlayManifestPath -RelativePath "manifest.json")
  )
  $overlayMemberRows = @($overlayMembers | ForEach-Object { "F|$($_.relativePath)|$($_.mode)|$($_.size)|$($_.sha256)" })
  $overlayTreeHash = Get-TextSha256 -Value ($overlayMemberRows -join ([string][char]10))
  $overlayCandidateFixture = [ordered]@{
    kind = "old_research_spec_overlay"
    archivePath = $overlayArchiveRoot
    treeSha256 = $overlayTreeHash
    members = $overlayMembers
  }
  $overlayCandidates = @($candidates + $overlayCandidateFixture)
  $overlayCounts = @{ candidate = 4; previous = 1; rollback = 0; oldSpec = 2; specBackup = 1 }
  $overlayCandidateHash = Write-ArchiveManifestFixture -Candidates $overlayCandidates -Counts $overlayCounts
  $overlayGoodArchive = Join-Path $sandbox "good-overlay.tar.gz"
  & tar -czf $overlayGoodArchive -C $stage "archive_manifest.json" "export-ai-agent.previous" "export-ai-agent/private/history/legacy-spec" "export-ai-agent/private/production-research-specs-old.previous.fixture" "$overlayArchiveRoot/legacy.json" "$overlayArchiveRoot/manifest.json"
  if ($LASTEXITCODE -ne 0) { throw "Synthetic exact overlay archive creation failed." }
  $overlayGoodHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $overlayGoodArchive).Hash.ToLowerInvariant()
  Test-DownloadedArchive -ArchivePath $overlayGoodArchive -ExpectedArchiveHash $overlayGoodHash -ExpectedCandidateHash $overlayCandidateHash -ExpectedCandidateCount 4 -ExpectedCounts $overlayCounts
  $overlayArchiveMembers = @(& tar -tzf $overlayGoodArchive | ForEach-Object { ([string]$_).TrimEnd("/") })
  if ($overlayArchiveRoot -in $overlayArchiveMembers -or
      "$overlayArchiveRoot/current/base-current" -in $overlayArchiveMembers -or
      "$overlayArchiveRoot/current/base-current/keep.json" -in $overlayArchiveMembers) {
    throw "Synthetic overlay archive included its container or a protected descendant."
  }

  $originalOverlayPayload = [IO.File]::ReadAllBytes($overlayPayloadPath)
  [IO.File]::WriteAllText($overlayPayloadPath, ('{"actionId":"tampered"}' + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  $tamperedOverlayArchive = Join-Path $sandbox "bad-overlay-payload.tar.gz"
  & tar -czf $tamperedOverlayArchive -C $stage "archive_manifest.json" "export-ai-agent.previous" "export-ai-agent/private/history/legacy-spec" "export-ai-agent/private/production-research-specs-old.previous.fixture" "$overlayArchiveRoot/legacy.json" "$overlayArchiveRoot/manifest.json"
  if ($LASTEXITCODE -ne 0) { throw "Synthetic tampered overlay archive creation failed." }
  $tamperedOverlayHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $tamperedOverlayArchive).Hash.ToLowerInvariant()
  Assert-SyntheticArchiveRejected -Archive $tamperedOverlayArchive -ArchiveHash $tamperedOverlayHash -CandidateHash $overlayCandidateHash -CandidateCount 4 -Counts $overlayCounts -FailureMessage "Archive validation accepted tampered overlay payload bytes."
  [IO.File]::WriteAllBytes($overlayPayloadPath, $originalOverlayPayload)

  $extraProtectedArchive = Join-Path $sandbox "bad-overlay-protected-descendant.tar.gz"
  & tar -czf $extraProtectedArchive -C $stage "archive_manifest.json" "export-ai-agent.previous" "export-ai-agent/private/history/legacy-spec" "export-ai-agent/private/production-research-specs-old.previous.fixture" "$overlayArchiveRoot/legacy.json" "$overlayArchiveRoot/manifest.json" "$overlayArchiveRoot/current/base-current/keep.json"
  if ($LASTEXITCODE -ne 0) { throw "Synthetic protected-descendant archive creation failed." }
  $extraProtectedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $extraProtectedArchive).Hash.ToLowerInvariant()
  Assert-SyntheticArchiveRejected -Archive $extraProtectedArchive -ArchiveHash $extraProtectedHash -CandidateHash $overlayCandidateHash -CandidateCount 4 -Counts $overlayCounts -FailureMessage "Archive validation accepted a protected descendant inside an overlay."

  $badOverlayMember = [ordered]@{ relativePath = "../escape.json"; mode = $fixtureOverlayMode; size = 1; sha256 = ("7" * 64) }
  $badOverlayRow = "F|$($badOverlayMember.relativePath)|$($badOverlayMember.mode)|$($badOverlayMember.size)|$($badOverlayMember.sha256)"
  $badOverlayCandidate = [ordered]@{
    kind = "old_research_spec_overlay"
    archivePath = $overlayArchiveRoot
    treeSha256 = (Get-TextSha256 -Value $badOverlayRow)
    members = @($badOverlayMember)
  }
  $singleCounts = @{ candidate = 1; previous = 0; rollback = 0; oldSpec = 1; specBackup = 0 }
  $badOverlayCandidateHash = Write-ArchiveManifestFixture -Candidates @($badOverlayCandidate) -Counts $singleCounts
  $badOverlayMemberArchive = Join-Path $sandbox "bad-overlay-member-traversal.tar.gz"
  & tar -czf $badOverlayMemberArchive -C $stage "archive_manifest.json"
  $badOverlayMemberArchiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $badOverlayMemberArchive).Hash.ToLowerInvariant()
  Assert-SyntheticArchiveRejected -Archive $badOverlayMemberArchive -ArchiveHash $badOverlayMemberArchiveHash -CandidateHash $badOverlayCandidateHash -CandidateCount 1 -Counts $singleCounts -FailureMessage "Archive validation accepted an overlay member containing parent traversal."

  $null = Write-ArchiveManifestFixture -Candidates $overlayCandidates -Counts $overlayCounts
  $overlayLinkTarget = Join-Path $stage "overlay-link-target.json"
  [IO.File]::WriteAllBytes($overlayLinkTarget, $originalOverlayPayload)
  $symlinkCreated = $false
  try {
    Remove-Item -LiteralPath $overlayPayloadPath -Force
    New-Item -ItemType SymbolicLink -Path $overlayPayloadPath -Target $overlayLinkTarget -ErrorAction Stop | Out-Null
    $symlinkCreated = $true
    $symlinkOverlayArchive = Join-Path $sandbox "bad-overlay-symlink.tar.gz"
    & tar -czf $symlinkOverlayArchive -C $stage "archive_manifest.json" "export-ai-agent.previous" "export-ai-agent/private/history/legacy-spec" "export-ai-agent/private/production-research-specs-old.previous.fixture" "$overlayArchiveRoot/legacy.json" "$overlayArchiveRoot/manifest.json"
    if ($LASTEXITCODE -ne 0) { throw "Synthetic symlink overlay archive creation failed." }
    $symlinkOverlayHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $symlinkOverlayArchive).Hash.ToLowerInvariant()
    Assert-SyntheticArchiveRejected -Archive $symlinkOverlayArchive -ArchiveHash $symlinkOverlayHash -CandidateHash $overlayCandidateHash -CandidateCount 4 -Counts $overlayCounts -FailureMessage "Archive validation accepted a symlink overlay member."
  } catch {
    if ($symlinkCreated) { throw }
  } finally {
    if (Test-Path -LiteralPath $overlayPayloadPath) { Remove-Item -LiteralPath $overlayPayloadPath -Force }
    [IO.File]::WriteAllBytes($overlayPayloadPath, $originalOverlayPayload)
  }

  $commonHardlinkPath = Join-Path $stage "overlay-hardlink-source.json"
  [IO.File]::WriteAllText($commonHardlinkPath, ('{"same":"content"}' + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  $originalOverlayManifest = [IO.File]::ReadAllBytes($overlayManifestPath)
  Remove-Item -LiteralPath $overlayPayloadPath,$overlayManifestPath -Force
  New-Item -ItemType HardLink -Path $overlayPayloadPath -Target $commonHardlinkPath | Out-Null
  New-Item -ItemType HardLink -Path $overlayManifestPath -Target $commonHardlinkPath | Out-Null
  $hardlinkMembers = @(
    (New-OverlayArchiveMember -Path $overlayPayloadPath -RelativePath "legacy.json"),
    (New-OverlayArchiveMember -Path $overlayManifestPath -RelativePath "manifest.json")
  )
  $hardlinkRows = @($hardlinkMembers | ForEach-Object { "F|$($_.relativePath)|$($_.mode)|$($_.size)|$($_.sha256)" })
  $hardlinkCandidate = [ordered]@{
    kind = "old_research_spec_overlay"
    archivePath = $overlayArchiveRoot
    treeSha256 = (Get-TextSha256 -Value ($hardlinkRows -join ([string][char]10)))
    members = $hardlinkMembers
  }
  $hardlinkCandidateHash = Write-ArchiveManifestFixture -Candidates @($hardlinkCandidate) -Counts $singleCounts
  $hardlinkOverlayArchive = Join-Path $sandbox "bad-overlay-hardlink.tar.gz"
  & tar -czf $hardlinkOverlayArchive -C $stage "archive_manifest.json" "$overlayArchiveRoot/legacy.json" "$overlayArchiveRoot/manifest.json"
  if ($LASTEXITCODE -ne 0) { throw "Synthetic hardlink overlay archive creation failed." }
  $hardlinkOverlayHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $hardlinkOverlayArchive).Hash.ToLowerInvariant()
  Assert-SyntheticArchiveRejected -Archive $hardlinkOverlayArchive -ArchiveHash $hardlinkOverlayHash -CandidateHash $hardlinkCandidateHash -CandidateCount 1 -Counts $singleCounts -FailureMessage "Archive validation accepted a hardlink overlay member."
  Remove-Item -LiteralPath $overlayPayloadPath,$overlayManifestPath -Force
  [IO.File]::WriteAllBytes($overlayPayloadPath, $originalOverlayPayload)
  [IO.File]::WriteAllBytes($overlayManifestPath, $originalOverlayManifest)
  $candidateHash = Write-ArchiveManifestFixture -Candidates $candidates -Counts $goodCounts

  $currentRoot = Join-Path $stage "export-ai-agent"
  [IO.File]::WriteAllText((Join-Path $currentRoot ".env"), "FORBIDDEN_CURRENT=true`n", [Text.UTF8Encoding]::new($false))
  $badArchive = Join-Path $sandbox "bad-current-member.tar.gz"
  & tar -czf $badArchive -C $stage `
    "archive_manifest.json" `
    "export-ai-agent.previous" `
    "export-ai-agent/private/history/legacy-spec" `
    "export-ai-agent/private/production-research-specs-old.previous.fixture" `
    "export-ai-agent/.env"
  if ($LASTEXITCODE -ne 0) { throw "Synthetic forbidden archive creation failed." }
  $badArchiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $badArchive).Hash.ToLowerInvariant()
  $badAccepted = $false
  try {
    Test-DownloadedArchive -ArchivePath $badArchive -ExpectedArchiveHash $badArchiveHash `
      -ExpectedCandidateHash $candidateHash -ExpectedCandidateCount 3 -ExpectedCounts $goodCounts
    $badAccepted = $true
  } catch {
  }
  if ($badAccepted) { throw "Archive validation accepted a current application member." }

  $wrongHashAccepted = $false
  try {
    Test-DownloadedArchive -ArchivePath $goodArchive -ExpectedArchiveHash $goodArchiveHash `
      -ExpectedCandidateHash ("f" * 64) -ExpectedCandidateCount 3 -ExpectedCounts $goodCounts
    $wrongHashAccepted = $true
  } catch {
  }
  if ($wrongHashAccepted) { throw "Archive validation accepted a mismatched candidate hash." }

  $traversalCandidates = @(
    [ordered]@{ kind = "old_research_spec"; archivePath = "export-ai-agent/private/history/../base-current"; treeSha256 = ("d" * 64) }
  )
  $singleCounts = @{ candidate = 1; previous = 0; rollback = 0; oldSpec = 1; specBackup = 0 }
  $traversalHash = Write-ArchiveManifestFixture -Candidates $traversalCandidates -Counts $singleCounts
  $traversalArchive = Join-Path $sandbox "bad-traversal.tar.gz"
  & tar -czf $traversalArchive -C $stage "archive_manifest.json"
  $traversalArchiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $traversalArchive).Hash.ToLowerInvariant()
  $traversalAccepted = $false
  try {
    Test-DownloadedArchive -ArchivePath $traversalArchive -ExpectedArchiveHash $traversalArchiveHash `
      -ExpectedCandidateHash $traversalHash -ExpectedCandidateCount 1 -ExpectedCounts $singleCounts
    $traversalAccepted = $true
  } catch {
  }
  if ($traversalAccepted) { throw "Archive validation accepted a traversal candidate root." }

  $overlapCandidates = @(
    [ordered]@{ kind = "old_research_spec"; archivePath = "export-ai-agent/private/history"; treeSha256 = ("e" * 64) },
    [ordered]@{ kind = "old_research_spec"; archivePath = "export-ai-agent/private/history/legacy-spec"; treeSha256 = ("f" * 64) }
  )
  $overlapCounts = @{ candidate = 2; previous = 0; rollback = 0; oldSpec = 2; specBackup = 0 }
  $overlapHash = Write-ArchiveManifestFixture -Candidates $overlapCandidates -Counts $overlapCounts
  $overlapArchive = Join-Path $sandbox "bad-overlap.tar.gz"
  & tar -czf $overlapArchive -C $stage "archive_manifest.json"
  $overlapArchiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $overlapArchive).Hash.ToLowerInvariant()
  $overlapAccepted = $false
  try {
    Test-DownloadedArchive -ArchivePath $overlapArchive -ExpectedArchiveHash $overlapArchiveHash `
      -ExpectedCandidateHash $overlapHash -ExpectedCandidateCount 2 -ExpectedCounts $overlapCounts
    $overlapAccepted = $true
  } catch {
  }
  if ($overlapAccepted) { throw "Archive validation accepted overlapping candidate roots." }

  $protectedOverlapCandidates = @(
    [ordered]@{ kind = "old_research_spec"; archivePath = "export-ai-agent/private/legacy-container/current"; treeSha256 = ("0" * 64) }
  )
  $protectedOverlapHash = Write-ArchiveManifestFixture -Candidates $protectedOverlapCandidates -Counts $singleCounts
  $protectedOverlapArchive = Join-Path $sandbox "bad-protected-overlap.tar.gz"
  & tar -czf $protectedOverlapArchive -C $stage "archive_manifest.json"
  $protectedOverlapArchiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $protectedOverlapArchive).Hash.ToLowerInvariant()
  $protectedOverlapAccepted = $false
  try {
    Test-DownloadedArchive -ArchivePath $protectedOverlapArchive -ExpectedArchiveHash $protectedOverlapArchiveHash `
      -ExpectedCandidateHash $protectedOverlapHash -ExpectedCandidateCount 1 -ExpectedCounts $singleCounts
    $protectedOverlapAccepted = $true
  } catch {
  }
  if ($protectedOverlapAccepted) { throw "Archive validation accepted a candidate overlapping a protected root." }
} finally {
  if (Test-Path -LiteralPath $sandbox) {
    Remove-Item -LiteralPath $sandbox -Recurse -Force
  }
}

Write-Host "[OK] Archive-and-prune syntax, static safety, and synthetic archive validation tests passed."
