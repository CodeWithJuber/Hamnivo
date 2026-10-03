# Shared by hamnivo.sh and deploy.sh; sourced, never run. Callers set `here` (this directory).
# shellcheck shell=bash
# The variables below are read by the scripts that source this file, and `here` is theirs.
# shellcheck disable=SC2034,SC2154

root="$(cd "$here/../.." && pwd)"
env_file="${HAMNIVO_ENV_FILE:-$here/.env}"
project="${HAMNIVO_PROJECT:-hamnivo-production}"
# Deploy state lives next to the settings: current and previous versions, history, logs, the lock
# and the webhook's request folder (see deploy.sh). compose.yml mounts the request folder.
export HAMNIVO_STATE_DIR="${HAMNIVO_STATE_DIR:-$(dirname "$env_file")/state}"
state_dir="$HAMNIVO_STATE_DIR"
compose=(docker compose --project-name "$project" --project-directory "$here"
  -f "$here/compose.yml" --env-file "$env_file")

log() { printf '\033[1;36m[hamnivo]\033[0m %s\n' "$*" >&2; }
fail() {
  printf '\033[1;31m[hamnivo]\033[0m %s\n' "$*" >&2
  exit 1
}

# --- .env helpers (the file is read as data, never sourced) ------------------------------------
get() {
  local line
  line="$(grep -E "^$1=" "$env_file" 2>/dev/null | tail -1 || true)"
  line="${line#*=}"
  line="${line#\"}"
  printf '%s' "${line%\"}"
}
has() { grep -qE "^$1=" "$env_file" 2>/dev/null; }
# Writes the new .env next to the old one and then replaces it in one step, so a full disk (a
# build may have just filled it) can never leave .env half written. A symlinked .env stays a link.
set_kv() {
  local value="$2" file tmp
  [[ "$value" == *' '* ]] && value="\"$value\""
  file="$(readlink -f "$env_file")"
  tmp="$(mktemp "$file.XXXXXX")" || fail "Cannot write next to $file."
  if ! K="$1" V="$value" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$file" >"$tmp" || ! grep -q "^$1=" "$tmp"; then
    rm -f "$tmp"
    fail "Could not update $file (is the disk full?). It is unchanged."
  fi
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}
ensure() { has "$1" || set_kv "$1" "$2"; }
# A setting from the environment, else from .env, else DEFAULT.
setting() { # setting NAME DEFAULT
  local value="${!1:-}"
  [[ -n "$value" ]] || value="$(get "$1")"
  printf '%s' "${value:-$2}"
}
hex() { openssl rand -hex 24; }

need_env() {
  [[ -f "$env_file" ]] || fail "No settings yet. Run: $here/hamnivo.sh setup --domain example.com --email you@example.com"
}

need_docker() {
  command -v docker >/dev/null || fail 'Docker is not installed (https://docs.docker.com/engine/install/).'
  docker compose version >/dev/null 2>&1 || fail 'The Docker Compose plugin is missing.'
}

# The images the stack runs: HAMNIVO_IMAGE_TAG from the environment, else from .env (deploys write
# the commit there), else "local" (what `up` builds).
image_tag() {
  local tag="${HAMNIVO_IMAGE_TAG:-}"
  [[ -n "$tag" ]] || tag="$(get HAMNIVO_IMAGE_TAG)"
  printf '%s' "${tag:-local}"
}

# Deploys, backups and restores never overlap. A deploy holds the lock while it runs the phases
# of hamnivo.sh, and passes HAMNIVO_LOCK_HELD so they do not wait for themselves.
take_lock() {
  [[ -n "${HAMNIVO_LOCK_HELD:-}" ]] && return 0
  mkdir -p "$state_dir"
  exec 9>"$state_dir/deploy.lock"
  if ! flock -n 9; then
    log 'Waiting for a deploy, backup or restore that is still running'
    flock -w "${HAMNIVO_LOCK_WAIT_SECONDS:-7200}" 9 || fail 'Gave up waiting for the running deploy, backup or restore.'
  fi
  export HAMNIVO_LOCK_HELD=1
}

container_of() { "${compose[@]}" ps -q "$1" 2>/dev/null | head -1; }

# "<state> <restarts>" of a service's container: its health, else its status ("missing" when there
# is no container), and how often Docker restarted it.
service_state() { # service_state SERVICE
  local id state='' restarts=0
  id="$(container_of "$1")"
  if [[ -n "$id" ]]; then
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
    restarts="$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || echo 0)"
  fi
  printf '%s %s' "${state:-missing}" "$restarts"
}

# Waits until each service is healthy (or running, when it has no health check). A container that
# stops or keeps restarting fails at once. Deploys also fail at once on "unhealthy"
# (HAMNIVO_FAIL_UNHEALTHY=1), so that a broken version is rolled back quickly; a first start on a
# slow server may pass through "unhealthy" and recover, so it keeps waiting.
wait_healthy() {
  local service deadline=$((SECONDS + ${HAMNIVO_WAIT_SECONDS:-900})) state restarts
  for service in "$@"; do
    log "Waiting for $service"
    while :; do
      read -r state restarts <<<"$(service_state "$service")"
      [[ "$state" == healthy || "$state" == running ]] && break
      if [[ "$state" == exited || "$state" == dead ]] || ((restarts >= 3)) ||
        [[ "$state" == unhealthy && -n "${HAMNIVO_FAIL_UNHEALTHY:-}" ]] || ((SECONDS > deadline)); then
        "${compose[@]}" logs --tail 80 "$service" >&2 || true
        log "$service did not become healthy (state: $state, restarts: $restarts)."
        return 1
      fi
      sleep 3
    done
  done
}

# Free disk space where Docker keeps its data, in whole GB.
docker_free_gb() {
  local dir
  dir="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  df -Pk "$dir" 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }'
}

# --- HTTPS, as a browser reaches the edge --------------------------------------------------------
# deploy.sh checks it before every build and after every switch; doctor.sh checks it for every
# public name. Both ask this machine's own edge: the name resolves to 127.0.0.1 here.
ca_args=()

https_port() { setting HAMNIVO_HTTPS_PORT 443; }

host_of() { # host_of URL: the name in https://NAME[:PORT]/...
  local host="${1#https://}"
  host="${host%%/*}"
  printf '%s' "${host%%:*}"
}

# The names the edge serves: Studio, the API, the chat widget, Chatwoot and the website.
public_hosts() {
  local host sites=()
  IFS=' ' read -r -a sites <<<"$(get HAMNIVO_SITE_HOSTS)"
  for host in "$(get HAMNIVO_APP_HOST)" "$(get HAMNIVO_API_HOST)" "$(get HAMNIVO_CHAT_HOST)" \
    "$(get HAMNIVO_SUPPORT_HOST)" "${sites[@]}"; do
    if [[ -n "$host" ]]; then printf '%s\n' "$host"; fi
  done
}

# With HAMNIVO_TLS=internal the certificates come from Caddy's own CA, which is trusted for these
# requests only: sets ca_args to (--cacert FILE), or to nothing (Let's Encrypt).
edge_ca() { # edge_ca FILE
  ca_args=()
  if [[ "$(get HAMNIVO_TLS)" == internal ]] &&
    "${compose[@]}" exec -T edge cat /data/caddy/pki/authorities/local/root.crt >"$1" 2>/dev/null; then
    ca_args=(--cacert "$1")
  fi
}

# curl through the edge on this machine: URL is https://NAME[:PORT]/..., and NAME goes to 127.0.0.1.
curl_edge() { # curl_edge URL CURL_OPTIONS...
  local url="$1"
  shift
  curl --resolve "$(host_of "$url"):$(https_port):127.0.0.1" "${ca_args[@]}" "$@" "$url"
}

# Whether curl's exit code says that the TLS handshake or the certificate failed, not the connection
# or HTTP. Caddy answers a name it has no certificate for with the alert "internal error" (35).
tls_failure() { # tls_failure CODE
  case "$1" in
    35 | 51 | 53 | 54 | 58 | 59 | 60 | 66 | 77 | 80 | 82 | 83 | 90 | 91) return 0 ;;
    *) return 1 ;;
  esac
}
