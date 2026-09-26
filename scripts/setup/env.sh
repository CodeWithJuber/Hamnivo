#!/usr/bin/env bash
# Creates or completes .env.local with generated secrets. Existing values are never overwritten,
# so it is safe to re-run after pulling changes. .env.local is gitignored: never commit it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
file="${HAMNIVO_ENV_FILE:-$root/.env.local}"
umask 077
touch "$file"

has() { grep -q "^$1=" "$file"; }
get() { grep "^$1=" "$file" | tail -1 | cut -d= -f2-; }
ensure() { has "$1" || printf '%s=%s\n' "$1" "$2" >>"$file"; }
hex() { openssl rand -hex 24; }
b64() { openssl rand -base64 32; }

ensure NODE_ENV development
ensure HAMNIVO_DB_HOST 127.0.0.1
ensure HAMNIVO_DB_PORT 5432
ensure HAMNIVO_DB_SUPERUSER_PASSWORD "$(hex)"
ensure HAMNIVO_DB_OWNER_PASSWORD "$(hex)"
ensure HAMNIVO_DB_APP_PASSWORD "$(hex)"
ensure HAMNIVO_DB_PLATFORM_PASSWORD "$(hex)"
ensure HAMNIVO_VALKEY_PORT 6379

host="$(get HAMNIVO_DB_HOST)"
port="$(get HAMNIVO_DB_PORT)"
ensure DATABASE_URL "postgres://hamnivo_app:$(get HAMNIVO_DB_APP_PASSWORD)@$host:$port/hamnivo"
ensure DATABASE_OWNER_URL "postgres://hamnivo_owner:$(get HAMNIVO_DB_OWNER_PASSWORD)@$host:$port/hamnivo"
ensure DATABASE_PLATFORM_URL "postgres://hamnivo_platform:$(get HAMNIVO_DB_PLATFORM_PASSWORD)@$host:$port/hamnivo"
ensure REDIS_URL "redis://127.0.0.1:$(get HAMNIVO_VALKEY_PORT)"

# Application secrets (used from the gateway milestone onwards).
ensure HAMNIVO_KEK_BASE64 "$(b64)"
ensure BETTER_AUTH_SECRET "$(b64)"

echo "[hamnivo] $file is ready (secrets generated where missing)."
