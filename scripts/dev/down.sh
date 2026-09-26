#!/usr/bin/env bash
# Stops the development services started by scripts/dev/up.sh. Data is kept.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if command -v docker >/dev/null && docker info >/dev/null 2>&1 && [[ -f "$root/.env.local" ]]; then
  docker compose --env-file "$root/.env.local" -f "$root/deploy/compose/services.yml" down
fi
if command -v pg_ctlcluster >/dev/null; then
  redis-cli -p "${HAMNIVO_VALKEY_PORT:-6379}" shutdown nosave >/dev/null 2>&1 || true
  pg_ctlcluster "${PG_VERSION:-16}" main stop >/dev/null 2>&1 || true
fi
echo "[hamnivo] services stopped (volumes and data kept)."
