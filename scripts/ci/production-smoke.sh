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
# stream, the website and Studio, then a backup and restore drill (which must keep a customer's
# consent withdrawal and memory erasure made after the backup). Then a new owner uses Studio in
# Chromium: sign-up, a brand, the Chatwoot connection and an agent draft, all across origins. Then
# `hamnivo.sh mail`, which shows the emails written to the API log while SMTP is not set. Last,
# visitor addresses: the API never believes an address a visitor claims, only one reported by a
# trusted proxy (as with Cloudflare), and the edge runs with Cloudflare's ranges.
# HAMNIVO_BUILD_CA and HAMNIVO_BUILD_NETWORK are passed to the image builds (see
# deploy/production/hamnivo.sh).
set -euo pipefail
# Compose takes settings from this shell too: the stacks never call the real Jev.
unset TYPESAFE_API_KEY TYPESAFE_BASE_URL JEV_API_KEY JEV_BASE_URL

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
# the compose network because *.localhost has no public address. No AI provider key either, so the
# agent answers with the offline test model, which production refuses to publish unless allowed.
set_env REQUIRE_EMAIL_VERIFICATION false
set_env CHATWOOT_WEBHOOK_BASE_URL http://api:4000
set_env CHATWOOT_ALLOW_PRIVATE_WEBHOOKS true
set_env ALLOW_MOCK_MODEL true
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

env_value() { sed -n "s/^$1=//p" "$HAMNIVO_ENV_FILE" | tail -1 | sed 's/^"\(.*\)"$/\1/'; }
echo 'Studio in a browser'
SMOKE_APP_ORIGIN="$(env_value HAMNIVO_APP_ORIGIN)" SMOKE_API_ORIGIN="$(env_value HAMNIVO_API_ORIGIN)" \
  SMOKE_CHAT_ORIGIN="$(env_value HAMNIVO_CHAT_ORIGIN)" \
  pnpm --filter @hamnivo/console exec playwright test --config playwright.production.config.ts

echo 'Emails without SMTP'
# The smoke stack has no SMTP_URL, so sign-up emails went to the API log: `mail` must show them.
if bash "$hamnivo" mail | grep -q '/api/auth/verify-email?token='; then
  printf '  ok   hamnivo.sh mail shows the link that confirms an account\n'
else
  printf '  FAIL hamnivo.sh mail shows no link that confirms an account\n' >&2
  exit 1
fi

echo 'Visitor addresses'
api_origin="$(env_value HAMNIVO_API_ORIGIN)"
api_host="${api_origin#https://}"
api_host="${api_host%%:*}"
https_port="$(env_value HAMNIVO_HTTPS_PORT)"
# Calls the API through the edge with a request id, then prints the address the API logged for it.
seen_by_api() { # seen_by_api REQUEST_ID [CURL_ARGS...]
  local seen=''
  curl -fsS -o /dev/null --max-time 10 --cacert "$work/caddy-root.crt" \
    --resolve "$api_host:$https_port:127.0.0.1" -H "x-request-id: $1" "${@:2}" "$api_origin/health/live"
  for _ in $(seq 1 20); do
    seen="$(bash "$hamnivo" compose logs --no-log-prefix api 2>/dev/null | grep -F "\"reqId\":\"$1\"" |
      grep -o '"remoteAddress":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
    [[ -n "$seen" ]] && break
    sleep 0.5
  done
  printf '%s' "$seen"
}
expect_address() { # expect_address WHAT ACTUAL EXPECTED
  if [[ -n "$2" && "$2" == "$3" ]]; then
    printf '  ok   %s (%s)\n' "$1" "$2"
  else
    printf '  FAIL %s: the API saw %s, expected %s\n' "$1" "${2:-nothing}" "$3" >&2
    exit 1
  fi
}
direct="$(seen_by_api smoke-address-direct)"
expect_address 'a visitor cannot claim an address' \
  "$(seen_by_api smoke-address-claimed -H 'CF-Connecting-IP: 203.0.113.9' -H 'X-Forwarded-For: 203.0.113.9')" "$direct"
# The Docker network stands in for Cloudflare: its connections are now a trusted proxy's.
set_env HAMNIVO_TRUSTED_PROXIES private_ranges
bash "$hamnivo" up --no-build --quiet
expect_address "a trusted proxy's CF-Connecting-IP is believed" \
  "$(seen_by_api smoke-address-proxy -H 'CF-Connecting-IP: 203.0.113.9')" 203.0.113.9
expect_address 'from its X-Forwarded-For, only the address the proxy added counts' \
  "$(seen_by_api smoke-address-chain -H 'X-Forwarded-For: 198.51.100.4, 203.0.113.10')" 203.0.113.10
# Cloudflare on, with cloudflare.com out of reach: the ranges this version knows, which Caddy must
# accept; this machine is not Cloudflare, so claims are ignored again.
HAMNIVO_CLOUDFLARE_IPS_URL=http://127.0.0.1:9 bash "$hamnivo" setup --cloudflare on --quiet 2>/dev/null
bash "$hamnivo" up --no-build --quiet
expect_address "with Cloudflare's $(env_value HAMNIVO_TRUSTED_PROXIES | wc -w) ranges, a claim from elsewhere is ignored" \
  "$(seen_by_api smoke-address-cloudflare -H 'CF-Connecting-IP: 203.0.113.9')" "$direct"
