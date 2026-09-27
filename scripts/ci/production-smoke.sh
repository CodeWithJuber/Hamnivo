#!/usr/bin/env bash
# Production smoke test: the real deployment (deploy/production) on this machine, in its own
# compose project with its own image tag, using Caddy's internal CA instead of Let's Encrypt.
# Everything it creates is deleted afterwards, volumes included.
#
#   bash scripts/ci/production-smoke.sh           build the images and check the stack
#   bash scripts/ci/production-smoke.sh --keep    leave the stack running afterwards
#   SMOKE_CLAMAV=1 ...                            include ClamAV (downloads its signatures)
#
# Checks: HTTPS on every name, staff sign-up, a brand connected to the real Chatwoot, publishing
# the AI agent, the widget's frame policy, a customer conversation answered by the AI over the live
# stream, the website, then a backup and restore drill. HAMNIVO_BUILD_CA and HAMNIVO_BUILD_NETWORK
# are passed to the image builds (see deploy/production/hamnivo.sh).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
keep=0
[[ "${1:-}" == --keep ]] && keep=1

work="$(mktemp -d)"
export HAMNIVO_ENV_FILE="$work/.env"
export HAMNIVO_PROJECT="hamnivo-smoke-$$"
export HAMNIVO_IMAGE_TAG=smoke
export HAMNIVO_WAIT_SECONDS="${HAMNIVO_WAIT_SECONDS:-1200}"
hamnivo="$root/deploy/production/hamnivo.sh"

cleanup() {
  if ((keep == 0)); then
    bash "$hamnivo" compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$work"
  else
    printf 'Left running: HAMNIVO_ENV_FILE=%s HAMNIVO_PROJECT=%s %s status\n' \
      "$HAMNIVO_ENV_FILE" "$HAMNIVO_PROJECT" "$hamnivo" >&2
  fi
}
trap cleanup EXIT

free_port() {
  node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })'
}

set_env() {
  local tmp
  tmp="$(mktemp)"
  K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$HAMNIVO_ENV_FILE" >"$tmp"
  cat "$tmp" >"$HAMNIVO_ENV_FILE"
  rm -f "$tmp"
}

bash "$hamnivo" setup --domain hamnivo.localhost --tls internal \
  --https-port "$(free_port)" --http-port "$(free_port)" 2>/dev/null
# Test settings: no inbox to click a verification link in, and Chatwoot reaches the gateway over
# the compose network because *.localhost has no public address.
set_env REQUIRE_EMAIL_VERIFICATION false
set_env CHATWOOT_WEBHOOK_BASE_URL http://api:4000
set_env CHATWOOT_ALLOW_PRIVATE_WEBHOOKS true
if [[ "${SMOKE_CLAMAV:-0}" != 1 ]]; then
  set_env COMPOSE_PROFILES ''
  set_env CLAMAV_URL ''
fi

bash "$hamnivo" up

edge="$(bash "$hamnivo" compose ps -q edge)"
for _ in $(seq 1 30); do
  docker cp "$edge:/data/caddy/pki/authorities/local/root.crt" "$work/caddy-root.crt" 2>/dev/null && break
  sleep 2
done
[[ -s "$work/caddy-root.crt" ]] || { echo 'Caddy did not create its internal CA' >&2; exit 1; }

pnpm exec tsx "$root/scripts/ci/production-smoke.ts" "$HAMNIVO_ENV_FILE" "$work/caddy-root.crt" "$hamnivo"
