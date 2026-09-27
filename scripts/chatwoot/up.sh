#!/usr/bin/env bash
# Starts Chatwoot CE v4.18.0 and connects it to Hamnivo:
#   1. database and Valkey, 2. schema (db:chatwoot_prepare), 3. web + sidekiq,
#   4. super admin + "Hamnivo" Platform App, 5. the Platform App token.
#
#   pnpm chatwoot:up                         development stack; settings and the token live in .env.local
#   scripts/chatwoot/up.sh --ephemeral       throwaway stack for checks: settings come from the
#                                            environment (COMPOSE_PROJECT_NAME, CHATWOOT_PORT, CHATWOOT_URL,
#                                            CHATWOOT_SECRET_KEY_BASE, CHATWOOT_DB_PASSWORD, CHATWOOT_ADMIN_EMAIL,
#                                            CHATWOOT_ADMIN_PASSWORD) and the token is printed to stdout
# Idempotent. Preparing a new database takes about 1–2 minutes.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ephemeral=0
[[ "${1:-}" == "--ephemeral" ]] && ephemeral=1
if ((ephemeral == 0)); then
  bash "$root/scripts/setup/env.sh" >/dev/null
  set -a
  # shellcheck disable=SC1091
  source "$root/.env.local"
  set +a
fi
: "${CHATWOOT_PORT:=3000}"
compose=(docker compose -f "$root/deploy/compose/chatwoot.yml")
log() { printf '\033[1;36m[chatwoot]\033[0m %s\n' "$*" >&2; }
prepare_log="$(mktemp)"
trap 'rm -f "$prepare_log"' EXIT

log "Starting database and Valkey"
"${compose[@]}" up -d --wait chatwoot-db chatwoot-redis >&2

log "Preparing the Chatwoot database (creates or migrates the schema)"
"${compose[@]}" run --rm --no-deps chatwoot-web bundle exec rails db:chatwoot_prepare >"$prepare_log" 2>&1 ||
  { tail -40 "$prepare_log" >&2; exit 1; }

log "Starting web and sidekiq"
"${compose[@]}" up -d chatwoot-web chatwoot-sidekiq >&2
for _ in $(seq 1 90); do
  curl -sf "http://127.0.0.1:${CHATWOOT_PORT}/api" >/dev/null && break
  sleep 2
done
curl -sf "http://127.0.0.1:${CHATWOOT_PORT}/api" >/dev/null || { "${compose[@]}" logs --tail 60 chatwoot-web >&2; exit 1; }

log "Creating the super admin and the Hamnivo Platform App"
token="$("${compose[@]}" exec -T \
  -e HV_ADMIN_EMAIL="$CHATWOOT_ADMIN_EMAIL" -e HV_ADMIN_PASSWORD="$CHATWOOT_ADMIN_PASSWORD" \
  chatwoot-web bundle exec rails runner - <"$root/scripts/chatwoot/bootstrap.rb" | grep '^HAMNIVO_PLATFORM_TOKEN=' | tail -1 | cut -d= -f2)"
[[ -n "$token" ]] || { log "Could not read the Platform App token"; exit 1; }

version="$(curl -sf "http://127.0.0.1:${CHATWOOT_PORT}/api" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
if ((ephemeral == 1)); then
  log "Chatwoot ${version:-?} is ready on port ${CHATWOOT_PORT}"
  printf 'CHATWOOT_PLATFORM_TOKEN=%s\n' "$token"
  exit 0
fi

file="$root/.env.local"
tmp="$(mktemp)"
grep -v '^CHATWOOT_PLATFORM_TOKEN=' "$file" >"$tmp" || true
printf 'CHATWOOT_PLATFORM_TOKEN=%s\n' "$token" >>"$tmp"
cat "$tmp" >"$file"
rm -f "$tmp"
log "Chatwoot ${version:-?} is ready at ${CHATWOOT_URL} (super admin: ${CHATWOOT_ADMIN_EMAIL}; password in .env.local)."
