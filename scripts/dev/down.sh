#!/usr/bin/env bash
# Stops local development services started by scripts/dev/up.sh.
set -euo pipefail
PG_VERSION="${PG_VERSION:-16}"
redis-cli -p 6379 shutdown nosave >/dev/null 2>&1 || true
pg_ctlcluster "$PG_VERSION" main stop >/dev/null 2>&1 || true
echo "[hamnivo] PostgreSQL and Redis stopped (Docker daemon left running)."
