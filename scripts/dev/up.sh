#!/usr/bin/env bash
# Starts local development services for Hamnivo:
#   - PostgreSQL 16 with pgvector (roles: hamnivo_owner, hamnivo_app, hamnivo_platform)
#   - Redis/Valkey-compatible cache on :6379
#   - Docker daemon (used for the real Chatwoot stack: pnpm chatwoot:up)
# Idempotent: safe to run repeatedly.
set -euo pipefail

PG_VERSION="${PG_VERSION:-16}"
PG_PORT="${PG_PORT:-5432}"
OWNER_PASSWORD="${HAMNIVO_DB_OWNER_PASSWORD:-hamnivo_owner_dev}"
APP_PASSWORD="${HAMNIVO_DB_APP_PASSWORD:-hamnivo_app_dev}"
PLATFORM_PASSWORD="${HAMNIVO_DB_PLATFORM_PASSWORD:-hamnivo_platform_dev}"

log() { printf '\033[1;36m[hamnivo]\033[0m %s\n' "$*"; }

ensure_packages() {
  local missing=()
  [[ -f "/usr/share/postgresql/${PG_VERSION}/extension/vector.control" ]] || missing+=("postgresql-${PG_VERSION}-pgvector")
  command -v redis-server >/dev/null || missing+=("redis-server")
  command -v potrace >/dev/null || missing+=("potrace")
  if ((${#missing[@]})); then
    log "Installing: ${missing[*]}"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
  fi
}

start_postgres() {
  if ! pg_lsclusters -h | awk -v v="$PG_VERSION" '$1==v && $4=="online"' | grep -q .; then
    log "Starting PostgreSQL ${PG_VERSION}"
    pg_ctlcluster "$PG_VERSION" main start
  fi
  su postgres -c "psql -v ON_ERROR_STOP=1 -q -p ${PG_PORT}" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hamnivo_owner') THEN
    CREATE ROLE hamnivo_owner LOGIN CREATEDB PASSWORD '${OWNER_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hamnivo_app') THEN
    CREATE ROLE hamnivo_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${APP_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hamnivo_platform') THEN
    CREATE ROLE hamnivo_platform LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${PLATFORM_PASSWORD}';
  END IF;
  -- The owner may clone per-worker test databases from templates.
  ALTER ROLE hamnivo_owner CREATEDB;
  GRANT hamnivo_app TO hamnivo_owner;
  GRANT hamnivo_platform TO hamnivo_owner;
END
\$\$;
SQL
  for db in hamnivo hamnivo_test; do
    if ! su postgres -c "psql -p ${PG_PORT} -tAc \"SELECT 1 FROM pg_database WHERE datname='${db}'\"" | grep -q 1; then
      log "Creating database ${db}"
      su postgres -c "createdb -p ${PG_PORT} -O hamnivo_owner ${db}"
    fi
    # Extensions need a superuser; everything else is owned by hamnivo_owner.
    su postgres -c "psql -v ON_ERROR_STOP=1 -q -p ${PG_PORT} -d ${db}" <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
GRANT CONNECT ON DATABASE ${db} TO hamnivo_app, hamnivo_platform;
SQL
  done
}

start_redis() {
  if ! redis-cli -p 6379 ping >/dev/null 2>&1; then
    log "Starting Redis on :6379"
    redis-server --daemonize yes --port 6379 --save '' --appendonly no --logfile /tmp/hamnivo-redis.log
  fi
}

start_docker() {
  if ! command -v dockerd >/dev/null; then
    log "dockerd not installed; Chatwoot will use the contract fake"
    return
  fi
  if ! docker info >/dev/null 2>&1; then
    log "Starting Docker daemon"
    mkdir -p /etc/docker
    [[ -f /etc/docker/daemon.json ]] || echo '{"registry-mirrors":["https://mirror.gcr.io"]}' >/etc/docker/daemon.json
    nohup dockerd --host=unix:///var/run/docker.sock >/tmp/hamnivo-dockerd.log 2>&1 &
    for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  fi
  docker info >/dev/null 2>&1 && log "Docker daemon ready" || log "Docker daemon unavailable (see /tmp/hamnivo-dockerd.log)"
}

ensure_packages
start_postgres
start_redis
if [[ "${HAMNIVO_SKIP_DOCKER:-0}" != "1" ]]; then start_docker; fi

cat <<ENV

Services are up. Suggested environment (see .env.example):
  DATABASE_URL=postgres://hamnivo_app:${APP_PASSWORD}@127.0.0.1:${PG_PORT}/hamnivo
  DATABASE_OWNER_URL=postgres://hamnivo_owner:${OWNER_PASSWORD}@127.0.0.1:${PG_PORT}/hamnivo
  REDIS_URL=redis://127.0.0.1:6379
ENV
