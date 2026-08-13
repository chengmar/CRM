#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/export-ai-agent}"
ENABLE_SELF_HOSTED_REACHER="${ENABLE_SELF_HOSTED_REACHER:-false}"
COMPOSE_FILE="${APP_DIR}/infra/support-services.compose.yml"
RUNTIME_DIR="${APP_DIR}/infra/runtime/searxng"
SETTINGS_FILE="${RUNTIME_DIR}/settings.yml"
SEARXNG_CHECK="/tmp/export-agent-searxng-check.$$"
REACHER_CHECK="/tmp/export-agent-reacher-check.$$"

cleanup() {
  rm -f -- "${SEARXNG_CHECK}" "${REACHER_CHECK}"
}
trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1; then
  echo "[FAIL] Docker is required for Agent support services." >&2
  exit 1
fi
if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  DOCKER=(sudo -n docker)
else
  echo "[FAIL] Docker is installed but unavailable to this user and passwordless sudo cannot access it." >&2
  exit 1
fi
if ! "${DOCKER[@]}" compose version >/dev/null 2>&1; then
  echo "[FAIL] Docker Compose plugin is required." >&2
  exit 1
fi
if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "[FAIL] Support services compose file is missing: ${COMPOSE_FILE}" >&2
  exit 1
fi

mkdir -p "${RUNTIME_DIR}"
if [[ ! -f "${SETTINGS_FILE}" ]]; then
  secret="$(openssl rand -hex 32)"
  cat >"${SETTINGS_FILE}" <<EOF
use_default_settings: true

general:
  debug: false
  instance_name: "CRM Export Agent Search"

search:
  safe_search: 0
  autocomplete: ""
  formats:
    - html
    - json

engines:
  # These general-web engines were verified from the production VPS. Keep
  # known throttled, CAPTCHA, protocol-error, or query-corrupting engines out
  # of the default acquisition path.
  - name: mojeek
    disabled: false
  - name: presearch
    disabled: false
  - name: dogpile
    disabled: false
  - name: yandex
    disabled: false
  - name: bing
    disabled: true
  - name: yahoo
    disabled: true
  - name: brave
    disabled: true
  - name: duckduckgo
    disabled: true
  - name: google cse
    disabled: true
  - name: startpage
    disabled: true

server:
  bind_address: "0.0.0.0"
  port: 8080
  secret_key: "${secret}"
  limiter: false
  image_proxy: false
EOF
  chmod 600 "${SETTINGS_FILE}"
fi

"${DOCKER[@]}" compose -f "${COMPOSE_FILE}" pull searxng
"${DOCKER[@]}" compose -f "${COMPOSE_FILE}" up -d --remove-orphans searxng

search_ready=false
search_results=0
search_relevant=false
for _ in $(seq 1 30); do
  if curl -fsS --max-time 15 "http://127.0.0.1:8888/search?q=sample+product+supplier+Malaysia&format=json" >"${SEARXNG_CHECK}"; then
    search_ready=true
    search_results="$(node -e 'const fs=require("fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(Array.isArray(v.results)?v.results.length:0))' "${SEARXNG_CHECK}")"
    search_relevant="$(node -e 'const fs=require("fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const text=(Array.isArray(v.results)?v.results:[]).slice(0,20).map((x)=>`${x.title||""} ${x.url||""}`).join(" ").toLowerCase();process.stdout.write(String(text.includes("product")&&(text.includes("malaysia")||text.includes(".my/"))))' "${SEARXNG_CHECK}")"
    if [[ "${search_results}" -ge 1 && "${search_relevant}" == "true" ]]; then
      break
    fi
  fi
  sleep 2
done
if [[ "${search_ready}" != "true" ]]; then
  "${DOCKER[@]}" compose -f "${COMPOSE_FILE}" ps
  "${DOCKER[@]}" compose -f "${COMPOSE_FILE}" logs --tail 80 searxng
  echo "[FAIL] SearXNG JSON endpoint did not become ready." >&2
  exit 1
fi

if [[ "${search_results}" -lt 1 || "${search_relevant}" != "true" ]]; then
  echo "[FAIL] SearXNG endpoint is ready but did not return relevant industrial acquisition results." >&2
  exit 1
else
  echo "[OK] SearXNG ready on 127.0.0.1:8888; test_results=${search_results}; relevant=true"
fi

if [[ "${ENABLE_SELF_HOSTED_REACHER}" == "true" ]]; then
  "${DOCKER[@]}" compose -f "${COMPOSE_FILE}" --profile deep-email-verification pull reacher
  "${DOCKER[@]}" compose -f "${COMPOSE_FILE}" --profile deep-email-verification up -d reacher
  reacher_ready=false
  for _ in $(seq 1 15); do
    status="$(curl -sS --max-time 10 -o "${REACHER_CHECK}" -w '%{http_code}' \
      -X POST "http://127.0.0.1:8081/v0/check_email" \
      -H "Content-Type: application/json" \
      --data '{"to_email":"invalid-address"}' || true)"
    if [[ "${status}" == "200" ]]; then
      reacher_ready=true
      break
    fi
    sleep 2
  done
  if [[ "${reacher_ready}" != "true" ]]; then
    echo "[FAIL] Reacher API did not become ready." >&2
    exit 1
  fi
  echo "[WARN] Reacher API is running, but production SMTP verification still requires confirmed outbound TCP 25."
else
  "${DOCKER[@]}" compose -f "${COMPOSE_FILE}" --profile deep-email-verification stop reacher >/dev/null 2>&1 || true
  "${DOCKER[@]}" compose -f "${COMPOSE_FILE}" --profile deep-email-verification rm -f reacher >/dev/null 2>&1 || true
  echo "[WARN] Self-hosted Reacher disabled; configure an external Reacher-compatible verifier for production."
fi
"${DOCKER[@]}" compose -f "${COMPOSE_FILE}" ps
