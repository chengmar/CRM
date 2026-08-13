#!/usr/bin/env bash
set -euo pipefail

CREDENTIAL_FILE="${1:-}"
CADDY_IMAGE="${CADDY_IMAGE:-caddy:2.10.2-alpine}"
CONTAINER_NAME="export-ai-agent-dashboard-proxy"
STATE_DIR="${DASHBOARD_PROXY_STATE_DIR:-$HOME/.local/share/export-ai-agent-dashboard-proxy}"

if [[ "${EUID}" -eq 0 ]]; then
  ROOT=()
else
  if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1; then
    echo "[FAIL] Run as root or configure passwordless sudo." >&2
    exit 1
  fi
  ROOT=(sudo -n)
fi

run_root() {
  "${ROOT[@]}" "$@"
}

if [[ -z "${CREDENTIAL_FILE}" || ! -f "${CREDENTIAL_FILE}" || -L "${CREDENTIAL_FILE}" ]]; then
  echo "[FAIL] A private dashboard credential file is required." >&2
  exit 1
fi
if [[ "$(stat -c %a "${CREDENTIAL_FILE}")" != "600" ]]; then
  echo "[FAIL] Dashboard credential file must have mode 600." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v ss >/dev/null 2>&1; then
  echo "[FAIL] docker, curl, and ss are required." >&2
  exit 1
fi

mapfile -t credentials <"${CREDENTIAL_FILE}"
dashboard_host="${credentials[0]:-}"
dashboard_user="${credentials[1]:-}"
dashboard_password="${credentials[2]:-}"
if [[ ! "${dashboard_host}" =~ ^[a-z0-9.-]+$ || ! "${dashboard_user}" =~ ^[A-Za-z0-9._-]{3,64}$ ||
      ${#dashboard_password} -lt 20 || ${#dashboard_password} -gt 200 ]]; then
  echo "[FAIL] Dashboard credentials are invalid." >&2
  exit 1
fi

if [[ "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18790/dashboard)" != "200" ]]; then
  echo "[FAIL] The private Agent dashboard is not healthy." >&2
  exit 1
fi

if run_root docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  run_root docker rm -f "${CONTAINER_NAME}" >/dev/null
fi
if ss -H -ltn '( sport = :80 or sport = :443 )' | grep -q .; then
  echo "[FAIL] Port 80 or 443 is already occupied by another service." >&2
  exit 1
fi

mkdir -p "${STATE_DIR}/data" "${STATE_DIR}/config"
chmod 700 "${STATE_DIR}" "${STATE_DIR}/data" "${STATE_DIR}/config"
password_hash="$(printf '%s\n' "${dashboard_password}" |
  run_root docker run --rm -i "${CADDY_IMAGE}" caddy hash-password 2>/dev/null | tail -n 1)"
if [[ ! "${password_hash}" =~ ^\$2[aby]\$ ]]; then
  echo "[FAIL] Caddy password hashing failed." >&2
  exit 1
fi

umask 077
cat >"${STATE_DIR}/Caddyfile" <<EOF
${dashboard_host} {
  encode zstd gzip

  route {
    @dashboard path /dashboard /dashboard/* /api/dashboard/*
    basic_auth @dashboard {
      ${dashboard_user} ${password_hash}
    }
    header @dashboard {
      Cache-Control "no-store"
      Referrer-Policy "no-referrer"
      X-Content-Type-Options "nosniff"
      X-Frame-Options "DENY"
    }
    reverse_proxy @dashboard 127.0.0.1:18790

    respond 404
  }
}
EOF

run_root docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  --network host \
  --label com.example.export-ai-agent.component=dashboard-proxy \
  -v "${STATE_DIR}/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "${STATE_DIR}/data:/data" \
  -v "${STATE_DIR}/config:/config" \
  "${CADDY_IMAGE}" >/dev/null

curl_config="$(mktemp)"
trap 'rm -f -- "${curl_config}"' EXIT
chmod 600 "${curl_config}"
printf 'user = "%s:%s"\n' "${dashboard_user}" "${dashboard_password}" >"${curl_config}"

unauthorized_code=""
authorized_code=""
for _ in $(seq 1 60); do
  unauthorized_code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 \
    --resolve "${dashboard_host}:443:127.0.0.1" \
    "https://${dashboard_host}/dashboard" 2>/dev/null || true)"
  authorized_code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 \
    --resolve "${dashboard_host}:443:127.0.0.1" \
    --config "${curl_config}" "https://${dashboard_host}/dashboard" 2>/dev/null || true)"
  if [[ "${unauthorized_code}" == "401" && "${authorized_code}" == "200" ]]; then
    break
  fi
  sleep 3
done

if [[ "${unauthorized_code}" != "401" || "${authorized_code}" != "200" ]]; then
  run_root docker logs --tail 30 "${CONTAINER_NAME}" 2>&1 |
    sed -E 's/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/[redacted-email]/g' >&2 || true
  echo "[FAIL] Public HTTPS dashboard verification failed." >&2
  exit 1
fi

echo "DASHBOARD_PROXY_STATUS=READY"
echo "DASHBOARD_PROXY_AUTH=REQUIRED"
echo "DASHBOARD_PROXY_TLS=VALID"
