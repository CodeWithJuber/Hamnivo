#!/usr/bin/env bash
# Runs Hamnivo on this server with Docker Compose (deploy/production/compose.yml).
#
#   hamnivo.sh setup --domain example.com --email you@example.com
#                           create or complete deploy/production/.env (secrets are generated)
#   hamnivo.sh up           build the images, start everything, connect Chatwoot, print the addresses
#   hamnivo.sh status       services and their health
#   hamnivo.sh logs [service...]
#   hamnivo.sh backup [--to DIR] [--keep N] [--no-secrets]
#   hamnivo.sh restore DIR [--yes]
#   hamnivo.sh update       deploy the latest commit of the deploy branch now (see deploy)
#   hamnivo.sh deploy [--latest | REF] [--force]   check, build, start, and roll back on failure
#   hamnivo.sh rollback [COMMIT]   run the previous (or a given) version again
#   hamnivo.sh deploys      recent deploys and their results
#   hamnivo.sh autodeploy enable|disable|pause|resume|status   deploy on every push to GitHub
#   hamnivo.sh down         stop everything (data stays in Docker volumes)
#   hamnivo.sh compose ...  any docker compose command with this stack's files and settings
#
# Setup options: --tls internal (Caddy's own CA instead of Let's Encrypt, for tests and private
# networks), --https-port N and --http-port N (other ports than 443 and 80), --quiet.
# Environment: HAMNIVO_ENV_FILE (default deploy/production/.env), HAMNIVO_PROJECT (compose
# project name), HAMNIVO_BUILD_CA (CA file for builds behind a TLS-inspecting proxy),
# HAMNIVO_BUILD_NETWORK (docker build --network), HAMNIVO_WAIT_SECONDS (default 900).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/production/lib.sh
source "$here/lib.sh"

# --- setup ---------------------------------------------------------------------------------------
cmd_setup() {
  local domain='' tls='' https_port='' http_port='' quiet=0
  while (($#)); do
    case "$1" in
      --quiet) quiet=1; shift ;;
      --domain) domain="${2:?--domain needs a value}"; shift 2 ;;
      --email) tls="${2:?--email needs a value}"; shift 2 ;;
      --tls) tls="${2:?--tls needs a value}"; shift 2 ;;
      --https-port) https_port="${2:?--https-port needs a value}"; shift 2 ;;
      --http-port) http_port="${2:?--http-port needs a value}"; shift 2 ;;
      *) fail "Unknown setup option: $1" ;;
    esac
  done
  command -v openssl >/dev/null || fail 'openssl is required (sudo apt-get install openssl).'
  umask 077
  touch "$env_file"

  [[ -n "$https_port" ]] && set_kv HAMNIVO_HTTPS_PORT "$https_port"
  [[ -n "$http_port" ]] && set_kv HAMNIVO_HTTP_PORT "$http_port"
  ensure HAMNIVO_HTTPS_PORT 443
  ensure HAMNIVO_HTTP_PORT 80
  [[ -n "$tls" ]] && set_kv HAMNIVO_TLS "$tls"
  has HAMNIVO_TLS || fail 'Pass --email you@example.com (for Let'"'"'s Encrypt) or --tls internal.'

  local renamed=0
  if [[ -n "$domain" ]]; then
    renamed=1
    [[ "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail "Not a domain name: $domain"
    set_kv HAMNIVO_DOMAIN "$domain"
    # Every public name follows the domain; edit .env afterwards to use other names.
    set_kv HAMNIVO_APP_HOST "app.$domain"
    set_kv HAMNIVO_API_HOST "api.$domain"
    set_kv HAMNIVO_CHAT_HOST "chat.$domain"
    set_kv HAMNIVO_SUPPORT_HOST "support.$domain"
    set_kv HAMNIVO_SITE_HOSTS "$domain www.$domain"
  fi
  has HAMNIVO_DOMAIN || fail 'Pass --domain example.com (the domain whose names point at this server).'
  domain="$(get HAMNIVO_DOMAIN)"

  local port suffix='' site
  port="$(get HAMNIVO_HTTPS_PORT)"
  [[ "$port" == 443 ]] || suffix=":$port"
  site="$(get HAMNIVO_SITE_HOSTS)"
  site="${site%% *}"
  set_kv HAMNIVO_APP_ORIGIN "https://$(get HAMNIVO_APP_HOST)$suffix"
  set_kv HAMNIVO_API_ORIGIN "https://$(get HAMNIVO_API_HOST)$suffix"
  set_kv HAMNIVO_CHAT_ORIGIN "https://$(get HAMNIVO_CHAT_HOST)$suffix"
  set_kv HAMNIVO_SUPPORT_ORIGIN "https://$(get HAMNIVO_SUPPORT_HOST)$suffix"
  set_kv HAMNIVO_SITE_ORIGIN "https://$site$suffix"
  # Chatwoot calls the gateway's webhooks at its public HTTPS name.
  if ((renamed == 1)) || ! has CHATWOOT_WEBHOOK_BASE_URL; then
    set_kv CHATWOOT_WEBHOOK_BASE_URL "$(get HAMNIVO_API_ORIGIN)"
  fi

  ensure HAMNIVO_DB_SUPERUSER_PASSWORD "$(hex)"
  ensure HAMNIVO_DB_OWNER_PASSWORD "$(hex)"
  ensure HAMNIVO_DB_APP_PASSWORD "$(hex)"
  ensure HAMNIVO_DB_PLATFORM_PASSWORD "$(hex)"
  ensure HAMNIVO_VALKEY_PASSWORD "$(hex)"
  ensure HAMNIVO_KEK_BASE64 "$(openssl rand -base64 32)"
  ensure HAMNIVO_KEK_VERSION 1
  ensure BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
  has WIDGET_SIGNING_KEY ||
    set_kv WIDGET_SIGNING_KEY "$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 | base64 | tr -d '\n')"
  ensure CHATWOOT_SECRET_KEY_BASE "$(openssl rand -hex 64)"
  ensure CHATWOOT_DB_PASSWORD "$(hex)"
  ensure CHATWOOT_REDIS_PASSWORD "$(hex)"
  ensure CHATWOOT_ADMIN_EMAIL "admin@$domain"
  # Chatwoot requires upper and lower case letters, a digit and a symbol.
  ensure CHATWOOT_ADMIN_PASSWORD "Hv-$(hex)-9a!"
  ensure MAIL_FROM "Hamnivo <no-reply@$domain>"
  ensure REQUIRE_EMAIL_VERIFICATION true
  # ClamAV scans uploads (profile "scan"); remove both lines to run without it.
  ensure COMPOSE_PROFILES scan
  ensure CLAMAV_URL tcp://clamav:3310

  # Automatic deploys (hamnivo.sh autodeploy): the branch to follow; off until enabled.
  ensure HAMNIVO_DEPLOY_BRANCH main
  ensure HAMNIVO_AUTODEPLOY off

  ((quiet == 1)) && return 0
  log "Settings are in $env_file (keep it private and back it up)."
  cat >&2 <<EOF

Point these DNS names at this server (A and AAAA records), then run: $0 up
  $(get HAMNIVO_APP_HOST)      Studio (staff console)
  $(get HAMNIVO_API_HOST)      API
  $(get HAMNIVO_CHAT_HOST)     chat widget
  $(get HAMNIVO_SUPPORT_HOST)  Chatwoot
  $(get HAMNIVO_SITE_HOSTS)    website
Ports $(get HAMNIVO_HTTP_PORT) and $(get HAMNIVO_HTTPS_PORT) (TCP, and UDP for HTTP/3) must be open.
EOF
  if [[ -z "$(get SMTP_URL)" ]]; then
    printf '%s\n' "Email: set SMTP_URL in $env_file to send sign-in emails (until then they appear in: $0 logs api)." >&2
  fi
}

# --- build and start -----------------------------------------------------------------------------
docker_build() {
  local args=()
  [[ -n "${HAMNIVO_BUILD_CA:-}" ]] && args+=(--secret "id=extra_ca,src=$HAMNIVO_BUILD_CA")
  [[ -n "${HAMNIVO_BUILD_NETWORK:-}" ]] && args+=(--network "$HAMNIVO_BUILD_NETWORK")
  docker build "${args[@]}" -f "$root/deploy/docker/Dockerfile" "$@" "$root"
}

# The commit being built, for the images' revision label: HAMNIVO_RELEASE, else git's HEAD.
release_of() {
  local release="${HAMNIVO_RELEASE:-}"
  [[ -n "$release" ]] || release="$(git -C "$root" rev-parse HEAD 2>/dev/null || echo unknown)"
  printf '%s' "$release"
}

build_images() {
  local tag="${1:-$(image_tag)}" release
  release="$(release_of)"
  log 'Building the gateway image (the first build takes several minutes)'
  docker_build --target gateway --build-arg "HAMNIVO_RELEASE=$release" -t "hamnivo/gateway:$tag"
  log 'Building the edge image (static apps and HTTPS)'
  docker_build --target edge --build-arg "HAMNIVO_RELEASE=$release" \
    --build-arg "HAMNIVO_API_ORIGIN=$(get HAMNIVO_API_ORIGIN)" \
    --build-arg "HAMNIVO_CHAT_ORIGIN=$(get HAMNIVO_CHAT_ORIGIN)" \
    --build-arg "HAMNIVO_SITE_URL=$(get HAMNIVO_SITE_ORIGIN)" \
    --build-arg "HAMNIVO_DEMO_WIDGET_ID=$(get HAMNIVO_DEMO_WIDGET_ID)" \
    -t "hamnivo/edge:$tag"
  if [[ "$(get HAMNIVO_AUTODEPLOY)" == webhook ]]; then
    log 'Building the deploy webhook receiver'
    docker_build --target deploy-hook -t hamnivo/deploy-hook:local
  fi
}

# hamnivo.sh build [--verify] [--tag TAG]: what a deploy runs for the version it deploys.
# hamnivo.sh build --hook: only the deploy webhook receiver (autodeploy enable).
cmd_build() {
  need_docker
  need_env
  local verify=0 tag=''
  while (($#)); do
    case "$1" in
      --verify) verify=1; shift ;;
      --tag) tag="${2:?--tag needs a value}"; shift 2 ;;
      --hook)
        docker_build --target deploy-hook -t hamnivo/deploy-hook:local
        return 0
        ;;
      *) fail "Unknown build option: $1" ;;
    esac
  done
  if ((verify == 1)); then
    log 'Checking the code: Biome, type checks and unit tests'
    docker_build --target verify -t hamnivo/verify:last
  fi
  build_images "${tag:-$(image_tag)}"
}

connect_chatwoot() {
  [[ -n "$(get CHATWOOT_PLATFORM_TOKEN)" ]] && return 0
  log 'Creating the Chatwoot super admin and the Hamnivo Platform App'
  local token
  token="$("${compose[@]}" exec -T \
    -e HV_ADMIN_EMAIL="$(get CHATWOOT_ADMIN_EMAIL)" -e HV_ADMIN_PASSWORD="$(get CHATWOOT_ADMIN_PASSWORD)" \
    chatwoot-web bundle exec rails runner - <"$root/scripts/chatwoot/bootstrap.rb" |
    grep '^HAMNIVO_PLATFORM_TOKEN=' | tail -1 | cut -d= -f2)"
  [[ -n "$token" ]] || fail 'Could not read the Chatwoot Platform App token.'
  set_kv CHATWOOT_PLATFORM_TOKEN "$token"
  log 'Restarting the API and the worker with the Chatwoot token'
  "${compose[@]}" up -d api worker >&2
}

cmd_up() {
  need_docker
  need_env
  local build=1 quiet=0
  while (($#)); do
    case "$1" in
      --no-build) build=0; shift ;;
      --quiet) quiet=1; shift ;;
      *) fail "Unknown up option: $1" ;;
    esac
  done
  ((build == 1)) && build_images
  log "Starting the services (images: $(image_tag))"
  "${compose[@]}" up -d --remove-orphans >&2
  wait_healthy api chatwoot-web
  connect_chatwoot
  wait_healthy api worker edge
  ((quiet == 1)) && return 0
  cat >&2 <<EOF

Hamnivo is running.
  Studio     $(get HAMNIVO_APP_ORIGIN)   (create your account here)
  Website    $(get HAMNIVO_SITE_ORIGIN)
  API        $(get HAMNIVO_API_ORIGIN)   (reference: $(get HAMNIVO_API_ORIGIN)/docs)
  Chat       $(get HAMNIVO_CHAT_ORIGIN)/loader.js
  Chatwoot   $(get HAMNIVO_SUPPORT_ORIGIN)   (super admin $(get CHATWOOT_ADMIN_EMAIL); password in .env)
Next: open Studio, create your account and set up a brand (docs/self-hosting.md, "First steps").
EOF
}

cmd_status() {
  need_env
  "${compose[@]}" ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
}

# --- backups -------------------------------------------------------------------------------------
cmd_backup() {
  need_docker
  need_env
  take_lock
  local to="$here/backups" keep=14 secrets=1
  while (($#)); do
    case "$1" in
      --to) to="${2:?--to needs a directory}"; shift 2 ;;
      --keep) keep="${2:?--keep needs a number}"; shift 2 ;;
      --no-secrets) secrets=0; shift ;;
      *) fail "Unknown backup option: $1" ;;
    esac
  done
  umask 077
  local dir
  dir="$to/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$dir"
  "${compose[@]}" up -d hamnivo-db chatwoot-db >&2
  wait_healthy hamnivo-db chatwoot-db
  log "Backing up to $dir"
  "${compose[@]}" exec -T hamnivo-db pg_dump -U postgres -d hamnivo -Fc >"$dir/hamnivo.dump"
  "${compose[@]}" exec -T chatwoot-db pg_dump -U postgres -d chatwoot -Fc >"$dir/chatwoot.dump"
  "${compose[@]}" run --rm --no-deps -T --entrypoint tar chatwoot-web -C /app/storage -czf - . \
    >"$dir/chatwoot-storage.tar.gz"
  "${compose[@]}" run --rm --no-deps -T --entrypoint tar edge -C /data -czf - . >"$dir/caddy-data.tar.gz"
  local holds='personal data'
  if ((secrets == 1)); then
    cp "$env_file" "$dir/env"
    holds='personal data and every secret'
  fi
  (cd "$dir" && sha256sum -- * >SHA256SUMS)
  log "Backup complete ($(du -sh "$dir" | cut -f1)). It holds $holds: keep it encrypted and off this server."
  # Keep the newest N backups made by this command.
  local old
  while IFS= read -r old; do
    rm -rf -- "$old"
    log "Removed old backup $old"
  done < <(find "$to" -mindepth 1 -maxdepth 1 -type d -name '20*Z' | sort -r | tail -n +"$((keep + 1))")
}

cmd_restore() {
  need_docker
  local dir='' yes=0 answer=''
  while (($#)); do
    case "$1" in
      --yes) yes=1; shift ;;
      -*) fail "Unknown restore option: $1" ;;
      *) dir="$1"; shift ;;
    esac
  done
  [[ -n "$dir" && -f "$dir/hamnivo.dump" && -f "$dir/chatwoot.dump" ]] || fail 'Usage: hamnivo.sh restore BACKUP_DIR'
  (cd "$dir" && sha256sum --quiet -c SHA256SUMS) || fail 'The backup is damaged (checksums differ).'
  if [[ ! -f "$env_file" ]]; then
    [[ -f "$dir/env" ]] || fail 'No settings here and none in the backup: copy your .env first.'
    install -m 600 "$dir/env" "$env_file"
    log 'Settings restored from the backup.'
  elif [[ -f "$dir/env" && "$(grep '^HAMNIVO_KEK_BASE64=' "$dir/env")" != "$(grep '^HAMNIVO_KEK_BASE64=' "$env_file")" ]]; then
    fail "The backup was made with other secrets. Move $env_file away to use the backup's settings."
  fi
  if ((yes == 0)); then
    read -r -p 'This replaces all Hamnivo and Chatwoot data on this server. Type "restore" to go on: ' answer
    [[ "$answer" == restore ]] || fail 'Nothing was changed.'
  fi
  take_lock
  log 'Stopping the applications'
  "${compose[@]}" stop api worker edge chatwoot-web chatwoot-sidekiq >&2 2>/dev/null || true
  "${compose[@]}" up -d hamnivo-db chatwoot-db >&2
  wait_healthy hamnivo-db chatwoot-db

  log 'Restoring the Hamnivo database'
  "${compose[@]}" exec -T hamnivo-db dropdb -U postgres --if-exists --force hamnivo
  "${compose[@]}" run --rm db-init >&2
  "${compose[@]}" exec -T hamnivo-db pg_restore -U postgres -d hamnivo --exit-on-error \
    --single-transaction <"$dir/hamnivo.dump"

  log 'Restoring the Chatwoot database'
  "${compose[@]}" exec -T chatwoot-db dropdb -U postgres --if-exists --force chatwoot
  "${compose[@]}" exec -T chatwoot-db createdb -U postgres chatwoot
  "${compose[@]}" exec -T chatwoot-db pg_restore -U postgres -d chatwoot --exit-on-error \
    --single-transaction <"$dir/chatwoot.dump"

  log 'Restoring files'
  "${compose[@]}" run --rm --no-deps -T --entrypoint sh chatwoot-web \
    -c 'find /app/storage -mindepth 1 -delete && tar -C /app/storage -xzf -' <"$dir/chatwoot-storage.tar.gz"
  if [[ -f "$dir/caddy-data.tar.gz" ]]; then
    "${compose[@]}" run --rm --no-deps -T --entrypoint sh edge \
      -c 'find /data -mindepth 1 -delete && tar -C /data -xzf -' <"$dir/caddy-data.tar.gz"
  fi

  log 'Starting everything (pending migrations run first)'
  "${compose[@]}" up -d >&2
  wait_healthy api worker chatwoot-web edge
  log "Restored from $dir."
}

main() {
  local command="${1:-help}"
  shift || true
  case "$command" in
    setup) cmd_setup "$@" ;;
    up) cmd_up "$@" ;;
    status) cmd_status ;;
    logs) need_env; "${compose[@]}" logs --tail 200 -f "$@" ;;
    backup) cmd_backup "$@" ;;
    restore) cmd_restore "$@" ;;
    build) cmd_build "$@" ;;
    update) exec bash "$here/deploy.sh" deploy --latest --trigger manual "$@" ;;
    deploy | rollback | deploys | autodeploy) exec bash "$here/deploy.sh" "$command" "$@" ;;
    down) need_env; "${compose[@]}" down ;;
    compose) need_env; "${compose[@]}" "$@" ;;
    help | -h | --help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//' ;;
    *) fail "Unknown command: $command (try: $0 help)" ;;
  esac
}

# One line, so bash has read it completely before `update` replaces this file.
main "$@"; exit
