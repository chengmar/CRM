#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/export-ai-agent}"
OPENAI_BASE_URL="${OPENAI_BASE_URL:-}"
OPENAI_MODEL="${OPENAI_MODEL:-}"
HERMES_COMMIT="46e87b14fd6c943ef0d6671fb0d74c5dde5d4c6b"
HERMES_INSTALLER_SHA256="c2e4326c1660bd45f64321996eb15bda35e7a4649e32a310495a61972a2804c8"
OPENCLAW_VERSION="2026.7.1"

if [[ "${EUID}" -eq 0 ]]; then
  ROOT=()
else
  if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1; then
    echo "[FAIL] Run as root or configure passwordless sudo for the deployment user." >&2
    exit 1
  fi
  ROOT=(sudo -n)
fi

run_root() {
  "${ROOT[@]}" "$@"
}

. /etc/os-release
if [[ "${ID:-}" != "ubuntu" || ! "${VERSION_ID:-}" =~ ^(22\.04|24\.04)$ ]]; then
  echo "[FAIL] Ubuntu 22.04 or 24.04 is required; detected ${ID:-unknown} ${VERSION_ID:-unknown}." >&2
  exit 1
fi

echo "== Export AI agent VPS bootstrap =="
echo "App dir: ${APP_DIR}"
echo "Relay: ${OPENAI_BASE_URL}"
echo "Model: ${OPENAI_MODEL}"
echo "Safety: external sending remains confirmation-gated"

base_runtime_ready=true
for required_command in curl gpg git jq node npm python3 pip3 unzip xz cc make openssl; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    base_runtime_ready=false
    break
  fi
done
if [[ ! -s /etc/ssl/certs/ca-certificates.crt ]]; then
  base_runtime_ready=false
fi

if [[ "${base_runtime_ready}" != "true" ]]; then
  run_root apt-get update
  run_root apt-get install -y \
    ca-certificates \
    curl \
    gpg \
    git \
    jq \
    nodejs \
    npm \
    python3 \
    python3-pip \
    python3-venv \
    unzip \
    xz-utils \
    build-essential \
    openssl
else
  echo "[OK] Base VPS runtime is already installed; skipping OS package refresh."
fi

NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
fi
if [[ "${NODE_MAJOR}" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | run_root bash -
  run_root apt-get install -y nodejs
fi

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo ""
  echo "== Docker Engine and Compose =="
  run_root install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | run_root tee /etc/apt/keyrings/docker.asc >/dev/null
  run_root chmod a+r /etc/apt/keyrings/docker.asc
  DOCKER_ARCH="$(dpkg --print-architecture)"
  DOCKER_CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME}}"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
    "${DOCKER_ARCH}" "${DOCKER_CODENAME}" | run_root tee /etc/apt/sources.list.d/docker.list >/dev/null
  run_root apt-get update
  run_root apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
run_root systemctl enable --now docker
if [[ "${EUID}" -ne 0 ]] && ! id -nG | tr ' ' '\n' | grep -qx docker; then
  run_root usermod -aG docker "$(id -un)"
fi
if docker info >/dev/null 2>&1; then
  docker version --format 'Docker client={{.Client.Version}} server={{.Server.Version}}'
elif run_root docker info >/dev/null 2>&1; then
  run_root docker version --format 'Docker client={{.Client.Version}} server={{.Server.Version}}'
else
  echo "[FAIL] Docker daemon is installed but not reachable." >&2
  exit 1
fi
if docker compose version >/dev/null 2>&1; then
  docker compose version
else
  run_root docker compose version
fi

if ! command -v pwsh >/dev/null 2>&1; then
  MS_DEB="/tmp/packages-microsoft-prod.deb"
  curl -fsSL "https://packages.microsoft.com/config/ubuntu/${VERSION_ID}/packages-microsoft-prod.deb" -o "${MS_DEB}"
  run_root dpkg -i "${MS_DEB}"
  rm -f "${MS_DEB}"
  run_root apt-get update
  run_root apt-get install -y powershell
fi

if ! command -v powershell >/dev/null 2>&1; then
  run_root tee /usr/local/bin/powershell >/dev/null <<'SH'
#!/usr/bin/env bash
exec pwsh "$@"
SH
  run_root chmod +x /usr/local/bin/powershell
fi

mkdir -p "${APP_DIR}"

ARTIFACT_TOOL_DIR="${APP_DIR}/workbook_build/node_modules/@oai/artifact-tool"
if [[ -d "${ARTIFACT_TOOL_DIR}" ]]; then
  echo ""
  echo "== Workbook native dependencies =="
  SKIA_NODE="${ARTIFACT_TOOL_DIR}/node_modules/skia-canvas/lib/skia.node"
  if [[ -f "${SKIA_NODE}" ]] && file "${SKIA_NODE}" | grep -Eiq 'PE32|Windows|MS Windows'; then
    echo "Replacing Windows skia-canvas binary with Linux build"
    rm -rf "${ARTIFACT_TOOL_DIR}/node_modules/skia-canvas"
  fi
  (
    cd "${ARTIFACT_TOOL_DIR}"
    npm install skia-canvas@3.0.8 --no-save --ignore-scripts=false
    node --input-type=module -e 'await import("skia-canvas"); console.log("skia-canvas ok")'
  )
fi

if ! command -v hermes >/dev/null 2>&1; then
  HERMES_INSTALLER="/tmp/hermes-agent-install.sh"
  curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o "${HERMES_INSTALLER}"
  printf '%s  %s\n' "${HERMES_INSTALLER_SHA256}" "${HERMES_INSTALLER}" | sha256sum -c -
  bash "${HERMES_INSTALLER}" --commit "${HERMES_COMMIT}" --skip-setup --non-interactive
  rm -f "${HERMES_INSTALLER}"
  export PATH="$HOME/.local/bin:$PATH"
  if ! grep -q 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.bashrc" 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
  fi
fi

if ! command -v openclaw >/dev/null 2>&1; then
  run_root npm install -g "openclaw@${OPENCLAW_VERSION}"
fi

ENV_FILE="${APP_DIR}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  {
    echo "DEPLOYMENT_MODE=vps"
    echo "OPENAI_BASE_URL=${OPENAI_BASE_URL}"
    echo "OPENAI_MODEL=${OPENAI_MODEL}"
    echo "OPENAI_API_KEY=${OPENAI_API_KEY:-}"
    echo "EMAIL_OUTREACH_ENABLED=false"
    echo "EMAIL_SEND_REQUIRES_CONFIRMATION=true"
    echo "SPREADSHEET_WRITE_REQUIRES_CONFIRMATION=true"
    echo "EXTERNAL_SEND_REQUIRES_CONFIRMATION=true"
    echo "USE_PUBLIC_DATA_ONLY=true"
    echo "REQUIRE_SOURCE_URL_FOR_COMPANY_FACTS=true"
    echo "REQUIRE_HUMAN_APPROVAL_BEFORE_SEND=true"
  } > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
fi

echo ""
echo "== Versions =="
hermes --version || true
openclaw --version || true
node --version || true
python3 --version || true
pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()' || true
if docker compose version >/dev/null 2>&1; then
  docker compose version || true
else
  run_root docker compose version || true
fi

echo ""
echo "[OK] VPS runtime bootstrap complete. The installer will continue with support services and Agent activation."
