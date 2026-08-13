param(
  [string]$Workspace = "",
  [string]$EnvPath = "",
  [switch]$InventoryOnly,
  [switch]$ConfirmArchiveAndPrune,
  [switch]$ResumeExistingArchive,
  [string]$ResumeNonce = "",
  [string]$ResumeCandidateHash = "",
  [string]$ResumeArchiveHash = "",
  [switch]$ConfirmResumeExistingArchive
)

$ErrorActionPreference = "Stop"

function Stop-ArchivePrune {
  param([string]$Step, [int]$ExitCode)
  [Console]::Out.WriteLine("ARCHIVE_PRUNE_STATUS=FAIL")
  [Console]::Out.WriteLine("FAILED_STEP=$Step")
  [Console]::Out.WriteLine("FAILED_EXIT_CODE=$ExitCode")
  exit $ExitCode
}

function Resolve-ArchivePruneMode {
  param(
    [bool]$Inventory,
    [bool]$ConfirmArchive,
    [bool]$Resume,
    [string]$Nonce,
    [string]$CandidateHash,
    [string]$ArchiveHash,
    [bool]$ConfirmResume
  )

  $hasResumeInput = -not [string]::IsNullOrWhiteSpace($Nonce) -or
    -not [string]::IsNullOrWhiteSpace($CandidateHash) -or
    -not [string]::IsNullOrWhiteSpace($ArchiveHash) -or
    $ConfirmResume
  if ($Inventory -and ($ConfirmArchive -or $Resume -or $hasResumeInput)) {
    throw "AMBIGUOUS_MODE"
  }
  if ($Resume -and $ConfirmArchive) { throw "AMBIGUOUS_MODE" }
  if (-not $Resume -and $hasResumeInput) { throw "RESUME_PARAMETERS_WITHOUT_MODE" }

  if ($Inventory) {
    return [pscustomobject]@{ Mode = "INVENTORY"; Nonce = ""; CandidateHash = ""; ArchiveHash = "" }
  }
  if ($Resume) {
    if (-not $ConfirmResume) { throw "RESUME_CONFIRMATION_REQUIRED" }
    if ($Nonce -notmatch '^[A-Fa-f0-9]{32}$' -or
        $CandidateHash -notmatch '^[A-Fa-f0-9]{64}$' -or
        $ArchiveHash -notmatch '^[A-Fa-f0-9]{64}$') {
      throw "RESUME_INPUT_INVALID"
    }
    return [pscustomobject]@{
      Mode = "RESUME"
      Nonce = $Nonce.ToLowerInvariant()
      CandidateHash = $CandidateHash.ToLowerInvariant()
      ArchiveHash = $ArchiveHash.ToLowerInvariant()
    }
  }
  if (-not $ConfirmArchive) { throw "CONFIRMATION_REQUIRED" }
  return [pscustomobject]@{ Mode = "ARCHIVE"; Nonce = ""; CandidateHash = ""; ArchiveHash = "" }
}

function Get-PrivateEnvMap {
  param([string]$Path)
  $map = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line -split '=', 2
    $name = $parts[0].Trim()
    if (-not [string]::IsNullOrWhiteSpace($name)) {
      $map[$name] = $parts[1].Trim().Trim('"').Trim("'")
    }
  }
  return $map
}

function Get-SpecDirectoryFingerprint {
  param([string]$Path)
  $files = @(Get-ChildItem -LiteralPath $Path -File -Filter "*.json" | Sort-Object Name)
  if ($files.Count -ne 6) { throw "invalid spec directory" }
  $entries = foreach ($file in $files) {
    $fileHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
    "$($file.Name):$fileHash"
  }
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($entries -join "`n"))
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return (($algorithm.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $algorithm.Dispose()
  }
}

try {
  $Workspace = if ([string]::IsNullOrWhiteSpace($Workspace)) {
    (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
  } else {
    (Resolve-Path -LiteralPath $Workspace).Path
  }
  if ([string]::IsNullOrWhiteSpace($EnvPath)) { $EnvPath = Join-Path $Workspace ".env" }
} catch {
  Stop-ArchivePrune -Step "LOCAL_PATHS" -ExitCode 2
}

try {
  $modeState = Resolve-ArchivePruneMode `
    -Inventory ([bool]$InventoryOnly) `
    -ConfirmArchive ([bool]$ConfirmArchiveAndPrune) `
    -Resume ([bool]$ResumeExistingArchive) `
    -Nonce $ResumeNonce `
    -CandidateHash $ResumeCandidateHash `
    -ArchiveHash $ResumeArchiveHash `
    -ConfirmResume ([bool]$ConfirmResumeExistingArchive)
} catch {
  Stop-ArchivePrune -Step ([string]$_.Exception.Message) -ExitCode 2
}
if (-not (Test-Path -LiteralPath $EnvPath -PathType Leaf)) {
  Stop-ArchivePrune -Step "LOCAL_PRIVATE_CONFIG" -ExitCode 2
}

try {
  $envMap = Get-PrivateEnvMap -Path $EnvPath
  foreach ($name in @("VPS_IP", "VPS_SSH_USER", "VPS_SSH_KEY_PATH")) {
    if ([string]::IsNullOrWhiteSpace([string]$envMap[$name])) { throw "missing private setting" }
  }
  if (-not (Test-Path -LiteralPath $envMap.VPS_SSH_KEY_PATH -PathType Leaf)) {
    throw "missing key"
  }
  if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { throw "missing ssh" }
} catch {
  Stop-ArchivePrune -Step "LOCAL_SSH_KEY_REQUIRED" -ExitCode 2
}

try {
  $baseSpecFingerprint = Get-SpecDirectoryFingerprint `
    -Path (Join-Path $Workspace "config\production-research-specs-20260721")
  $expandedSpecFingerprint = Get-SpecDirectoryFingerprint `
    -Path (Join-Path $Workspace "config\production-research-specs-expanded-20260721")
} catch {
  Stop-ArchivePrune -Step "LOCAL_SPEC_DIRECTORIES" -ExitCode 2
}

$remoteScript = @'
set -euo pipefail
mode='__MODE__'
base_fingerprint='__BASE_FINGERPRINT__'
expanded_fingerprint='__EXPANDED_FINGERPRINT__'
expected_candidate_hash='__EXPECTED_CANDIDATE_HASH__'
expected_archive_hash='__EXPECTED_ARCHIVE_HASH__'
nonce='__NONCE__'
app_dir="$(readlink -m "$HOME/export-ai-agent")"
parent_dir="$(dirname "$app_dir")"
private_root="$app_dir/private"
deploy_lock="$app_dir.deploy.lock"
spec_lock="$private_root/.research-spec-upload.lock"
archive_path="/tmp/export-ai-agent-old-versions-$nonce.tar.gz"
working_dir="/tmp/export-ai-agent-old-versions-$nonce.work"
umask 077

case "$app_dir" in
  /|/root|/home|"$HOME") exit 20 ;;
esac
[[ -d "$app_dir" && ! -L "$app_dir" && -d "$private_root" && ! -L "$private_root" ]] || exit 21
command -v flock >/dev/null
command -v python3 >/dev/null
command -v sha256sum >/dev/null
command -v curl >/dev/null
command -v tar >/dev/null
[[ -f "$deploy_lock" && ! -L "$deploy_lock" ]] || exit 22
[[ -f "$spec_lock" && ! -L "$spec_lock" ]] || exit 23
case "$mode" in
  INVENTORY|VERIFY_ARCHIVE)
    exec 8<"$deploy_lock" || exit 25
    flock -s -w 15 8 || exit 25
    exec 9<"$spec_lock" || exit 26
    flock -s -w 15 9 || exit 26
    ;;
  ARCHIVE|PRUNE)
    exec 8<>"$deploy_lock" || exit 25
    flock -x -w 30 8 || exit 25
    exec 9<>"$spec_lock" || exit 26
    flock -x -w 30 9 || exit 26
    ;;
  *) exit 24 ;;
esac

check_health_and_pause() {
  systemctl is-active --quiet export-ai-agent-service.service || return 1
  curl -fsS --max-time 15 http://127.0.0.1:18790/health | python3 -c '
import json, sys
value = json.load(sys.stdin)
if value.get("ok") is not True or value.get("outboundPaused") is not True:
    raise SystemExit(1)
' || return 1
}

remove_working_dir() {
  [[ ! -e "$working_dir" && ! -L "$working_dir" ]] && return 0
  python3 - "$working_dir" <<'PY'
import pathlib, shutil, sys
path = pathlib.Path(sys.argv[1])
if path.is_symlink() or path.name.find("export-ai-agent-old-versions-") != 0 or not path.name.endswith(".work"):
    raise SystemExit(1)
shutil.rmtree(path)
PY
}

delete_exact_tree() {
  python3 - "$1" "$2" <<'PY'
import os
import pathlib
import re
import stat
import sys

anchor = pathlib.Path(sys.argv[1])
relative = pathlib.PurePosixPath(sys.argv[2])
if (
    relative.is_absolute()
    or not relative.parts
    or any(part in {"", ".", ".."} or not re.fullmatch(r"[A-Za-z0-9._-]+", part) for part in relative.parts)
):
    raise SystemExit(1)

anchor_fd = os.open(anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
anchor_info = os.fstat(anchor_fd)
parent_fds = [anchor_fd]
root_fd = None
try:
    for segment in relative.parts[:-1]:
        parent_fd = parent_fds[-1]
        segment_info = os.stat(segment, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(segment_info.st_mode) or segment_info.st_dev != anchor_info.st_dev:
            raise RuntimeError("unsafe candidate ancestor")
        segment_fd = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        opened = os.fstat(segment_fd)
        if (opened.st_dev, opened.st_ino) != (segment_info.st_dev, segment_info.st_ino):
            os.close(segment_fd)
            raise RuntimeError("candidate ancestor changed while opening")
        parent_fds.append(segment_fd)
    parent_fd = parent_fds[-1]
    root_name = relative.parts[-1]
    root_info = os.stat(root_name, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(root_info.st_mode) or root_info.st_dev != anchor_info.st_dev:
        raise SystemExit(1)
    root_fd = os.open(root_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    opened = os.fstat(root_fd)
    if (opened.st_dev, opened.st_ino) != (root_info.st_dev, root_info.st_ino):
        raise RuntimeError("candidate changed while opening")
    device = root_info.st_dev

    def remove_contents(directory_fd):
        for name in sorted(os.listdir(directory_fd)):
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if info.st_dev != device:
                raise RuntimeError("filesystem boundary changed before deletion")
            if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
                try:
                    opened = os.fstat(child_fd)
                    if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                        raise RuntimeError("directory changed while opening")
                    remove_contents(child_fd)
                finally:
                    os.close(child_fd)
                os.rmdir(name, dir_fd=directory_fd)
            else:
                os.unlink(name, dir_fd=directory_fd)

    remove_contents(root_fd)
    os.close(root_fd)
    root_fd = None
    current = os.stat(root_name, dir_fd=parent_fd, follow_symlinks=False)
    if (current.st_dev, current.st_ino) != (root_info.st_dev, root_info.st_ino):
        raise RuntimeError("candidate root changed before removal")
    os.rmdir(root_name, dir_fd=parent_fd)
finally:
    if root_fd is not None:
        os.close(root_fd)
    for descriptor in reversed(parent_fds):
        os.close(descriptor)
PY
}

delete_exact_overlay_files() {
  python3 - "$1" "$2" "$3" "$4" "$5" "$6" "$7" <<'PY'
import base64
import hashlib
import json
import os
import pathlib
import re
import stat
import sys

anchor = pathlib.Path(sys.argv[1])
relative = pathlib.PurePosixPath(sys.argv[2])
expected_archive_path = sys.argv[3]
expected_tree_hash = sys.argv[4]
encoded = sys.argv[5]
operation = sys.argv[6]
expected_root_identity = sys.argv[7]
if (
    relative.is_absolute()
    or not relative.parts
    or any(part in {"", ".", ".."} or not re.fullmatch(r"[A-Za-z0-9._-]+", part) for part in relative.parts)
):
    raise RuntimeError("unsafe overlay root path")
try:
    candidate = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("utf-8"))
except (ValueError, UnicodeError, json.JSONDecodeError) as error:
    raise RuntimeError("invalid overlay deletion plan") from error
if (
    not isinstance(candidate, dict)
    or set(candidate) != {"kind", "archivePath", "treeSha256", "members"}
    or candidate.get("kind") != "old_research_spec_overlay"
    or candidate.get("archivePath") != expected_archive_path
    or candidate.get("treeSha256") != expected_tree_hash
    or not expected_archive_path.endswith(f"/private/{relative.as_posix()}")
):
    raise RuntimeError("invalid overlay deletion kind")
expected_set_hash = candidate.get("treeSha256")
members = candidate.get("members")
if not isinstance(expected_set_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_set_hash):
    raise RuntimeError("invalid overlay deletion hash")
if not isinstance(members, list) or not members:
    raise RuntimeError("invalid overlay deletion members")

expected = []
rows = []
seen = set()
for item in members:
    if not isinstance(item, dict) or set(item) != {"relativePath", "mode", "size", "sha256"}:
        raise RuntimeError("invalid overlay member metadata")
    name = item["relativePath"]
    mode = item["mode"]
    size = item["size"]
    digest = item["sha256"]
    if (
        not isinstance(name, str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.json", name)
        or name in seen
        or not isinstance(mode, str)
        or not re.fullmatch(r"[0-7]{3,4}", mode)
        or not isinstance(size, int)
        or isinstance(size, bool)
        or size < 0
        or not isinstance(digest, str)
        or not re.fullmatch(r"[a-f0-9]{64}", digest)
    ):
        raise RuntimeError("unsafe overlay member metadata")
    seen.add(name)
    expected.append((name, mode, size, digest))
    rows.append(f"F|{name}|{mode}|{size}|{digest}")
if expected != sorted(expected, key=lambda item: item[0]):
    raise RuntimeError("overlay members are not canonical")
if hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest() != expected_set_hash:
    raise RuntimeError("overlay member-set hash mismatch")

anchor_fd = os.open(anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
anchor_info = os.fstat(anchor_fd)
parent_fds = [anchor_fd]
root_fd = None
opened_files = []
try:
    for segment in relative.parts[:-1]:
        parent_fd = parent_fds[-1]
        segment_info = os.stat(segment, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(segment_info.st_mode) or segment_info.st_dev != anchor_info.st_dev:
            raise RuntimeError("unsafe overlay ancestor")
        segment_fd = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        opened_segment = os.fstat(segment_fd)
        if (opened_segment.st_dev, opened_segment.st_ino) != (segment_info.st_dev, segment_info.st_ino):
            os.close(segment_fd)
            raise RuntimeError("overlay ancestor changed while opening")
        parent_fds.append(segment_fd)
    parent_fd = parent_fds[-1]
    root_name = relative.parts[-1]
    root_info = os.stat(root_name, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(root_info.st_mode) or root_info.st_dev != anchor_info.st_dev:
        raise RuntimeError("unsafe overlay root")
    root_fd = os.open(root_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    opened_root = os.fstat(root_fd)
    if (opened_root.st_dev, opened_root.st_ino) != (root_info.st_dev, root_info.st_ino):
        raise RuntimeError("overlay root changed while opening")
    root_identity = f"{root_info.st_dev}:{root_info.st_ino}"
    if operation == "ABSENT":
        if expected_root_identity != root_identity:
            raise RuntimeError("overlay root identity changed after deletion")
        for name, _, _, _ in expected:
            try:
                os.stat(name, dir_fd=root_fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise RuntimeError("overlay member reappeared after unlink")
        raise SystemExit(0)
    if operation != "DELETE" or expected_root_identity:
        raise RuntimeError("invalid overlay file operation")
    for name, mode, size, expected_digest in expected:
        info = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_dev != root_info.st_dev
            or info.st_nlink != 1
            or f"{stat.S_IMODE(info.st_mode):o}" != mode
            or info.st_size != size
        ):
            raise RuntimeError("overlay member metadata changed")
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root_fd)
        opened = os.fstat(descriptor)
        if (
            (opened.st_dev, opened.st_ino, opened.st_nlink, opened.st_size, stat.S_IMODE(opened.st_mode))
            != (info.st_dev, info.st_ino, 1, size, int(mode, 8))
        ):
            os.close(descriptor)
            raise RuntimeError("overlay member changed while opening")
        digest = hashlib.sha256()
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            digest.update(block)
        after = os.fstat(descriptor)
        if (
            (after.st_dev, after.st_ino, after.st_nlink, after.st_size, stat.S_IMODE(after.st_mode))
            != (opened.st_dev, opened.st_ino, 1, size, int(mode, 8))
            or digest.hexdigest() != expected_digest
        ):
            os.close(descriptor)
            raise RuntimeError("overlay member content changed")
        opened_files.append((name, descriptor, opened))

    for name, descriptor, opened in opened_files:
        current = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        if (
            (current.st_dev, current.st_ino, current.st_nlink, current.st_size, stat.S_IMODE(current.st_mode))
            != (opened.st_dev, opened.st_ino, 1, opened.st_size, stat.S_IMODE(opened.st_mode))
        ):
            raise RuntimeError("overlay member changed before unlink")
        os.unlink(name, dir_fd=root_fd)
        unlinked = os.fstat(descriptor)
        if (
            (unlinked.st_dev, unlinked.st_ino, unlinked.st_nlink, unlinked.st_size, stat.S_IMODE(unlinked.st_mode))
            != (opened.st_dev, opened.st_ino, 0, opened.st_size, stat.S_IMODE(opened.st_mode))
        ):
            raise RuntimeError("overlay member unlink identity mismatch")
        try:
            os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        except FileNotFoundError:
            continue
        raise RuntimeError("overlay member remains after unlink")
    current_root = os.stat(root_name, dir_fd=parent_fd, follow_symlinks=False)
    if (current_root.st_dev, current_root.st_ino) != (root_info.st_dev, root_info.st_ino):
        raise RuntimeError("overlay root changed after unlink")
    print(root_identity)
finally:
    for _, descriptor, _ in opened_files:
        os.close(descriptor)
    if root_fd is not None:
        os.close(root_fd)
    for descriptor in reversed(parent_fds):
        os.close(descriptor)
PY
}

verify_tree_hash() {
  python3 - "$1" "$2" <<'PY'
import hashlib
import os
import pathlib
import stat
import sys

root = pathlib.Path(sys.argv[1])
expected = sys.argv[2]
root_stat = root.lstat()
if root.is_symlink() or not stat.S_ISDIR(root_stat.st_mode):
    raise SystemExit(1)
device = root_stat.st_dev
rows = [f"D|.|{stat.S_IMODE(root_stat.st_mode):o}"]
for current, directories, files in os.walk(root, topdown=True, followlinks=False):
    directories.sort()
    files.sort()
    current_path = pathlib.Path(current)
    for name in list(directories):
        path = current_path / name
        info = path.lstat()
        if info.st_dev != device:
            raise SystemExit(1)
        relative = path.relative_to(root).as_posix()
        if stat.S_ISLNK(info.st_mode):
            rows.append(f"L|{relative}|{os.readlink(path)}")
            directories.remove(name)
        elif stat.S_ISDIR(info.st_mode):
            rows.append(f"D|{relative}|{stat.S_IMODE(info.st_mode):o}")
        else:
            raise SystemExit(1)
    for name in files:
        path = current_path / name
        info = path.lstat()
        if info.st_dev != device:
            raise SystemExit(1)
        relative = path.relative_to(root).as_posix()
        if stat.S_ISREG(info.st_mode):
            digest = hashlib.sha256()
            with path.open("rb") as handle:
                for block in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(block)
            rows.append(f"F|{relative}|{stat.S_IMODE(info.st_mode):o}|{info.st_size}|{digest.hexdigest()}")
        elif stat.S_ISLNK(info.st_mode):
            rows.append(f"L|{relative}|{os.readlink(path)}")
        else:
            raise SystemExit(1)
actual = hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()
raise SystemExit(0 if actual == expected else 1)
PY
}

verify_archive_members() {
  python3 - "$1" "$2" <<'PY'
import hashlib
import json
import pathlib
import re
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
expected_hash = sys.argv[2]
with tarfile.open(archive, "r:gz") as package:
    members = package.getmembers()
    manifests = [member for member in members if member.name == "archive_manifest.json"]
    if len(manifests) != 1 or not manifests[0].isreg() or manifests[0].issym() or manifests[0].islnk():
        raise SystemExit(1)
    handle = package.extractfile(manifests[0])
    if handle is None:
        raise SystemExit(1)
    manifest = json.loads(handle.read().decode("utf-8"))
    if manifest.get("schemaVersion") != "server-old-version-archive-manifest-v1":
        raise SystemExit(1)
    if manifest.get("candidateListSha256") != expected_hash:
        raise SystemExit(1)
    candidates = manifest.get("candidates", [])
    if not isinstance(candidates, list):
        raise SystemExit(1)
    roots = []
    root_kinds = {}
    allowed_kinds = {
        "previous_release",
        "rollback_state",
        "old_research_spec",
        "old_research_spec_overlay",
        "research_spec_backup",
    }
    app_prefix = "export-ai-agent/private/"
    overlay_members = {}

    def safe_relative_root(value, prefix):
        if not isinstance(value, str):
            return False
        value = value.rstrip("/")
        pure = pathlib.PurePosixPath(value)
        if (
            not value
            or pure.is_absolute()
            or ".." in pure.parts
            or "." in pure.parts
            or "\\" in value
            or not value.startswith(prefix)
            or value == prefix.rstrip("/")
        ):
            return None
        relative = value[len(prefix):]
        return all(
            part
            and all(character.isascii() and (character.isalnum() or character in "._-") for character in part)
            for part in relative.split("/")
        )

    def parse_overlay(candidate):
        if set(candidate) != {"kind", "archivePath", "treeSha256", "members"}:
            raise SystemExit(1)
        values = candidate.get("members")
        if not isinstance(values, list) or not values:
            raise SystemExit(1)
        parsed = []
        rows = []
        seen = set()
        for value in values:
            if not isinstance(value, dict) or set(value) != {"relativePath", "mode", "size", "sha256"}:
                raise SystemExit(1)
            name = value.get("relativePath")
            mode = value.get("mode")
            size = value.get("size")
            digest = value.get("sha256")
            if (
                not isinstance(name, str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.json", name)
                or name in seen
                or not isinstance(mode, str)
                or not re.fullmatch(r"[0-7]{3,4}", mode)
                or not isinstance(size, int)
                or isinstance(size, bool)
                or size < 0
                or not isinstance(digest, str)
                or not re.fullmatch(r"[a-f0-9]{64}", digest)
            ):
                raise SystemExit(1)
            seen.add(name)
            parsed.append((name, mode, size, digest))
            rows.append(f"F|{name}|{mode}|{size}|{digest}")
        if parsed != sorted(parsed, key=lambda item: item[0]):
            raise SystemExit(1)
        if hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest() != candidate.get("treeSha256"):
            raise SystemExit(1)
        return parsed

    for item in candidates:
        if not isinstance(item, dict) or item.get("kind") not in allowed_kinds:
            raise SystemExit(1)
        kind = item["kind"]
        root = item.get("archivePath")
        tree_hash = item.get("treeSha256")
        if not isinstance(root, str) or not isinstance(tree_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", tree_hash):
            raise SystemExit(1)
        root = root.rstrip("/")
        if root != item.get("archivePath"):
            raise SystemExit(1)
        if kind == "previous_release":
            valid = root == "export-ai-agent.previous"
        elif kind == "rollback_state":
            valid = root == "export-ai-agent.rollback-state"
        else:
            valid = safe_relative_root(root, app_prefix)
        if not valid or root in root_kinds:
            raise SystemExit(1)
        if kind == "old_research_spec_overlay":
            overlay_members[root] = parse_overlay(item)
        elif set(item) != {"kind", "archivePath", "treeSha256"}:
            raise SystemExit(1)
        roots.append(root)
        root_kinds[root] = kind

    def overlaps(left, right):
        return left == right or left.startswith(right + "/") or right.startswith(left + "/")

    for index, left in enumerate(roots):
        for right in roots[index + 1:]:
            if not overlaps(left, right):
                continue
            allowed_overlay_relation = (
                root_kinds[left] == "old_research_spec_overlay" and right.startswith(left + "/")
            ) or (
                root_kinds[right] == "old_research_spec_overlay" and left.startswith(right + "/")
            )
            if not allowed_overlay_relation:
                raise SystemExit(1)
    protected_value = manifest.get("protected", {})
    protected = [
        protected_value.get("baseArchivePath"),
        protected_value.get("expandedArchivePath"),
    ]
    if (
        len(set(protected)) != 2
        or any(not safe_relative_root(value, app_prefix) for value in protected)
        or overlaps(protected[0], protected[1])
    ):
        raise SystemExit(1)
    protected_fingerprints = [
        protected_value.get("baseFingerprint"),
        protected_value.get("expandedFingerprint"),
    ]
    if any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value) for value in protected_fingerprints):
        raise SystemExit(1)
    for root in roots:
        for value in protected:
            if not overlaps(root, value):
                continue
            if root_kinds[root] != "old_research_spec_overlay" or not value.startswith(root + "/"):
                raise SystemExit(1)

    identity_rows = [f'{item["kind"]}|{item["archivePath"]}|{item["treeSha256"]}' for item in candidates]
    identity_rows.extend((
        f"protected_base|{protected[0]}|{protected_fingerprints[0]}",
        f"protected_expanded|{protected[1]}|{protected_fingerprints[1]}",
    ))
    actual_candidate_hash = hashlib.sha256("\n".join(sorted(identity_rows)).encode("utf-8")).hexdigest()
    if actual_candidate_hash != expected_hash or manifest.get("candidateListSha256") != actual_candidate_hash:
        raise SystemExit(1)

    counts = manifest.get("counts")
    actual_counts = {
        "candidate": len(candidates),
        "previous": sum(root_kinds[root] == "previous_release" for root in roots),
        "rollback": sum(root_kinds[root] == "rollback_state" for root in roots),
        "oldSpec": sum(root_kinds[root] in {"old_research_spec", "old_research_spec_overlay"} for root in roots),
        "specBackup": sum(root_kinds[root] == "research_spec_backup" for root in roots),
    }
    if counts != actual_counts:
        raise SystemExit(1)

    expected_overlay_paths = {
        f"{root}/{name}": (root, mode, size, digest)
        for root, values in overlay_members.items()
        for name, mode, size, digest in values
    }
    full_tree_roots = [root for root in roots if root_kinds[root] != "old_research_spec_overlay"]
    seen_roots = set()
    seen_names = set()
    seen_overlay_paths = set()
    for member in members:
        name = member.name.rstrip("/")
        pure = pathlib.PurePosixPath(name)
        if not name or pure.is_absolute() or ".." in pure.parts or "." in pure.parts or "\\" in name or name in seen_names:
            raise SystemExit(1)
        seen_names.add(name)
        if name == "archive_manifest.json":
            continue
        if name in expected_overlay_paths:
            root, expected_mode, expected_size, expected_digest = expected_overlay_paths[name]
            if not member.isreg() or member.issym() or member.islnk():
                raise SystemExit(1)
            if f"{member.mode:o}" != expected_mode or member.size != expected_size:
                raise SystemExit(1)
            payload = package.extractfile(member)
            if payload is None:
                raise SystemExit(1)
            digest = hashlib.sha256()
            for block in iter(lambda: payload.read(1024 * 1024), bytes()):
                digest.update(block)
            if digest.hexdigest() != expected_digest:
                raise SystemExit(1)
            seen_roots.add(root)
            seen_overlay_paths.add(name)
            continue
        matching = [root for root in full_tree_roots if name == root or name.startswith(root + "/")]
        if len(matching) != 1:
            raise SystemExit(1)
        seen_roots.add(matching[0])
        if name.startswith("export-ai-agent/") and root_kinds[matching[0]] not in {
            "old_research_spec",
            "research_spec_backup",
        }:
            raise SystemExit(1)
    if seen_roots != set(roots) or seen_overlay_paths != set(expected_overlay_paths):
        raise SystemExit(1)
PY
}

collect_inventory() {
python3 - "$app_dir" "$base_fingerprint" "$expanded_fingerprint" <<'PY'
import hashlib
import json
import os
import pathlib
import re
import stat
import sys

app = pathlib.Path(sys.argv[1])
base_expected = sys.argv[2]
expanded_expected = sys.argv[3]
parent = app.parent
private = app / "private"
app_name = app.name

def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

def spec_fingerprint(path):
    if not path.is_dir() or path.is_symlink():
        raise RuntimeError("invalid current spec directory")
    files = sorted((item for item in path.iterdir() if item.suffix == ".json"), key=lambda item: item.name)
    if len(files) != 6 or any(item.is_symlink() or not item.is_file() for item in files):
        raise RuntimeError("invalid six-json spec directory")
    rows = [f"{item.name}:{private_file_sha256(item)}" for item in files]
    return hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()

def tree_fingerprint(root):
    root_stat = root.lstat()
    if not stat.S_ISDIR(root_stat.st_mode) or root.is_symlink():
        raise RuntimeError("candidate root is not a real directory")
    device = root_stat.st_dev
    rows = [f"D|.|{stat.S_IMODE(root_stat.st_mode):o}"]
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        directories.sort()
        files.sort()
        current_path = pathlib.Path(current)
        for name in list(directories):
            path = current_path / name
            info = path.lstat()
            if info.st_dev != device:
                raise RuntimeError("candidate crosses a filesystem boundary")
            relative = path.relative_to(root).as_posix()
            if stat.S_ISLNK(info.st_mode):
                rows.append(f"L|{relative}|{os.readlink(path)}")
                directories.remove(name)
            elif stat.S_ISDIR(info.st_mode):
                rows.append(f"D|{relative}|{stat.S_IMODE(info.st_mode):o}")
            else:
                raise RuntimeError("unsupported directory entry")
        for name in files:
            path = current_path / name
            info = path.lstat()
            if info.st_dev != device:
                raise RuntimeError("candidate crosses a filesystem boundary")
            relative = path.relative_to(root).as_posix()
            if stat.S_ISREG(info.st_mode):
                rows.append(f"F|{relative}|{stat.S_IMODE(info.st_mode):o}|{info.st_size}|{file_sha256(path)}")
            elif stat.S_ISLNK(info.st_mode):
                rows.append(f"L|{relative}|{os.readlink(path)}")
            else:
                raise RuntimeError("unsupported special file")
    return hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()

safe_segment = re.compile(r"^[A-Za-z0-9._-]+$")
private_stat = private.lstat()
if private.is_symlink() or not stat.S_ISDIR(private_stat.st_mode):
    raise RuntimeError("unsafe private root")
private_device = private_stat.st_dev

def safe_private_relative(path):
    try:
        relative = path.relative_to(private)
    except ValueError as error:
        raise RuntimeError("research-spec path escapes private root") from error
    if (
        not relative.parts
        or any(part in {"", ".", ".."} or not safe_segment.fullmatch(part) for part in relative.parts)
    ):
        raise RuntimeError("unsafe research-spec relative path")
    return relative

def read_private_regular_bytes(path, maximum_size=None):
    relative = safe_private_relative(path)
    if os.name != "posix":
        info = path.lstat()
        if (
            path.is_symlink()
            or not stat.S_ISREG(info.st_mode)
            or info.st_dev != private_device
            or info.st_nlink != 1
            or (maximum_size is not None and info.st_size > maximum_size)
        ):
            raise RuntimeError("unsafe private regular file")
        payload = path.read_bytes()
        current = path.lstat()
        if (
            (current.st_dev, current.st_ino, current.st_size, current.st_nlink)
            != (info.st_dev, info.st_ino, info.st_size, info.st_nlink)
        ):
            raise RuntimeError("private file changed while reading")
        return payload, current
    if (
        not hasattr(os, "O_DIRECTORY")
        or not hasattr(os, "O_NOFOLLOW")
        or os.open not in os.supports_dir_fd
        or os.stat not in os.supports_dir_fd
    ):
        raise RuntimeError("secure private file APIs are unavailable")
    parent_fds = []
    anchor_fd = os.open(private, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    parent_fds.append(anchor_fd)
    try:
        opened_private = os.fstat(anchor_fd)
        if (opened_private.st_dev, opened_private.st_ino) != (private_stat.st_dev, private_stat.st_ino):
            raise RuntimeError("private root changed while opening")
        for segment in relative.parts[:-1]:
            parent_fd = parent_fds[-1]
            segment_info = os.stat(segment, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISDIR(segment_info.st_mode) or segment_info.st_dev != private_device:
                raise RuntimeError("unsafe private file ancestor")
            segment_fd = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
            opened = os.fstat(segment_fd)
            if (opened.st_dev, opened.st_ino) != (segment_info.st_dev, segment_info.st_ino):
                os.close(segment_fd)
                raise RuntimeError("private file ancestor changed while opening")
            parent_fds.append(segment_fd)
        parent_fd = parent_fds[-1]
        name = relative.parts[-1]
        info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_dev != private_device
            or info.st_nlink != 1
            or (maximum_size is not None and info.st_size > maximum_size)
        ):
            raise RuntimeError("unsafe private regular file")
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            opened = os.fstat(descriptor)
            if (
                (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino)
                or opened.st_nlink != 1
                or opened.st_size != info.st_size
            ):
                raise RuntimeError("private file changed while opening")
            blocks = []
            while True:
                block = os.read(descriptor, 1024 * 1024)
                if not block:
                    break
                blocks.append(block)
            after = os.fstat(descriptor)
            current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if (
                (after.st_dev, after.st_ino, after.st_size, after.st_nlink)
                != (opened.st_dev, opened.st_ino, opened.st_size, opened.st_nlink)
                or (current.st_dev, current.st_ino, current.st_size, current.st_nlink)
                != (opened.st_dev, opened.st_ino, opened.st_size, opened.st_nlink)
            ):
                raise RuntimeError("private file changed while reading")
            return b"".join(blocks), opened
        finally:
            os.close(descriptor)
    finally:
        for descriptor in reversed(parent_fds):
            os.close(descriptor)

def private_file_sha256(path):
    payload, _ = read_private_regular_bytes(path)
    return hashlib.sha256(payload).hexdigest()

def is_backup_path(relative):
    return any(".previous." in part for part in relative.parts)

def is_research_spec_manifest(path, value):
    if not isinstance(value, dict):
        return None
    if value.get("schemaVersion") == "production-research-spec-manifest-v1":
        return {"type": "tree", "members": []}
    schema = value.get("schemaVersion")
    if schema != "production-acquisition-spec-manifest-v1":
        return None
    campaigns = value.get("campaigns")
    target_total = value.get("targetTotal")
    if (
        not isinstance(campaigns, list)
        or not campaigns
        or not isinstance(target_total, int)
        or isinstance(target_total, bool)
        or target_total <= 0
    ):
        raise RuntimeError("invalid legacy acquisition manifest")
    file_pattern = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.json$")
    references = []
    target_sum = 0
    for campaign in campaigns:
        if not isinstance(campaign, dict):
            raise RuntimeError("invalid legacy acquisition campaign")
        filename = campaign.get("file")
        market = campaign.get("market")
        target_count = campaign.get("targetCount")
        if (
            not isinstance(filename, str)
            or not file_pattern.fullmatch(filename)
            or filename == "manifest.json"
            or not isinstance(market, str)
            or not market.strip()
            or not isinstance(target_count, int)
            or isinstance(target_count, bool)
            or target_count <= 0
        ):
            raise RuntimeError("invalid legacy acquisition campaign")
        references.append(filename)
        target_sum += target_count
    if len(set(references)) != len(references) or target_sum != target_total:
        raise RuntimeError("invalid legacy acquisition totals")
    for filename in references:
        try:
            payload_bytes, _ = read_private_regular_bytes(path / filename, 16 * 1024 * 1024)
            payload = json.loads(payload_bytes.decode("utf-8-sig"))
        except (OSError, RuntimeError, UnicodeError, json.JSONDecodeError) as error:
            raise RuntimeError("invalid legacy acquisition payload") from error
        if (
            not isinstance(payload, dict)
            or not isinstance(payload.get("actionId"), str)
            or not payload["actionId"].strip()
            or not isinstance(payload.get("campaign"), dict)
            or not isinstance(payload.get("brief"), dict)
        ):
            raise RuntimeError("invalid legacy acquisition payload")
    return {"type": "overlay", "members": ["manifest.json", *references]}

spec_directories = []
for current, directories, files in os.walk(private, topdown=True, followlinks=False):
    current_path = pathlib.Path(current)
    current_info = current_path.lstat()
    if current_path.is_symlink() or not stat.S_ISDIR(current_info.st_mode) or current_info.st_dev != private_device:
        raise RuntimeError("unsafe research-spec traversal root")
    if current_path != private:
        safe_private_relative(current_path)
    directories.sort()
    for name in directories:
        path = current_path / name
        info = path.lstat()
        if path.is_symlink() or not stat.S_ISDIR(info.st_mode) or info.st_dev != private_device:
            raise RuntimeError("unsafe research-spec traversal path")
        safe_private_relative(path)
    if "manifest.json" not in files:
        continue
    manifest_path = current_path / "manifest.json"
    try:
        manifest_bytes, _ = read_private_regular_bytes(manifest_path, 1024 * 1024)
        manifest_value = json.loads(manifest_bytes.decode("utf-8-sig"))
    except (OSError, RuntimeError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError("invalid private manifest") from error
    classification = is_research_spec_manifest(current_path, manifest_value)
    if classification is None:
        continue
    spec_directories.append((current_path, safe_private_relative(current_path), classification))

def paths_overlap(left, right):
    try:
        right.relative_to(left)
        return True
    except ValueError:
        pass
    try:
        left.relative_to(right)
        return True
    except ValueError:
        return False

for index, (left, _, left_classification) in enumerate(spec_directories):
    for right, _, right_classification in spec_directories[index + 1:]:
        if not paths_overlap(left, right):
            continue
        left_overlay = left_classification["type"] == "overlay"
        right_overlay = right_classification["type"] == "overlay"
        if left_overlay == right_overlay:
            raise RuntimeError("overlapping research-spec roots")
        overlay = left if left_overlay else right
        descendant = right if left_overlay else left
        if overlay not in descendant.parents:
            raise RuntimeError("unsafe research-spec overlay relation")

active_spec_dirs = []
for path, relative, classification in spec_directories:
    if is_backup_path(relative):
        continue
    try:
        active_spec_dirs.append((path, relative, spec_fingerprint(path)))
    except RuntimeError:
        continue
base_matches = [(path, relative) for path, relative, fingerprint in active_spec_dirs if fingerprint == base_expected]
expanded_matches = [(path, relative) for path, relative, fingerprint in active_spec_dirs if fingerprint == expanded_expected]
if len(base_matches) != 1 or len(expanded_matches) != 1 or base_matches[0] == expanded_matches[0]:
    raise RuntimeError("current spec fingerprints are not uniquely present")
base_current, base_relative = base_matches[0]
expanded_current, expanded_relative = expanded_matches[0]

candidates = []
for kind, path, archive_path in (
    ("previous_release", pathlib.Path(str(app) + ".previous"), f"{app_name}.previous"),
    ("rollback_state", pathlib.Path(str(app) + ".rollback-state"), f"{app_name}.rollback-state"),
):
    if path.exists() or path.is_symlink():
        if path.is_symlink() or not path.is_dir() or path.parent.resolve() != parent.resolve():
            raise RuntimeError("unsafe exact top-level candidate")
        candidates.append({
            "kind": kind,
            "archivePath": archive_path,
            "treeSha256": tree_fingerprint(path),
        })

def overlay_fingerprint(path, filenames):
    members = []
    rows = []
    for filename in sorted(filenames):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.json", filename):
            raise RuntimeError("unsafe overlay member name")
        member_path = path / filename
        payload, info = read_private_regular_bytes(member_path, 16 * 1024 * 1024)
        digest = hashlib.sha256(payload).hexdigest()
        mode = f"{stat.S_IMODE(info.st_mode):o}"
        members.append({
            "relativePath": filename,
            "mode": mode,
            "size": info.st_size,
            "sha256": digest,
        })
        rows.append(f"F|{filename}|{mode}|{info.st_size}|{digest}")
    if not members or members[-1]["relativePath"] == "":
        raise RuntimeError("empty overlay member set")
    return members, hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()

protected_paths = {base_current, expanded_current}
for path, relative, classification in spec_directories:
    if path in protected_paths:
        continue
    is_backup = is_backup_path(relative)
    archive_path = f"{app_name}/private/{relative.as_posix()}"
    if classification["type"] == "overlay":
        if is_backup:
            raise RuntimeError("legacy overlay cannot be a backup path")
        members, member_set_hash = overlay_fingerprint(path, classification["members"])
        candidates.append({
            "kind": "old_research_spec_overlay",
            "archivePath": archive_path,
            "treeSha256": member_set_hash,
            "members": members,
        })
    else:
        candidates.append({
            "kind": "research_spec_backup" if is_backup else "old_research_spec",
            "archivePath": archive_path,
            "treeSha256": tree_fingerprint(path),
        })

candidates.sort(key=lambda item: (item["kind"], item["archivePath"]))
protected = {
    "baseArchivePath": f"{app_name}/private/{base_relative.as_posix()}",
    "baseFingerprint": base_expected,
    "expandedArchivePath": f"{app_name}/private/{expanded_relative.as_posix()}",
    "expandedFingerprint": expanded_expected,
}
identity_rows = [f'{item["kind"]}|{item["archivePath"]}|{item["treeSha256"]}' for item in candidates]
identity_rows.extend((
    f'protected_base|{protected["baseArchivePath"]}|{protected["baseFingerprint"]}',
    f'protected_expanded|{protected["expandedArchivePath"]}|{protected["expandedFingerprint"]}',
))
candidate_hash = hashlib.sha256("\n".join(sorted(identity_rows)).encode("utf-8")).hexdigest()
counts = {
    "candidate": len(candidates),
    "previous": sum(item["kind"] == "previous_release" for item in candidates),
    "rollback": sum(item["kind"] == "rollback_state" for item in candidates),
    "oldSpec": sum(item["kind"] in {"old_research_spec", "old_research_spec_overlay"} for item in candidates),
    "specBackup": sum(item["kind"] == "research_spec_backup" for item in candidates),
}
print(json.dumps({
    "schemaVersion": "server-old-version-inventory-v1",
    "candidateListSha256": candidate_hash,
    "counts": counts,
    "candidates": candidates,
    "protected": protected,
}, separators=(",", ":"), sort_keys=True))
PY
}

emit_inventory() {
python3 - "$1" <<'PY'
import json
import sys
value = json.loads(sys.argv[1])
counts = value["counts"]
print(f"CANDIDATE_COUNT={counts['candidate']}")
print(f"PREVIOUS_RELEASE_COUNT={counts['previous']}")
print(f"ROLLBACK_STATE_COUNT={counts['rollback']}")
print(f"OLD_RESEARCH_SPEC_COUNT={counts['oldSpec']}")
print(f"RESEARCH_SPEC_BACKUP_COUNT={counts['specBackup']}")
print(f"CANDIDATE_LIST_SHA256={value['candidateListSha256']}")
PY
}

check_health_and_pause || exit 27
inventory_json="$(collect_inventory)" || exit 28

if [[ "$mode" == "INVENTORY" ]]; then
  check_health_and_pause || exit 29
  printf 'ARCHIVE_PRUNE_STATUS=INVENTORY\n'
  printf 'SERVICE_HEALTH_BEFORE=PASS\n'
  printf 'OUTBOUND_PAUSED_BEFORE=true\n'
  emit_inventory "$inventory_json"
  printf 'SERVICE_HEALTH_AFTER=PASS\n'
  printf 'OUTBOUND_PAUSED_AFTER=true\n'
  exit 0
fi

if [[ "$mode" == "ARCHIVE" ]]; then
  [[ ! -e "$archive_path" && ! -L "$archive_path" && ! -e "$working_dir" && ! -L "$working_dir" ]] || exit 30
  mkdir -m 700 -- "$working_dir"
  trap remove_working_dir EXIT
  python3 - "$inventory_json" "$working_dir/archive_manifest.json" <<'PY'
import datetime
import json
import pathlib
import sys
value = json.loads(sys.argv[1])
value["schemaVersion"] = "server-old-version-archive-manifest-v1"
value["createdAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
pathlib.Path(sys.argv[2]).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
  python3 - "$inventory_json" "$working_dir/candidates.nul" <<'PY'
import json
import pathlib
import sys
value = json.loads(sys.argv[1])
paths = []
for item in value["candidates"]:
    if item["kind"] == "old_research_spec_overlay":
        paths.extend(f'{item["archivePath"]}/{member["relativePath"]}' for member in item["members"])
    else:
        paths.append(item["archivePath"])
if len(paths) != len(set(paths)):
    raise RuntimeError("duplicate archive input path")
payload = b"".join(path.encode("utf-8") + b"\0" for path in paths)
pathlib.Path(sys.argv[2]).write_bytes(payload)
PY
  tar --create --gzip --file="$archive_path" --format=pax --sort=name --numeric-owner --owner=0 --group=0 \
    -C "$working_dir" archive_manifest.json \
    -C "$parent_dir" --null --files-from="$working_dir/candidates.nul"
  chmod 600 "$archive_path"
  tar -tzf "$archive_path" >/dev/null
  archive_hash="$(sha256sum "$archive_path" | awk '{print $1}')"
  archive_size="$(stat -c %s "$archive_path")"
  post_archive_inventory="$(collect_inventory)" || exit 32
  post_archive_hash="$(python3 - "$post_archive_inventory" <<'PY'
import json, sys
print(json.loads(sys.argv[1])["candidateListSha256"])
PY
)"
  candidate_hash="$(python3 - "$inventory_json" <<'PY'
import json, sys
print(json.loads(sys.argv[1])["candidateListSha256"])
PY
)"
  [[ "$post_archive_hash" == "$candidate_hash" ]] || exit 31
  verify_archive_members "$archive_path" "$candidate_hash"
  check_health_and_pause || exit 33
  printf 'ARCHIVE_PRUNE_STATUS=ARCHIVED\n'
  printf 'SERVICE_HEALTH_BEFORE=PASS\n'
  printf 'OUTBOUND_PAUSED_BEFORE=true\n'
  emit_inventory "$inventory_json"
  printf 'ARCHIVE_SHA256=%s\n' "$archive_hash"
  printf 'ARCHIVE_SIZE=%s\n' "$archive_size"
  printf 'SERVICE_HEALTH_AFTER=PASS\n'
  printf 'OUTBOUND_PAUSED_AFTER=true\n'
  exit 0
fi

[[ "$expected_candidate_hash" =~ ^[a-f0-9]{64}$ ]] || exit 40
[[ "$expected_archive_hash" =~ ^[a-f0-9]{64}$ ]] || exit 41
candidate_hash="$(python3 - "$inventory_json" <<'PY'
import json, sys
print(json.loads(sys.argv[1])["candidateListSha256"])
PY
)"
[[ "$candidate_hash" == "$expected_candidate_hash" ]] || exit 42
[[ -f "$archive_path" && ! -L "$archive_path" ]] || exit 43
[[ "$(readlink -e "$archive_path")" == "$archive_path" ]] || exit 44
archive_hash="$(sha256sum "$archive_path" | awk '{print $1}')"
[[ "$archive_hash" == "$expected_archive_hash" ]] || exit 45
archive_size="$(stat -c %s "$archive_path")"
[[ "$archive_size" =~ ^[1-9][0-9]*$ ]] || exit 45
tar -tzf "$archive_path" >/dev/null
verify_archive_members "$archive_path" "$expected_candidate_hash"
archive_manifest_json="$(tar -xOzf "$archive_path" archive_manifest.json)"
python3 - "$expected_candidate_hash" "$archive_manifest_json" <<'PY'
import json, sys
value = json.loads(sys.argv[2])
if value.get("schemaVersion") != "server-old-version-archive-manifest-v1":
    raise SystemExit(1)
if value.get("candidateListSha256") != sys.argv[1]:
    raise SystemExit(1)
PY

if [[ "$mode" == "VERIFY_ARCHIVE" ]]; then
  check_health_and_pause || exit 46
  printf 'ARCHIVE_PRUNE_STATUS=ARCHIVED\n'
  printf 'SERVICE_HEALTH_BEFORE=PASS\n'
  printf 'OUTBOUND_PAUSED_BEFORE=true\n'
  emit_inventory "$inventory_json"
  printf 'ARCHIVE_SHA256=%s\n' "$archive_hash"
  printf 'ARCHIVE_SIZE=%s\n' "$archive_size"
  printf 'SERVICE_HEALTH_AFTER=PASS\n'
  printf 'OUTBOUND_PAUSED_AFTER=true\n'
  exit 0
fi

app_resolved="$(readlink -e "$app_dir")"
parent_resolved="$(readlink -e "$parent_dir")"
private_resolved="$(readlink -e "$private_root")"
current_db="$(readlink -m "$app_dir/agent_service/data/agent.db")"
base_protected="$(python3 - "$inventory_json" <<'PY'
import json, sys
print(json.loads(sys.argv[1])["protected"]["baseArchivePath"])
PY
)"
expanded_protected="$(python3 - "$inventory_json" <<'PY'
import json, sys
print(json.loads(sys.argv[1])["protected"]["expandedArchivePath"])
PY
)"
deleted_count=0
overlay_post_checks=()
while IFS=$'\t' read -r kind archive_relative expected_tree_hash candidate_plan; do
  [[ -n "$kind" && -n "$archive_relative" && "$expected_tree_hash" =~ ^[a-f0-9]{64}$ && -n "$candidate_plan" ]] || exit 46
  delete_mode=tree
  spec_candidate=false
  case "$kind" in
    previous_release)
      [[ "$archive_relative" == "$(basename "$app_dir").previous" ]] || exit 47
      delete_anchor="$parent_resolved"
      delete_relative="$(basename "$app_dir").previous"
      target="$delete_anchor/$delete_relative"
      ;;
    rollback_state)
      [[ "$archive_relative" == "$(basename "$app_dir").rollback-state" ]] || exit 48
      delete_anchor="$parent_resolved"
      delete_relative="$(basename "$app_dir").rollback-state"
      target="$delete_anchor/$delete_relative"
      ;;
    old_research_spec|research_spec_backup)
      prefix="$(basename "$app_dir")/private/"
      [[ "$archive_relative" == "$prefix"* ]] || exit 49
      spec_relative="${archive_relative#"$prefix"}"
      [[ "$spec_relative" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] || exit 50
      case "/$spec_relative/" in *"/./"*|*"/../"*) exit 50 ;; esac
      for protected_root in "$base_protected" "$expanded_protected"; do
        [[ "$archive_relative" != "$protected_root" &&
           "$archive_relative" != "$protected_root/"* &&
           "$protected_root" != "$archive_relative/"* ]] || exit 51
      done
      delete_anchor="$private_resolved"
      delete_relative="$spec_relative"
      target="$delete_anchor/$delete_relative"
      spec_candidate=true
      ;;
    old_research_spec_overlay)
      prefix="$(basename "$app_dir")/private/"
      [[ "$archive_relative" == "$prefix"* ]] || exit 49
      spec_relative="${archive_relative#"$prefix"}"
      [[ "$spec_relative" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] || exit 50
      case "/$spec_relative/" in *"/./"*|*"/../"*) exit 50 ;; esac
      for protected_root in "$base_protected" "$expanded_protected"; do
        [[ "$archive_relative" != "$protected_root" &&
           "$archive_relative" != "$protected_root/"* ]] || exit 51
      done
      delete_anchor="$private_resolved"
      delete_relative="$spec_relative"
      target="$delete_anchor/$delete_relative"
      spec_candidate=true
      delete_mode=overlay
      ;;
    *) exit 52 ;;
  esac
  [[ -d "$target" && ! -L "$target" ]] || exit 53
  resolved="$(readlink -e "$target")"
  [[ -n "$resolved" && "$resolved" == "$(readlink -m "$target")" ]] || exit 54
  [[ "$resolved" != "$app_resolved" && "$resolved" != "$parent_resolved" && "$resolved" != "$private_resolved" && "$resolved" != "$current_db" ]] || exit 55
  if [[ "$spec_candidate" == "true" ]]; then
    [[ "$resolved" == "$target" ]] || exit 56
    case "$resolved" in "$private_resolved"/*) ;; *) exit 56 ;; esac
  else
    [[ "$(dirname "$resolved")" == "$parent_resolved" ]] || exit 57
    case "$app_resolved" in "$resolved"|"$resolved"/*) exit 58 ;; esac
  fi
  case "$current_db" in "$resolved"|"$resolved"/*) exit 59 ;; esac
  if [[ "$delete_mode" == "overlay" ]]; then
    overlay_root_identity="$(
      delete_exact_overlay_files \
        "$delete_anchor" "$delete_relative" "$archive_relative" "$expected_tree_hash" \
        "$candidate_plan" "DELETE" ""
    )" || exit 66
    [[ "$overlay_root_identity" =~ ^[0-9]+:[0-9]+$ ]] || exit 66
    overlay_post_checks+=("$delete_relative|$archive_relative|$expected_tree_hash|$candidate_plan|$overlay_root_identity")
    [[ -d "$target" && ! -L "$target" && "$(readlink -e "$target")" == "$resolved" ]] || exit 60
  else
    verify_tree_hash "$resolved" "$expected_tree_hash"
    delete_exact_tree "$delete_anchor" "$delete_relative"
    [[ ! -e "$resolved" && ! -L "$resolved" ]] || exit 60
  fi
  deleted_count=$((deleted_count + 1))
done < <(python3 - "$inventory_json" <<'PY'
import base64, json, sys
for item in json.loads(sys.argv[1])["candidates"]:
    encoded = base64.urlsafe_b64encode(
        json.dumps(item, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).decode("ascii").rstrip("=")
    print(f'{item["kind"]}\t{item["archivePath"]}\t{item["treeSha256"]}\t{encoded}')
PY
)
candidate_count="$(python3 - "$inventory_json" <<'PY'
import json, sys
print(json.loads(sys.argv[1])["counts"]["candidate"])
PY
)"
[[ "$deleted_count" == "$candidate_count" ]] || exit 61
post_prune_inventory="$(collect_inventory)" || exit 64
python3 - "$inventory_json" "$post_prune_inventory" <<'PY'
import json, sys
before = json.loads(sys.argv[1])
after = json.loads(sys.argv[2])
if after.get("protected") != before.get("protected"):
    raise SystemExit(1)
counts = after.get("counts")
if not isinstance(counts, dict) or set(counts) != {"candidate", "previous", "rollback", "oldSpec", "specBackup"}:
    raise SystemExit(1)
if any(not isinstance(value, int) or isinstance(value, bool) or value != 0 for value in counts.values()):
    raise SystemExit(1)
PY
[[ "$?" == "0" ]] || exit 63
for overlay_check in "${overlay_post_checks[@]}"; do
  IFS='|' read -r overlay_relative overlay_archive_path overlay_tree_hash overlay_plan overlay_root_identity <<<"$overlay_check"
  [[ -n "$overlay_relative" && -n "$overlay_archive_path" && "$overlay_tree_hash" =~ ^[a-f0-9]{64}$ &&
     -n "$overlay_plan" && "$overlay_root_identity" =~ ^[0-9]+:[0-9]+$ ]] || exit 67
  delete_exact_overlay_files \
    "$private_resolved" "$overlay_relative" "$overlay_archive_path" "$overlay_tree_hash" \
    "$overlay_plan" "ABSENT" "$overlay_root_identity" >/dev/null || exit 67
done
check_health_and_pause || exit 65
rm -f -- "$archive_path"
[[ ! -e "$archive_path" && ! -L "$archive_path" ]] || exit 62
printf 'ARCHIVE_PRUNE_STATUS=PRUNED\n'
printf 'SERVICE_HEALTH_BEFORE=PASS\n'
printf 'OUTBOUND_PAUSED_BEFORE=true\n'
printf 'CANDIDATE_COUNT=%s\n' "$candidate_count"
printf 'DELETED_COUNT=%s\n' "$deleted_count"
printf 'CANDIDATE_LIST_SHA256=%s\n' "$candidate_hash"
printf 'ARCHIVE_SHA256=%s\n' "$archive_hash"
printf 'ARCHIVE_SIZE=%s\n' "$archive_size"
printf 'REMOTE_ARCHIVE_REMOVED=true\n'
printf 'SERVICE_HEALTH_AFTER=PASS\n'
printf 'OUTBOUND_PAUSED_AFTER=true\n'
'@
$remoteTemplate = $remoteScript

$remote = "$($envMap.VPS_SSH_USER)@$($envMap.VPS_IP)"
$sshArguments = @(
  "-i", $envMap.VPS_SSH_KEY_PATH,
  "-o", "BatchMode=yes",
  "-o", "IdentitiesOnly=yes",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "ConnectTimeout=15",
  "-o", "ServerAliveInterval=10",
  "-o", "ServerAliveCountMax=2",
  "-o", "LogLevel=ERROR"
)

function Invoke-RemotePhase {
  param(
    [string]$Mode,
    [string]$Nonce,
    [string]$ExpectedCandidateHash,
    [string]$ExpectedArchiveHash,
    [string]$FailureStep
  )
  $script = $remoteTemplate.Replace("__MODE__", $Mode)
  $script = $script.Replace("__BASE_FINGERPRINT__", $baseSpecFingerprint)
  $script = $script.Replace("__EXPANDED_FINGERPRINT__", $expandedSpecFingerprint)
  $script = $script.Replace("__EXPECTED_CANDIDATE_HASH__", $ExpectedCandidateHash)
  $script = $script.Replace("__EXPECTED_ARCHIVE_HASH__", $ExpectedArchiveHash)
  $script = $script.Replace("__NONCE__", $Nonce)

  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $raw = $script | & ssh @sshArguments $remote "bash -s" 2>$null
    $exitCode = $LASTEXITCODE
  } catch {
    $raw = @()
    $exitCode = 255
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($exitCode -ne 0) {
    Stop-ArchivePrune -Step $FailureStep -ExitCode $exitCode
  }
  return @($raw)
}

function ConvertTo-NativeProcessArgument {
  param([string]$Value)
  if ($null -eq $Value -or $Value.IndexOf([char]0) -ge 0 -or $Value -match "[`r`n]") {
    throw "invalid native process argument"
  }
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }

  $builder = [Text.StringBuilder]::new()
  [void]$builder.Append([char]34)
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq [char]92) {
      $backslashes += 1
      continue
    }
    if ($character -eq [char]34) {
      if ($backslashes -gt 0) {
        [void]$builder.Append([string]::new([char]92, $backslashes * 2))
      }
      [void]$builder.Append([char]92)
      [void]$builder.Append([char]34)
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      [void]$builder.Append([string]::new([char]92, $backslashes))
      $backslashes = 0
    }
    [void]$builder.Append($character)
  }
  if ($backslashes -gt 0) {
    [void]$builder.Append([string]::new([char]92, $backslashes * 2))
  }
  [void]$builder.Append([char]34)
  return $builder.ToString()
}

function Get-NativeProcessTreeIds {
  param([int]$RootProcessId)
  if ($RootProcessId -le 0) { throw "invalid process tree root" }

  $rows = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    @(Get-CimInstance -ClassName Win32_Process -OperationTimeoutSec 5 -ErrorAction Stop | ForEach-Object {
      [pscustomobject]@{
        ProcessId = [int]$_.ProcessId
        ParentProcessId = [int]$_.ParentProcessId
      }
    })
  } else {
    $psCommand = if (Test-Path -LiteralPath "/bin/ps" -PathType Leaf) {
      "/bin/ps"
    } else {
      (Get-Command ps -ErrorAction Stop).Source
    }
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $rawRows = @(& $psCommand -eo "pid=,ppid=" 2>$null)
      $psExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousPreference
    }
    if ($psExitCode -ne 0) { throw "process tree inventory failed" }
    @($rawRows | ForEach-Object {
      if ([string]$_ -match '^\s*(\d+)\s+(\d+)\s*$') {
        [pscustomobject]@{
          ProcessId = [int]$Matches[1]
          ParentProcessId = [int]$Matches[2]
        }
      }
    })
  }

  $tree = New-Object Collections.Generic.List[int]
  $seen = New-Object Collections.Generic.HashSet[int]
  $tree.Add($RootProcessId)
  [void]$seen.Add($RootProcessId)
  for ($index = 0; $index -lt $tree.Count; $index++) {
    $parentId = $tree[$index]
    foreach ($row in $rows) {
      if ($row.ParentProcessId -eq $parentId -and $seen.Add($row.ProcessId)) {
        $tree.Add($row.ProcessId)
      }
    }
  }
  return @($tree)
}

function Test-NativeProcessRunning {
  param([int]$ProcessId)
  try {
    $candidate = [Diagnostics.Process]::GetProcessById($ProcessId)
    try {
      return -not $candidate.HasExited
    } finally {
      $candidate.Dispose()
    }
  } catch [ArgumentException] {
    return $false
  }
}

function Stop-NativeProcessTree {
  param([Diagnostics.Process]$Process)
  $rootProcessId = $Process.Id
  $knownProcessIds = @(Get-NativeProcessTreeIds -RootProcessId $rootProcessId)
  if ($rootProcessId -notin $knownProcessIds) { throw "process tree root was not inventoried" }

  if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    $taskkillPath = Join-Path $env:SystemRoot "System32\taskkill.exe"
    if (-not (Test-Path -LiteralPath $taskkillPath -PathType Leaf)) {
      throw "fixed taskkill executable is missing"
    }
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $taskkillPath
    $startInfo.Arguments = "/PID $rootProcessId /T /F"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $killer = [Diagnostics.Process]::new()
    $killer.StartInfo = $startInfo
    try {
      if (-not $killer.Start()) { throw "taskkill did not start" }
      $stdoutDrain = $killer.StandardOutput.ReadToEndAsync()
      $stderrDrain = $killer.StandardError.ReadToEndAsync()
      if (-not $killer.WaitForExit(10000)) {
        try { $killer.Kill() } catch {}
        [void]$killer.WaitForExit(2000)
        throw "taskkill timed out"
      }
      [void]$stdoutDrain.GetAwaiter().GetResult()
      [void]$stderrDrain.GetAwaiter().GetResult()
    } finally {
      $killer.Dispose()
    }
  } else {
    for ($index = $knownProcessIds.Count - 1; $index -ge 0; $index--) {
      try {
        $candidate = [Diagnostics.Process]::GetProcessById($knownProcessIds[$index])
        try {
          if (-not $candidate.HasExited) { $candidate.Kill() }
        } finally {
          $candidate.Dispose()
        }
      } catch [ArgumentException] {
      }
    }
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $remaining = @($knownProcessIds | Where-Object { Test-NativeProcessRunning -ProcessId $_ })
    if ($remaining.Count -eq 0) { break }
    [Threading.Thread]::Sleep(100)
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($remaining.Count -ne 0) { throw "process tree remained after termination" }
  if (-not $Process.WaitForExit(1000)) { throw "root process remained after tree termination" }
}

function Invoke-BoundedNativeProcess {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$StandardOutputPath,
    [string]$StandardErrorPath,
    [int]$TimeoutSeconds
  )
  if ($TimeoutSeconds -lt 1 -or
      [string]::IsNullOrWhiteSpace($FilePath) -or
      [string]::IsNullOrWhiteSpace($StandardOutputPath) -or
      [string]::IsNullOrWhiteSpace($StandardErrorPath) -or
      [IO.Path]::GetFullPath($StandardOutputPath) -eq [IO.Path]::GetFullPath($StandardErrorPath)) {
    throw "invalid bounded process settings"
  }
  $argumentLine = (@($Arguments | ForEach-Object { ConvertTo-NativeProcessArgument -Value $_ }) -join " ")
  $process = Start-Process -FilePath $FilePath -ArgumentList $argumentLine `
    -PassThru -NoNewWindow -RedirectStandardOutput $StandardOutputPath `
    -RedirectStandardError $StandardErrorPath
  try {
    $finished = $process.WaitForExit($TimeoutSeconds * 1000)
    if (-not $finished) {
      Stop-NativeProcessTree -Process $process
      return [pscustomobject]@{ TimedOut = $true; ExitCode = 124 }
    }
    [void]$process.WaitForExit()
    $process.Refresh()
    return [pscustomobject]@{ TimedOut = $false; ExitCode = [int]$process.ExitCode }
  } finally {
    $process.Dispose()
  }
}

function Invoke-ProgressAwareNativeProcess {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$StandardOutputPath,
    [string]$StandardErrorPath,
    [string]$ProgressPath,
    [int]$NoProgressTimeoutSeconds = 720,
    [int]$MaximumRuntimeSeconds = 43200
  )
  if ($NoProgressTimeoutSeconds -lt 600 -or $NoProgressTimeoutSeconds -gt 900 -or
      $MaximumRuntimeSeconds -lt $NoProgressTimeoutSeconds -or
      [string]::IsNullOrWhiteSpace($FilePath) -or
      [string]::IsNullOrWhiteSpace($StandardOutputPath) -or
      [string]::IsNullOrWhiteSpace($StandardErrorPath) -or
      [string]::IsNullOrWhiteSpace($ProgressPath) -or
      [IO.Path]::GetFullPath($StandardOutputPath) -eq [IO.Path]::GetFullPath($StandardErrorPath)) {
    throw "invalid progress-aware process settings"
  }
  $argumentLine = (@($Arguments | ForEach-Object { ConvertTo-NativeProcessArgument -Value $_ }) -join " ")
  $initialSize = if (Test-Path -LiteralPath $ProgressPath -PathType Leaf) {
    [long](Get-Item -LiteralPath $ProgressPath).Length
  } else {
    0L
  }
  $process = Start-Process -FilePath $FilePath -ArgumentList $argumentLine `
    -PassThru -NoNewWindow -RedirectStandardOutput $StandardOutputPath `
    -RedirectStandardError $StandardErrorPath
  $startedAt = [DateTime]::UtcNow
  $lastProgressAt = $startedAt
  $lastSize = $initialSize
  try {
    while (-not $process.WaitForExit(2000)) {
      $currentSize = if (Test-Path -LiteralPath $ProgressPath -PathType Leaf) {
        [long](Get-Item -LiteralPath $ProgressPath).Length
      } else {
        0L
      }
      if ($currentSize -lt $lastSize) {
        Stop-NativeProcessTree -Process $process
        throw "transfer progress path shrank"
      }
      if ($currentSize -gt $lastSize) {
        $lastSize = $currentSize
        $lastProgressAt = [DateTime]::UtcNow
      }
      $now = [DateTime]::UtcNow
      if (($now - $lastProgressAt).TotalSeconds -ge $NoProgressTimeoutSeconds) {
        Stop-NativeProcessTree -Process $process
        return [pscustomobject]@{ Stalled = $true; TimedOut = $false; ExitCode = 124; Bytes = $lastSize }
      }
      if (($now - $startedAt).TotalSeconds -ge $MaximumRuntimeSeconds) {
        Stop-NativeProcessTree -Process $process
        return [pscustomobject]@{ Stalled = $false; TimedOut = $true; ExitCode = 124; Bytes = $lastSize }
      }
    }
    [void]$process.WaitForExit()
    $process.Refresh()
    $finalSize = if (Test-Path -LiteralPath $ProgressPath -PathType Leaf) {
      [long](Get-Item -LiteralPath $ProgressPath).Length
    } else {
      0L
    }
    if ($finalSize -lt $lastSize) { throw "transfer progress path shrank" }
    return [pscustomobject]@{
      Stalled = $false
      TimedOut = $false
      ExitCode = [int]$process.ExitCode
      Bytes = $finalSize
    }
  } finally {
    $process.Dispose()
  }
}

function Test-ArchiveTransferHash {
  param([string]$Path, [string]$ExpectedSha256)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() -eq $ExpectedSha256
}

function Invoke-ResumableArchiveDownload {
  param(
    [string]$Remote,
    [string]$RemoteArchive,
    [string]$PartialArchive,
    [string]$ExpectedSha256,
    [long]$ExpectedSize,
    [string[]]$SshArguments,
    [switch]$AllowSshFallback
  )
  if ($RemoteArchive -notmatch '^/tmp/export-ai-agent-old-versions-[a-f0-9]{32}\.tar\.gz$' -or
      $ExpectedSha256 -notmatch '^[a-f0-9]{64}$' -or $ExpectedSize -le 0) {
    throw "invalid archive transfer identity"
  }

  $batchPath = "$PartialArchive.sftp-batch"
  $transferOutput = "$PartialArchive.transfer-output"
  $transferError = "$PartialArchive.transfer-error"
  $fallbackArchive = "$PartialArchive.ssh-fallback"
  $sftpLocalPath = [IO.Path]::GetFullPath($PartialArchive).Replace('\', '/')
  if ($sftpLocalPath.Contains('"') -or $sftpLocalPath -match "[`r`n]") {
    throw "invalid local archive path"
  }

  try {
    if (Test-Path -LiteralPath $PartialArchive -PathType Leaf) {
      Set-PrivateLocalMode -Path $PartialArchive -Mode "600"
      $existingSize = [long](Get-Item -LiteralPath $PartialArchive).Length
      if ($existingSize -gt $ExpectedSize) { throw "partial archive exceeds expected size" }
      if ($existingSize -eq $ExpectedSize) {
        if (Test-ArchiveTransferHash -Path $PartialArchive -ExpectedSha256 $ExpectedSha256) {
          return "EXISTING_PARTIAL"
        }
        throw "complete partial archive hash mismatch"
      }
    }
    [IO.File]::WriteAllText(
      $batchPath,
      "reget `"$RemoteArchive`" `"$sftpLocalPath`"`n",
      [Text.UTF8Encoding]::new($false)
    )
    Set-PrivateLocalMode -Path $batchPath -Mode "600"
    $sftpArguments = @("-q", "-B", "65536", "-R", "64", "-b", $batchPath) +
      $SshArguments + @($Remote)
    $lastSize = if (Test-Path -LiteralPath $PartialArchive -PathType Leaf) {
      [long](Get-Item -LiteralPath $PartialArchive).Length
    } else {
      0L
    }
    $attemptsWithoutProgress = 0
    for ($attempt = 1; $attempt -le 60; $attempt++) {
      Remove-Item -LiteralPath $transferOutput,$transferError -Force -ErrorAction SilentlyContinue
      $result = Invoke-ProgressAwareNativeProcess `
        -FilePath (Get-Command sftp).Source `
        -Arguments $sftpArguments `
        -StandardOutputPath $transferOutput `
        -StandardErrorPath $transferError `
        -ProgressPath $PartialArchive `
        -NoProgressTimeoutSeconds 720 `
        -MaximumRuntimeSeconds 43200
      if (Test-Path -LiteralPath $PartialArchive -PathType Leaf) {
        Set-PrivateLocalMode -Path $PartialArchive -Mode "600"
      }
      $currentSize = if (Test-Path -LiteralPath $PartialArchive -PathType Leaf) {
        [long](Get-Item -LiteralPath $PartialArchive).Length
      } else {
        0L
      }
      if ($currentSize -gt $ExpectedSize) { throw "partial archive exceeds expected size" }
      if ($currentSize -eq $ExpectedSize) {
        if (Test-ArchiveTransferHash -Path $PartialArchive -ExpectedSha256 $ExpectedSha256) {
          return "SFTP_REGET"
        }
        throw "complete partial archive hash mismatch"
      }
      if ($result.ExitCode -eq 0 -and -not $result.Stalled -and -not $result.TimedOut) {
        throw "SFTP transfer ended before expected size"
      }
      if ($currentSize -le $lastSize) {
        $attemptsWithoutProgress += 1
      } else {
        $attemptsWithoutProgress = 0
      }
      $lastSize = $currentSize
      if ($attemptsWithoutProgress -ge 3) { break }
    }

    if (-not $AllowSshFallback) { throw "resumable SFTP transfer stalled" }
    Remove-Item -LiteralPath $fallbackArchive,$transferOutput,$transferError -Force -ErrorAction SilentlyContinue
    $remoteCommand = "cat -- $RemoteArchive"
    $fallbackResult = Invoke-ProgressAwareNativeProcess `
      -FilePath (Get-Command ssh).Source `
      -Arguments ($SshArguments + @("-T", $Remote, $remoteCommand)) `
      -StandardOutputPath $fallbackArchive `
      -StandardErrorPath $transferError `
      -ProgressPath $fallbackArchive `
      -NoProgressTimeoutSeconds 720 `
      -MaximumRuntimeSeconds 43200
    if (Test-Path -LiteralPath $fallbackArchive -PathType Leaf) {
      Set-PrivateLocalMode -Path $fallbackArchive -Mode "600"
    }
    if ($fallbackResult.Stalled -or $fallbackResult.TimedOut -or $fallbackResult.ExitCode -ne 0 -or
        -not (Test-Path -LiteralPath $fallbackArchive -PathType Leaf) -or
        [long](Get-Item -LiteralPath $fallbackArchive).Length -ne $ExpectedSize -or
        -not (Test-ArchiveTransferHash -Path $fallbackArchive -ExpectedSha256 $ExpectedSha256)) {
      throw "archive transfer failed"
    }
    Remove-Item -LiteralPath $PartialArchive -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $fallbackArchive -Destination $PartialArchive
    Set-PrivateLocalMode -Path $PartialArchive -Mode "600"
    return "SSH_STDOUT"
  } finally {
    Remove-Item -LiteralPath $batchPath,$transferOutput,$transferError `
      -Force -ErrorAction SilentlyContinue
  }
}

function Read-FixedRemoteState {
  param([object[]]$RawOutput, [string[]]$ExpectedKeys)
  $state = @{}
  foreach ($item in @($RawOutput)) {
    $line = ([string]$item).Trim()
    if ($line -notmatch '^([A-Z0-9_]+)=([A-Za-z0-9._-]+)$') { continue }
    $key = $Matches[1]
    if ($key -notin $ExpectedKeys -or $state.ContainsKey($key)) {
      Stop-ArchivePrune -Step "REMOTE_OUTPUT_PARSE" -ExitCode 65
    }
    $state[$key] = $Matches[2]
  }
  foreach ($key in $ExpectedKeys) {
    if (-not $state.ContainsKey($key)) {
      Stop-ArchivePrune -Step "REMOTE_OUTPUT_PARSE" -ExitCode 65
    }
  }
  return $state
}

function Assert-CommonRemoteState {
  param([hashtable]$State)
  foreach ($key in @("CANDIDATE_COUNT", "PREVIOUS_RELEASE_COUNT", "ROLLBACK_STATE_COUNT", "OLD_RESEARCH_SPEC_COUNT", "RESEARCH_SPEC_BACKUP_COUNT", "DELETED_COUNT", "ARCHIVE_SIZE")) {
    if ($State.ContainsKey($key) -and [string]$State[$key] -notmatch '^\d+$') {
      Stop-ArchivePrune -Step "REMOTE_OUTPUT_PARSE" -ExitCode 65
    }
  }
  foreach ($key in @("CANDIDATE_LIST_SHA256", "ARCHIVE_SHA256")) {
    if ($State.ContainsKey($key) -and [string]$State[$key] -notmatch '^[a-f0-9]{64}$') {
      Stop-ArchivePrune -Step "REMOTE_OUTPUT_PARSE" -ExitCode 65
    }
  }
  if ($State.SERVICE_HEALTH_BEFORE -ne "PASS" -or
      $State.SERVICE_HEALTH_AFTER -ne "PASS" -or
      $State.OUTBOUND_PAUSED_BEFORE -ne "true" -or
      $State.OUTBOUND_PAUSED_AFTER -ne "true") {
    Stop-ArchivePrune -Step "REMOTE_HEALTH_ASSERT" -ExitCode 1
  }
}

function Get-TextSha256 {
  param([string]$Value)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Value)
    return (($algorithm.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $algorithm.Dispose()
  }
}

function Set-PrivateLocalMode {
  param([string]$Path, [string]$Mode)
  if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $allowedSids = @(
      $currentSid,
      [Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
      [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
    )
    $isDirectory = Test-Path -LiteralPath $Path -PathType Container
    $security = if ($isDirectory) {
      [Security.AccessControl.DirectorySecurity]::new()
    } else {
      [Security.AccessControl.FileSecurity]::new()
    }
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sid in $allowedSids) {
      $inheritance = if ($isDirectory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
          [Security.AccessControl.InheritanceFlags]::ObjectInherit
      } else {
        [Security.AccessControl.InheritanceFlags]::None
      }
      $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
      )
      [void]$security.AddAccessRule($rule)
    }
    if ($isDirectory) {
      [IO.Directory]::SetAccessControl($Path, [Security.AccessControl.DirectorySecurity]$security)
      $actual = [IO.Directory]::GetAccessControl($Path, [Security.AccessControl.AccessControlSections]::Access)
    } else {
      [IO.File]::SetAccessControl($Path, [Security.AccessControl.FileSecurity]$security)
      $actual = [IO.File]::GetAccessControl($Path, [Security.AccessControl.AccessControlSections]::Access)
    }
    if (-not $actual.AreAccessRulesProtected) { throw "local private ACL inheritance is enabled" }
    $allowedValues = @($allowedSids | ForEach-Object { $_.Value } | Sort-Object -Unique)
    $allowRules = @($actual.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | Where-Object {
      $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
    })
    if ($allowRules.Count -ne $allowedValues.Count) { throw "local private ACL allowlist mismatch" }
    foreach ($rule in $allowRules) {
      if ($rule.IdentityReference.Value -notin $allowedValues -or
          ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
            [Security.AccessControl.FileSystemRights]::FullControl) {
        throw "local private ACL verification failed"
      }
    }
    return
  }
  & chmod $Mode -- $Path 2>$null
  if ($LASTEXITCODE -ne 0) { throw "local private mode failed" }
}

function Get-ResumeTransferRoot {
  param([string]$BackupRoot)
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
  $candidate = [IO.Path]::GetFullPath((Join-Path $tempBase "crm-archive-resume"))
  $tempPrefix = $tempBase + [IO.Path]::DirectorySeparatorChar
  $asciiSafe = $candidate -cmatch '^[\x20-\x7e]+$' -and
    $candidate.IndexOf([char]34) -lt 0 -and
    $candidate.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)
  if ($asciiSafe) {
    try {
      New-Item -ItemType Directory -Force -Path $candidate | Out-Null
      Set-PrivateLocalMode -Path $candidate -Mode "700"
      return $candidate
    } catch {
      # The already-private workspace backup root is the fail-closed fallback.
    }
  }
  return $BackupRoot
}

function Test-ArchiveOverlayPayloads {
  param([string]$ArchivePath)
  $pythonCommand = @(Get-Command python3, python -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($pythonCommand.Count -ne 1) { throw "local Python is required for overlay validation" }
  $validator = @'
import hashlib
import json
import pathlib
import re
import sys
import tarfile

archive = pathlib.Path(sys.argv[2])
with tarfile.open(archive, "r:gz") as package:
    members = package.getmembers()
    names = [member.name.rstrip("/") for member in members]
    if len(names) != len(set(names)):
        raise SystemExit(1)
    manifests = [member for member in members if member.name == "archive_manifest.json"]
    if len(manifests) != 1 or not manifests[0].isreg() or manifests[0].issym() or manifests[0].islnk():
        raise SystemExit(1)
    handle = package.extractfile(manifests[0])
    if handle is None:
        raise SystemExit(1)
    manifest = json.loads(handle.read().decode("utf-8"))
    by_name = {member.name.rstrip("/"): member for member in members}
    expected_paths = set()
    for candidate in manifest.get("candidates", []):
        if candidate.get("kind") != "old_research_spec_overlay":
            continue
        if set(candidate) != {"kind", "archivePath", "treeSha256", "members"}:
            raise SystemExit(1)
        root = candidate.get("archivePath")
        values = candidate.get("members")
        if not isinstance(root, str) or root.endswith("/") or not isinstance(values, list) or not values:
            raise SystemExit(1)
        rows = []
        parsed = []
        for value in values:
            if not isinstance(value, dict) or set(value) != {"relativePath", "mode", "size", "sha256"}:
                raise SystemExit(1)
            name = value.get("relativePath")
            mode = value.get("mode")
            size = value.get("size")
            digest_value = value.get("sha256")
            if (
                not isinstance(name, str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.json", name)
                or not isinstance(mode, str)
                or not re.fullmatch(r"[0-7]{3,4}", mode)
                or not isinstance(size, int)
                or isinstance(size, bool)
                or size < 0
                or not isinstance(digest_value, str)
                or not re.fullmatch(r"[a-f0-9]{64}", digest_value)
            ):
                raise SystemExit(1)
            parsed.append((name, mode, size, digest_value))
            rows.append(f"F|{name}|{mode}|{size}|{digest_value}")
        if len({item[0] for item in parsed}) != len(parsed) or parsed != sorted(parsed, key=lambda item: item[0]):
            raise SystemExit(1)
        if hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest() != candidate.get("treeSha256"):
            raise SystemExit(1)
        for name, mode, size, expected_digest in parsed:
            archive_name = f"{root}/{name}"
            if archive_name in expected_paths or archive_name not in by_name:
                raise SystemExit(1)
            expected_paths.add(archive_name)
            member = by_name[archive_name]
            if not member.isreg() or member.issym() or member.islnk():
                raise SystemExit(1)
            if f"{member.mode:o}" != mode or member.size != size:
                raise SystemExit(1)
            payload = package.extractfile(member)
            if payload is None:
                raise SystemExit(1)
            digest = hashlib.sha256()
            for block in iter(lambda: payload.read(1024 * 1024), b""):
                digest.update(block)
            if digest.hexdigest() != expected_digest:
                raise SystemExit(1)
'@
  $encodedValidator = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($validator))
  $bootstrap = "import base64,sys;exec(compile(base64.b64decode(sys.argv[1]),'<overlay-validator>','exec'))"
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $validationOutput = @(& $pythonCommand[0].Source -c $bootstrap $encodedValidator $ArchivePath 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($exitCode -ne 0) { throw "overlay archive payload validation failed" }
}

function Test-DownloadedArchive {
  param(
    [string]$ArchivePath,
    [string]$ExpectedArchiveHash,
    [string]$ExpectedCandidateHash,
    [int]$ExpectedCandidateCount,
    [hashtable]$ExpectedCounts
  )
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash.ToLowerInvariant() -ne $ExpectedArchiveHash) {
    throw "archive hash mismatch"
  }

  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $members = @(& tar -tzf $ArchivePath 2>$null | ForEach-Object { ([string]$_).Trim() })
    $listExitCode = $LASTEXITCODE
    $manifestText = @(& tar -xOzf $ArchivePath "archive_manifest.json" 2>$null) -join "`n"
    $manifestExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($listExitCode -ne 0 -or $manifestExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($manifestText)) {
    throw "tar validation failed"
  }
  $manifest = $manifestText | ConvertFrom-Json
  if ([string]$manifest.schemaVersion -ne "server-old-version-archive-manifest-v1" -or
      [string]$manifest.candidateListSha256 -ne $ExpectedCandidateHash) {
    throw "archive manifest identity mismatch"
  }

  $candidates = @($manifest.candidates)
  if ($candidates.Count -ne $ExpectedCandidateCount) { throw "archive candidate count mismatch" }
  $roots = New-Object Collections.Generic.List[string]
  $rootKinds = @{}
  $rows = New-Object Collections.Generic.List[string]
  $kindCounts = @{
    previous_release = 0
    rollback_state = 0
    old_research_spec = 0
    old_research_spec_overlay = 0
    research_spec_backup = 0
  }
  $overlayPaths = @{}
  $privatePrefix = "export-ai-agent/private/"
  $isSafePrivateRoot = {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value) -or
        -not $Value.StartsWith($privatePrefix, [StringComparison]::Ordinal) -or
        $Value.EndsWith("/", [StringComparison]::Ordinal) -or
        $Value.Contains('\') -or
        $Value.StartsWith('/')) {
      return $false
    }
    $relative = $Value.Substring($privatePrefix.Length)
    $segments = @($relative -split '/')
    return $segments.Count -gt 0 -and
      @($segments | Where-Object { $_ -in @("", ".", "..") -or $_ -notmatch '^[A-Za-z0-9._-]+$' }).Count -eq 0
  }
  $rootsOverlap = {
    param([string]$Left, [string]$Right)
    return $Left -eq $Right -or
      $Left.StartsWith($Right + "/", [StringComparison]::Ordinal) -or
      $Right.StartsWith($Left + "/", [StringComparison]::Ordinal)
  }
  $protected = @(
    [string]$manifest.protected.baseArchivePath,
    [string]$manifest.protected.expandedArchivePath
  )
  $protectedFingerprints = @(
    [string]$manifest.protected.baseFingerprint,
    [string]$manifest.protected.expandedFingerprint
  )
  if (@($protected | Sort-Object -Unique).Count -ne 2 -or
      @($protected | Where-Object { -not (& $isSafePrivateRoot $_) }).Count -ne 0 -or
      (& $rootsOverlap $protected[0] $protected[1]) -or
      @($protectedFingerprints | Where-Object { $_ -notmatch '^[a-f0-9]{64}$' }).Count -ne 0 -or
      $protectedFingerprints[0] -ne $baseSpecFingerprint -or
      $protectedFingerprints[1] -ne $expandedSpecFingerprint) {
    throw "invalid protected spec roots"
  }

  foreach ($candidate in $candidates) {
    $kind = [string]$candidate.kind
    $root = ([string]$candidate.archivePath).TrimEnd('/')
    $treeHash = [string]$candidate.treeSha256
    if (-not $kindCounts.ContainsKey($kind) -or $treeHash -notmatch '^[a-f0-9]{64}$') {
      throw "invalid candidate metadata"
    }
    switch ($kind) {
      "previous_release" { if ($root -ne "export-ai-agent.previous") { throw "invalid previous root" } }
      "rollback_state" { if ($root -ne "export-ai-agent.rollback-state") { throw "invalid rollback root" } }
      default {
        if (-not (& $isSafePrivateRoot $root)) {
          throw "invalid old research-spec root"
        }
      }
    }
    if ($root -ne [string]$candidate.archivePath) { throw "non-canonical candidate root" }
    $candidateProperties = @($candidate.PSObject.Properties.Name | Sort-Object)
    if ($kind -eq "old_research_spec_overlay") {
      if (($candidateProperties -join "|") -ne ((@("archivePath", "kind", "members", "treeSha256") | Sort-Object) -join "|")) {
        throw "invalid overlay candidate fields"
      }
      $overlayMembers = @($candidate.members)
      if ($overlayMembers.Count -eq 0) { throw "empty overlay member list" }
      $memberRows = New-Object Collections.Generic.List[string]
      $memberNames = New-Object Collections.Generic.List[string]
      foreach ($overlayMember in $overlayMembers) {
        $overlayProperties = @($overlayMember.PSObject.Properties.Name | Sort-Object)
        if (($overlayProperties -join "|") -ne ((@("mode", "relativePath", "sha256", "size") | Sort-Object) -join "|")) {
          throw "invalid overlay member fields"
        }
        $relativePath = [string]$overlayMember.relativePath
        $mode = [string]$overlayMember.mode
        $sizeValue = $overlayMember.size
        $digest = [string]$overlayMember.sha256
        if ($relativePath -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*\.json$' -or
            $mode -notmatch '^[0-7]{3,4}$' -or
            $sizeValue -is [bool] -or
            $null -eq $sizeValue -or
            [long]$sizeValue -lt 0 -or
            $digest -notmatch '^[a-f0-9]{64}$' -or
            $memberNames.Contains($relativePath)) {
          throw "invalid overlay member metadata"
        }
        $memberNames.Add($relativePath)
        $memberRows.Add("F|$relativePath|$mode|$([long]$sizeValue)|$digest")
        $archiveMemberPath = "$root/$relativePath"
        if ($overlayPaths.ContainsKey($archiveMemberPath)) { throw "duplicate overlay archive member" }
        $overlayPaths[$archiveMemberPath] = $root
      }
      if (($memberNames -join "|") -ne ((@($memberNames) | Sort-Object) -join "|") -or
          (Get-TextSha256 -Value ($memberRows -join "`n")) -ne $treeHash) {
        throw "overlay member-set hash mismatch"
      }
    } elseif (($candidateProperties -join "|") -ne ((@("archivePath", "kind", "treeSha256") | Sort-Object) -join "|")) {
      throw "invalid tree candidate fields"
    }
    if ($root -match '(^|/)\.\.(/|$)' -or $root.Contains('\') -or $root.StartsWith('/')) {
      throw "unsafe candidate root"
    }
    $roots.Add($root)
    $rootKinds[$root] = $kind
    $rows.Add("$kind|$root|$treeHash")
    $kindCounts[$kind] = [int]$kindCounts[$kind] + 1
  }
  if (@($roots | Sort-Object -Unique).Count -ne $roots.Count) { throw "duplicate candidate root" }
  for ($leftIndex = 0; $leftIndex -lt $roots.Count; $leftIndex++) {
    for ($rightIndex = $leftIndex + 1; $rightIndex -lt $roots.Count; $rightIndex++) {
      if (& $rootsOverlap $roots[$leftIndex] $roots[$rightIndex]) {
        $leftRoot = $roots[$leftIndex]
        $rightRoot = $roots[$rightIndex]
        $allowedOverlayRelation =
          ($rootKinds[$leftRoot] -eq "old_research_spec_overlay" -and
            $rightRoot.StartsWith($leftRoot + "/", [StringComparison]::Ordinal)) -or
          ($rootKinds[$rightRoot] -eq "old_research_spec_overlay" -and
            $leftRoot.StartsWith($rightRoot + "/", [StringComparison]::Ordinal))
        if (-not $allowedOverlayRelation) { throw "overlapping candidate roots" }
      }
    }
  }
  foreach ($root in $roots) {
    foreach ($protectedRoot in $protected) {
      if (& $rootsOverlap $root $protectedRoot) {
        $allowedOverlayRelation = $rootKinds[$root] -eq "old_research_spec_overlay" -and
          $protectedRoot.StartsWith($root + "/", [StringComparison]::Ordinal)
        if (-not $allowedOverlayRelation) { throw "candidate overlaps protected root" }
      }
    }
  }
  $rows.Add("protected_base|$($protected[0])|$($protectedFingerprints[0])")
  $rows.Add("protected_expanded|$($protected[1])|$($protectedFingerprints[1])")
  $sortedRows = @($rows | Sort-Object)
  if ((Get-TextSha256 -Value ($sortedRows -join "`n")) -ne $ExpectedCandidateHash) {
    throw "candidate list hash mismatch"
  }
  if ($kindCounts.previous_release -ne [int]$ExpectedCounts.previous -or
      $kindCounts.rollback_state -ne [int]$ExpectedCounts.rollback -or
      ($kindCounts.old_research_spec + $kindCounts.old_research_spec_overlay) -ne [int]$ExpectedCounts.oldSpec -or
      $kindCounts.research_spec_backup -ne [int]$ExpectedCounts.specBackup) {
    throw "candidate kind count mismatch"
  }

  $manifestCount = 0
  $seenRoots = @{}
  $seenMembers = @{}
  $seenOverlayPaths = @{}
  $fullTreeRoots = @($roots | Where-Object { $rootKinds[$_] -ne "old_research_spec_overlay" })
  foreach ($rawMember in $members) {
    $member = ([string]$rawMember).TrimEnd('/')
    if ([string]::IsNullOrWhiteSpace($member) -or $member.StartsWith('/') -or $member.Contains('\')) {
      throw "unsafe tar member"
    }
    $segments = @($member -split '/')
    if ($segments -contains ".." -or $segments -contains "") { throw "unsafe tar member" }
    if ($seenMembers.ContainsKey($member)) { throw "duplicate tar member" }
    $seenMembers[$member] = $true
    if ($member -eq "archive_manifest.json") {
      $manifestCount += 1
      continue
    }
    if ($overlayPaths.ContainsKey($member)) {
      $overlayRoot = [string]$overlayPaths[$member]
      $seenRoots[$overlayRoot] = $true
      $seenOverlayPaths[$member] = $true
      continue
    }
    $matches = @($fullTreeRoots | Where-Object { $member -eq $_ -or $member.StartsWith($_ + "/", [StringComparison]::Ordinal) })
    if ($matches.Count -ne 1) { throw "tar member is outside candidate prefixes" }
    $seenRoots[$matches[0]] = $true
    if (($member -eq "export-ai-agent" -or $member.StartsWith("export-ai-agent/", [StringComparison]::Ordinal)) -and
        $rootKinds[$matches[0]] -notin @("old_research_spec", "research_spec_backup")) {
      throw "current application member is forbidden"
    }
    foreach ($protectedRoot in $protected) {
      if ($member -eq $protectedRoot -or $member.StartsWith($protectedRoot + "/", [StringComparison]::Ordinal)) {
        throw "protected current spec member is forbidden"
      }
    }
  }
  if ($manifestCount -ne 1 -or $seenRoots.Count -ne $roots.Count -or
      $seenOverlayPaths.Count -ne $overlayPaths.Count) {
    throw "tar roots are incomplete"
  }
  Test-ArchiveOverlayPayloads -ArchivePath $ArchivePath
}

$inventoryKeys = @(
  "ARCHIVE_PRUNE_STATUS",
  "SERVICE_HEALTH_BEFORE",
  "OUTBOUND_PAUSED_BEFORE",
  "CANDIDATE_COUNT",
  "PREVIOUS_RELEASE_COUNT",
  "ROLLBACK_STATE_COUNT",
  "OLD_RESEARCH_SPEC_COUNT",
  "RESEARCH_SPEC_BACKUP_COUNT",
  "CANDIDATE_LIST_SHA256",
  "SERVICE_HEALTH_AFTER",
  "OUTBOUND_PAUSED_AFTER"
)
$nonce = if ($modeState.Mode -eq "RESUME") { $modeState.Nonce } else { [guid]::NewGuid().ToString("N") }
$zeroHash = "0" * 64

if ($modeState.Mode -eq "INVENTORY") {
  $rawInventory = @(Invoke-RemotePhase -Mode "INVENTORY" -Nonce $nonce `
    -ExpectedCandidateHash $zeroHash -ExpectedArchiveHash $zeroHash -FailureStep "REMOTE_INVENTORY")
  $inventory = Read-FixedRemoteState -RawOutput $rawInventory -ExpectedKeys $inventoryKeys
  Assert-CommonRemoteState -State $inventory
  if ($inventory.ARCHIVE_PRUNE_STATUS -ne "INVENTORY") {
    Stop-ArchivePrune -Step "REMOTE_INVENTORY_ASSERT" -ExitCode 1
  }
  foreach ($key in $inventoryKeys) { [Console]::Out.WriteLine("$key=$($inventory[$key])") }
  exit 0
}

if (-not (Get-Command sftp -ErrorAction SilentlyContinue) -or
    -not (Get-Command tar -ErrorAction SilentlyContinue) -or
    @(Get-Command python3, python -ErrorAction SilentlyContinue | Select-Object -First 1).Count -ne 1) {
  Stop-ArchivePrune -Step "LOCAL_ARCHIVE_TOOLS" -ExitCode 2
}

$archiveKeys = @($inventoryKeys + "ARCHIVE_SHA256" + "ARCHIVE_SIZE")
$rawArchive = if ($modeState.Mode -eq "RESUME") {
  @(Invoke-RemotePhase -Mode "VERIFY_ARCHIVE" -Nonce $nonce `
    -ExpectedCandidateHash $modeState.CandidateHash `
    -ExpectedArchiveHash $modeState.ArchiveHash `
    -FailureStep "REMOTE_RESUME_ARCHIVE_VERIFY")
} else {
  @(Invoke-RemotePhase -Mode "ARCHIVE" -Nonce $nonce `
    -ExpectedCandidateHash $zeroHash -ExpectedArchiveHash $zeroHash -FailureStep "REMOTE_ARCHIVE")
}
$archiveState = Read-FixedRemoteState -RawOutput $rawArchive -ExpectedKeys $archiveKeys
Assert-CommonRemoteState -State $archiveState
if ($archiveState.ARCHIVE_PRUNE_STATUS -ne "ARCHIVED" -or
    ($modeState.Mode -eq "RESUME" -and (
      $archiveState.CANDIDATE_LIST_SHA256 -ne $modeState.CandidateHash -or
      $archiveState.ARCHIVE_SHA256 -ne $modeState.ArchiveHash))) {
  Stop-ArchivePrune -Step "REMOTE_ARCHIVE_ASSERT" -ExitCode 1
}

$workspaceRoot = [IO.Path]::GetFullPath($Workspace).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
$backupRoot = [IO.Path]::GetFullPath((Join-Path $Workspace "backups\server_old_versions"))
if (-not ($backupRoot + [IO.Path]::DirectorySeparatorChar).StartsWith($workspaceRoot, [StringComparison]::OrdinalIgnoreCase)) {
  Stop-ArchivePrune -Step "LOCAL_BACKUP_SCOPE" -ExitCode 2
}
try {
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  Set-PrivateLocalMode -Path $backupRoot -Mode "700"
} catch {
  Stop-ArchivePrune -Step "LOCAL_BACKUP_DIRECTORY" -ExitCode 3
}

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$finalArchive = Join-Path $backupRoot "server-old-versions-$stamp-$nonce.tar.gz"
$transferRoot = if ($modeState.Mode -eq "RESUME") {
  Get-ResumeTransferRoot -BackupRoot $backupRoot
} else {
  $backupRoot
}
$partialArchive = if ($modeState.Mode -eq "RESUME") {
  Join-Path $transferRoot "server-old-versions-resume-$nonce.tar.gz.partial"
} else {
  $finalArchive + ".partial"
}
$remoteArchive = "/tmp/export-ai-agent-old-versions-$nonce.tar.gz"
try {
  try {
    $downloadParameters = @{
      Remote = $remote
      RemoteArchive = $remoteArchive
      PartialArchive = $partialArchive
      ExpectedSha256 = [string]$archiveState.ARCHIVE_SHA256
      ExpectedSize = [long]$archiveState.ARCHIVE_SIZE
      SshArguments = $sshArguments
    }
    if ($modeState.Mode -ne "RESUME") { $downloadParameters["AllowSshFallback"] = $true }
    $transferMethod = Invoke-ResumableArchiveDownload @downloadParameters
  } catch {
    Stop-ArchivePrune -Step "ARCHIVE_DOWNLOAD" -ExitCode 124
  }
  Set-PrivateLocalMode -Path $partialArchive -Mode "600"
  $expectedCounts = @{
    previous = [int]$archiveState.PREVIOUS_RELEASE_COUNT
    rollback = [int]$archiveState.ROLLBACK_STATE_COUNT
    oldSpec = [int]$archiveState.OLD_RESEARCH_SPEC_COUNT
    specBackup = [int]$archiveState.RESEARCH_SPEC_BACKUP_COUNT
  }
  try {
    Test-DownloadedArchive `
      -ArchivePath $partialArchive `
      -ExpectedArchiveHash $archiveState.ARCHIVE_SHA256 `
      -ExpectedCandidateHash $archiveState.CANDIDATE_LIST_SHA256 `
      -ExpectedCandidateCount ([int]$archiveState.CANDIDATE_COUNT) `
      -ExpectedCounts $expectedCounts
  } catch {
    Stop-ArchivePrune -Step "LOCAL_ARCHIVE_VERIFICATION" -ExitCode 4
  }
  Move-Item -LiteralPath $partialArchive -Destination $finalArchive
  Set-PrivateLocalMode -Path $finalArchive -Mode "600"
} catch {
  Stop-ArchivePrune -Step "LOCAL_ARCHIVE_STORAGE" -ExitCode 4
} finally {
  if ($modeState.Mode -ne "RESUME" -and (Test-Path -LiteralPath $partialArchive)) {
    Remove-Item -LiteralPath $partialArchive -Force -ErrorAction SilentlyContinue
  }
}

$pruneKeys = @(
  "ARCHIVE_PRUNE_STATUS",
  "SERVICE_HEALTH_BEFORE",
  "OUTBOUND_PAUSED_BEFORE",
  "CANDIDATE_COUNT",
  "DELETED_COUNT",
  "CANDIDATE_LIST_SHA256",
  "ARCHIVE_SHA256",
  "ARCHIVE_SIZE",
  "REMOTE_ARCHIVE_REMOVED",
  "SERVICE_HEALTH_AFTER",
  "OUTBOUND_PAUSED_AFTER"
)
$rawPrune = @(Invoke-RemotePhase -Mode "PRUNE" -Nonce $nonce `
  -ExpectedCandidateHash $archiveState.CANDIDATE_LIST_SHA256 `
  -ExpectedArchiveHash $archiveState.ARCHIVE_SHA256 `
  -FailureStep "REMOTE_PRUNE")
$pruneState = Read-FixedRemoteState -RawOutput $rawPrune -ExpectedKeys $pruneKeys
Assert-CommonRemoteState -State $pruneState
if ($pruneState.ARCHIVE_PRUNE_STATUS -ne "PRUNED" -or
    $pruneState.REMOTE_ARCHIVE_REMOVED -ne "true" -or
    $pruneState.CANDIDATE_LIST_SHA256 -ne $archiveState.CANDIDATE_LIST_SHA256 -or
    $pruneState.ARCHIVE_SHA256 -ne $archiveState.ARCHIVE_SHA256 -or
    $pruneState.ARCHIVE_SIZE -ne $archiveState.ARCHIVE_SIZE -or
    $pruneState.CANDIDATE_COUNT -ne $archiveState.CANDIDATE_COUNT -or
    $pruneState.DELETED_COUNT -ne $archiveState.CANDIDATE_COUNT) {
  Stop-ArchivePrune -Step "REMOTE_PRUNE_ASSERT" -ExitCode 1
}

$resumeMarker = ($modeState.Mode -eq "RESUME").ToString().ToLowerInvariant()
[Console]::Out.WriteLine("ARCHIVE_PRUNE_STATUS=PASS")
[Console]::Out.WriteLine("CANDIDATE_COUNT=$($archiveState.CANDIDATE_COUNT)")
[Console]::Out.WriteLine("PREVIOUS_RELEASE_COUNT=$($archiveState.PREVIOUS_RELEASE_COUNT)")
[Console]::Out.WriteLine("ROLLBACK_STATE_COUNT=$($archiveState.ROLLBACK_STATE_COUNT)")
[Console]::Out.WriteLine("OLD_RESEARCH_SPEC_COUNT=$($archiveState.OLD_RESEARCH_SPEC_COUNT)")
[Console]::Out.WriteLine("RESEARCH_SPEC_BACKUP_COUNT=$($archiveState.RESEARCH_SPEC_BACKUP_COUNT)")
[Console]::Out.WriteLine("DELETED_COUNT=$($pruneState.DELETED_COUNT)")
[Console]::Out.WriteLine("CANDIDATE_LIST_SHA256=$($archiveState.CANDIDATE_LIST_SHA256)")
[Console]::Out.WriteLine("ARCHIVE_SHA256=$($archiveState.ARCHIVE_SHA256)")
[Console]::Out.WriteLine("ARCHIVE_SIZE=$($archiveState.ARCHIVE_SIZE)")
[Console]::Out.WriteLine("RESUME_EXISTING_ARCHIVE=$resumeMarker")
[Console]::Out.WriteLine("ARCHIVE_REUSED=$resumeMarker")
[Console]::Out.WriteLine("TRANSFER_METHOD=$transferMethod")
[Console]::Out.WriteLine("LOCAL_ARCHIVE_VERIFIED=true")
[Console]::Out.WriteLine("REMOTE_ARCHIVE_REMOVED=true")
[Console]::Out.WriteLine("SERVICE_HEALTH_BEFORE=PASS")
[Console]::Out.WriteLine("OUTBOUND_PAUSED_BEFORE=true")
[Console]::Out.WriteLine("SERVICE_HEALTH_AFTER=PASS")
[Console]::Out.WriteLine("OUTBOUND_PAUSED_AFTER=true")
exit 0
