#!/usr/bin/env bash
# Starts the services Hamnivo needs in development: PostgreSQL + pgvector and Valkey.
#   Default: Docker Compose (deploy/compose/services.yml), the same setup used on servers.
#   HAMNIVO_SERVICES=native: apt-installed PostgreSQL 16 + redis-server, for hosts without Docker.
# Creates .env.local with generated passwords on first run (scripts/setup/env.sh). Idempotent.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose=(docker compose --env-file "$root/.env.local" -f "$root/deploy/compose/services.yml")
log() { printf '\033[1;36m[hamnivo]\033[0m %s\n' "$*"; }

bash "$root/scripts/setup/env.sh"
set -a
# shellcheck disable=SC1091
source "$root/.env.local"
set +a

docker_ready() {
  command -v docker >/dev/null || return 1
  docker info >/dev/null 2>&1 && return 0
  # Development containers without an init system: start the daemon ourselves.
  if [[ $EUID -eq 0 ]] && command -v dockerd >/dev/null; then
    log "Starting Docker daemon"
    mkdir -p /etc/docker
    [[ -f /etc/docker/daemon.json ]] || echo '{"registry-mirrors":["https://mirror.gcr.io"]}' >/etc/docker/daemon.json
    nohup dockerd --host=unix:///var/run/docker.sock >/tmp/hamnivo-dockerd.log 2>&1 &
    for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && return 0; sleep 1; done
  fi
  return 1
}

start_docker_services() {
  log "Starting PostgreSQL 18 + pgvector and Valkey (docker compose)"
  "${compose[@]}" up -d --wait
  # Re-apply roles so passwords stay in sync with .env.local (initdb scripts only run once).
  "${compose[@]}" exec -T hamnivo-db /hamnivo-db-init/init.sh
}

start_native_services() {
  local pg_version="${PG_VERSION:-16}" missing=()
  [[ -f "/usr/share/postgresql/${pg_version}/extension/vector.control" ]] || missing+=("postgresql-${pg_version}-pgvector")
  command -v redis-server >/dev/null || missing+=("redis-server")
  if ((${#missing[@]})); then
    log "Installing: ${missing[*]}"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
  fi
  if ! pg_lsclusters -h | awk -v v="$pg_version" '$1==v && $4=="online"' | grep -q .; then
    log "Starting PostgreSQL ${pg_version}"
    pg_ctlcluster "$pg_version" main start
  fi
  su postgres -s /bin/bash -c "PGPORT='${HAMNIVO_DB_PORT}' \
    HAMNIVO_DB_OWNER_PASSWORD='${HAMNIVO_DB_OWNER_PASSWORD}' \
    HAMNIVO_DB_APP_PASSWORD='${HAMNIVO_DB_APP_PASSWORD}' \
    HAMNIVO_DB_PLATFORM_PASSWORD='${HAMNIVO_DB_PLATFORM_PASSWORD}' \
    bash '$root/deploy/postgres/init.sh'"
  if ! redis-cli -p "${HAMNIVO_VALKEY_PORT}" ping >/dev/null 2>&1; then
    log "Starting redis-server on :${HAMNIVO_VALKEY_PORT}"
    redis-server --daemonize yes --port "${HAMNIVO_VALKEY_PORT}" --save '' --appendonly no \
      --maxmemory-policy noeviction --logfile /tmp/hamnivo-redis.log
  fi
}

mode="${HAMNIVO_SERVICES:-auto}"
if [[ $mode == auto ]]; then
  if docker_ready; then mode=docker; else mode=native; fi
fi
case "$mode" in
  docker) start_docker_services ;;
  native) start_native_services ;;
  *) echo "HAMNIVO_SERVICES must be auto, docker or native" >&2; exit 2 ;;
esac

log "Services are up ($mode). Connection settings are in .env.local."
