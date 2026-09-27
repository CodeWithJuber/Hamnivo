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
set_kv() {
  local value="$2" tmp
  [[ "$value" == *' '* ]] && value="\"$value\""
  tmp="$(mktemp)"
  K="$1" V="$value" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$env_file" >"$tmp"
  cat "$tmp" >"$env_file"
  rm -f "$tmp"
}
ensure() { has "$1" || set_kv "$1" "$2"; }
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

# Waits until each service is healthy (or running, when it has no health check). A container that
# stops or keeps restarting fails at once. Deploys also fail at once on "unhealthy"
# (HAMNIVO_FAIL_UNHEALTHY=1), so that a broken version is rolled back quickly; a first start on a
# slow server may pass through "unhealthy" and recover, so it keeps waiting.
wait_healthy() {
  local service deadline=$((SECONDS + ${HAMNIVO_WAIT_SECONDS:-900})) id state restarts
  for service in "$@"; do
    log "Waiting for $service"
    while :; do
      id="$(container_of "$service")"
      state=''
      restarts=0
      if [[ -n "$id" ]]; then
        state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
        restarts="$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || echo 0)"
      fi
      [[ "$state" == healthy || "$state" == running ]] && break
      if [[ "$state" == exited || "$state" == dead ]] || ((restarts >= 3)) ||
        [[ "$state" == unhealthy && -n "${HAMNIVO_FAIL_UNHEALTHY:-}" ]] || ((SECONDS > deadline)); then
        "${compose[@]}" logs --tail 80 "$service" >&2 || true
        log "$service did not become healthy (state: ${state:-missing}, restarts: $restarts)."
        return 1
      fi
      sleep 3
    done
  done
}
