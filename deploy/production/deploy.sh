#!/usr/bin/env bash
# Deploys Hamnivo from git. Run it through hamnivo.sh: deploy, rollback, deploys, autodeploy.
#
# A deploy takes the newest commit of the deploy branch (HAMNIVO_DEPLOY_BRANCH, default main) from
# the git remote. It checks that commit (Biome, type checks, unit tests) and builds its images from
# a clean copy of its files, while the running version stays as it is. Then it starts the new
# version; if that does not stay healthy, the version that ran before is started again. Before it
# builds, it checks that HTTPS works on this server (without a certificate, nothing is built); after
# the switch, it restarts the edge once if a name has none. See docs/self-hosting.md, "Automatic
# deployment from GitHub", and `hamnivo.sh doctor` for what is wrong with a server.
#
#   hamnivo.sh deploy [--latest | REF] [--force]   REF: a commit, tag or branch. --force deploys
#                                                  even a live, failed or stopped commit, and
#                                                  skips the HTTPS check before the build
#   hamnivo.sh rollback [COMMIT]                   default: the version that ran before
#   hamnivo.sh deploys [N]                         the last N deploys (default 20)
#   hamnivo.sh autodeploy enable [--mode webhook|poll] [--github-token-file FILE] [--no-systemd]
#   hamnivo.sh autodeploy disable | pause | resume | status
#
# Each version's own hamnivo.sh runs its phases: `setup --quiet`, `build --verify --tag TAG`,
# `up --no-build --quiet` and `backup --to DIR --keep N`. Keep these options working: a rollback
# runs an older version's script.
#
# State, in HAMNIVO_STATE_DIR (next to .env):
#   current, previous   "<commit> <image tag>" of the live version and the one before
#   history.tsv         one line per deploy; logs/ holds each deploy's full log
#   failed/<commit>     "<attempts> <step>" of commits that failed. Automatic deploys retry a
#                       commit that stopped before the switch once, after 30 minutes; no other.
#                       A stop because HTTPS did not work (step "https") is no failure of the
#                       commit: it is tried again every 30 minutes, until HTTPS works.
#   held/<commit>       commits that wait for a deploy by hand, and why
#   build/<tag>         the clean copy of a version that a deploy checks and builds (temporary)
#   env.before          the settings as they were, while a switch runs
#   requests/           the webhook receiver creates a file here for each accepted push
#   paused, deploy.lock, known_hosts
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/production/lib.sh
source "$here/lib.sh"

hamnivo=(bash "$here/hamnivo.sh")
remote="${HAMNIVO_DEPLOY_REMOTE:-origin}"
migrations=packages/db/migrations
# GitHub's published SSH host key (docs.github.com, "GitHub's SSH key fingerprints"):
# SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU
github_host_key='github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
deploy_force=0
# Why the switch to a version, or its start, failed, in words: for the log, the history and GitHub.
fail_reason=''
# Whether the edge was restarted already in this deploy (see probe_https).
edge_restarted=0

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
short() { printf '%s' "${1:0:12}"; }
git_() { GIT_TERMINAL_PROMPT=0 git -C "$root" "$@"; }

# --- state ---------------------------------------------------------------------------------------
read_state() { if [[ -f "$state_dir/$1" ]]; then cat "$state_dir/$1"; fi; }
write_state() { printf '%s %s\n' "$2" "$3" >"$state_dir/$1"; }
record() { # record COMMIT RESULT TRIGGER SECONDS DETAIL
  printf '%s\t%s\t%s\t%s\t%ss\t%s\n' "$(now)" "$(short "$1")" "$2" "$3" "$4" "$5" \
    >>"$state_dir/history.tsv"
}

# Notes that COMMIT failed at STEP, counting the attempts. A stop at "https" counts none: broken
# HTTPS says nothing about the commit, so it stays at one attempt and is tried again, every time.
fail_state() { # fail_state COMMIT STEP
  local attempts=0
  mkdir -p "$state_dir/failed"
  if [[ -f "$state_dir/failed/$1" ]]; then read -r attempts _ <"$state_dir/failed/$1" || true; fi
  [[ "$attempts" =~ ^[0-9]+$ ]] || attempts=0
  [[ "$2" == https ]] && attempts=0
  printf '%s %s\n' "$((attempts + 1))" "$2" >"$state_dir/failed/$1"
}

# The step at which COMMIT failed (the second word of its failed/ file), or nothing.
failed_step() { # failed_step COMMIT
  local step=''
  read -r _ step <"$state_dir/failed/$1" || true
  printf '%s' "$step"
}

# Whether an automatic run may try COMMIT again: only when it stopped before the switch (a network
# or a registry may have failed), only once, and only after 30 minutes. A stop for broken HTTPS may
# be tried again every 30 minutes, until HTTPS works.
may_retry() { # may_retry COMMIT
  local file="$state_dir/failed/$1" attempts='' step=''
  read -r attempts step <"$file" || true
  [[ "$attempts" =~ ^[0-9]+$ ]] || return 1
  case "$step" in export | setup | checks-and-build | backup | https) ;; *) return 1 ;; esac
  ((attempts < 2)) && [[ -n "$(find "$file" -mmin +30)" ]]
}

# The commit the running API was built from, by its image's revision label. Nothing when it cannot
# tell: no API container, or images built before the label existed (empty or "unknown").
api_commit() {
  local id label
  id="$(container_of api)"
  [[ -n "$id" ]] || return 0
  label="$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$id" 2>/dev/null || true)"
  if [[ "$label" =~ ^[0-9a-f]{40}$ ]]; then printf '%s' "$label"; fi
}

# "<commit> <tag>" of the live version. Before the first deploy: the commit the API's images name
# (else HEAD) and the images running now.
running_version() {
  local line commit
  line="$(read_state current)"
  if [[ -z "$line" ]]; then
    commit="$(api_commit)"
    line="${commit:-$(git_ rev-parse HEAD)} $(image_tag)"
  fi
  printf '%s' "$line"
}

# Whether COMMIT is known to be what runs: a deploy recorded it, or the API's images say so. After
# a `git pull` by hand, HEAD is not what runs, so a guess from HEAD never counts.
known_live() { [[ -f "$state_dir/current" || "$(api_commit)" == "$1" ]]; }

# --- GitHub deployment statuses (optional) -------------------------------------------------------
# With GITHUB_DEPLOY_TOKEN (fine-grained, this repository only, "Deployments: read and write"),
# every deploy appears in GitHub under Environments → production. Failures here never stop a deploy.
github_deployment=''

github_api() { # github_api METHOD PATH JSON
  local token repo headers
  token="$(get GITHUB_DEPLOY_TOKEN)"
  repo="$(get HAMNIVO_DEPLOY_REPOSITORY)"
  [[ -n "$token" && -n "$repo" ]] || return 1
  # The token goes in a file, so it never shows in the process list.
  headers="$work/github-headers"
  (umask 077 && printf 'Authorization: Bearer %s\n' "$token" >"$headers")
  curl -fsS --max-time 20 -X "$1" -H @"$headers" -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' -d "$3" "${HAMNIVO_GITHUB_API:-https://api.github.com}/repos/$repo$2"
}

github_start() { # github_start COMMIT
  github_deployment=''
  [[ -n "$(get GITHUB_DEPLOY_TOKEN)" ]] || return 0
  local body response
  body="$(printf '{"ref":"%s","environment":"production","production_environment":true,"auto_merge":false,"required_contexts":[],"description":"Hamnivo on %s"}' \
    "$1" "$(uname -n)")"
  if ! response="$(github_api POST /deployments "$body" 2>&1)"; then
    log "Could not create the GitHub deployment: ${response:0:200}"
    return 0
  fi
  # The deployment's own id is the first "id" of the answer (the creator's comes later).
  github_deployment="$(printf '%s' "$response" | grep -o '"id": *[0-9]*' | head -1 | grep -o '[0-9]*$' || true)"
  github_status in_progress 'Checking, building and starting'
}

github_status() { # github_status STATE DESCRIPTION
  [[ -n "$github_deployment" ]] || return 0
  local body description="${2//\"/\'}"
  body="$(printf '{"state":"%s","description":"%s","environment_url":"%s","auto_inactive":true}' \
    "$1" "${description:0:140}" "$(get HAMNIVO_APP_ORIGIN)")"
  github_api POST "/deployments/$github_deployment/statuses" "$body" >/dev/null 2>&1 ||
    log 'Could not update the GitHub deployment status.'
}

# --- checks --------------------------------------------------------------------------------------
# Keeps Docker's build cache (dependency store, turbo cache, layers) under a size, least recently
# used first: HAMNIVO_DEPLOY_BUILD_CACHE_GB, default 8. Without --all, Docker would only remove
# dangling entries, which is almost nothing. Older Docker versions have other flags.
prune_build_cache() { # prune_build_cache [GB]
  local limit="${1:-$(setting HAMNIVO_DEPLOY_BUILD_CACHE_GB 8)}gb"
  docker builder prune --all -f --max-used-space "$limit" >/dev/null 2>&1 ||
    docker builder prune --all -f --keep-storage "$limit" >/dev/null 2>&1 ||
    docker builder prune --all -f --filter until=168h >/dev/null 2>&1 || true
}

check_disk() {
  local free need
  need="$(setting HAMNIVO_DEPLOY_MIN_FREE_GB 8)"
  free="$(docker_free_gb)"
  ((${free:-0} >= need)) && return 0
  log "Only ${free:-0} GB free for Docker; shrinking the build cache"
  prune_build_cache 2
  free="$(docker_free_gb)"
  ((${free:-0} >= need)) || {
    log "Not enough disk space: ${free:-0} GB free, $need GB needed (HAMNIVO_DEPLOY_MIN_FREE_GB)."
    return 1
  }
}

# --- HTTPS ---------------------------------------------------------------------------------------
# What proves that the stack answers over HTTPS, through the edge: the API's health, Studio and the
# chat loader.
probe_urls() {
  printf '%s\n' "$(get HAMNIVO_API_ORIGIN)/health/ready" "$(get HAMNIVO_APP_ORIGIN)/" \
    "$(get HAMNIVO_CHAT_ORIGIN)/loader.js"
}

# One request to URL, tried again RETRIES times. Returns curl's exit code (see tls_failure).
probe_get() { # probe_get URL RETRIES
  curl_edge "$1" -fsS -o /dev/null --max-time 10 --retry "$2" --retry-delay 3 --retry-all-errors
}

# The reason in words when the TLS handshake with HOST failed (curl's exit code CODE): Caddy sends
# the alert "internal error" for a name it has no certificate for.
tls_reason() { # tls_reason CODE HOST
  if [[ "$1" == 35 ]]; then
    printf 'no HTTPS certificate for %s (run hamnivo.sh doctor)' "$2"
  else
    printf 'the HTTPS certificate for %s is not valid (run hamnivo.sh doctor)' "$2"
  fi
}

# Checks the stack from outside, through the edge. On failure, probe_reason says why, in words, for
# the log, the history and GitHub; probe_tls is 1 when the TLS handshake failed (no certificate),
# and 0 for anything else (a refused connection, an HTTP error).
probe_reason=''
probe_tls=0
probe() {
  local url code
  probe_reason=''
  probe_tls=0
  edge_ca "$work/ca.crt"
  while IFS= read -r url; do
    code=0
    probe_get "$url" 10 || code=$?
    if ((code == 0)); then continue; fi
    log "Not reachable over HTTPS: $url (curl exit $code)"
    if tls_failure "$code"; then
      probe_tls=1
      probe_reason="$(tls_reason "$code" "$(host_of "$url")")"
    else
      probe_reason="$url does not answer over HTTPS"
    fi
    return 1
  done < <(probe_urls)
}

# probe, and when the TLS handshake fails (Caddy may still be asking for a certificate, or may have
# lost it), restarts the edge once in this deploy and probes again before giving up.
probe_https() {
  if probe; then return 0; fi
  if ((probe_tls == 0 || edge_restarted == 1)); then return 1; fi
  edge_restarted=1
  log 'The TLS handshake failed: restarting the edge once, so that Caddy asks for its certificates again'
  "${compose[@]}" restart edge >&2 || true
  HAMNIVO_FAIL_UNHEALTHY=1 HAMNIVO_WAIT_SECONDS="$(setting HAMNIVO_DEPLOY_HEALTH_SECONDS 600)" \
    wait_healthy edge || true
  probe
}

# Before building: whether the running version answers over HTTPS. When every name that fails fails
# on the TLS handshake, HTTPS was broken before this deploy: a new version could not fix that, and
# the check after its switch would roll it back. Any other failure does not stop a deploy, because
# the new version may be the fix. Returns 1 for broken HTTPS and says why in baseline_reason.
baseline_reason=''
check_baseline() {
  local url code host='' tls_code='' other=0
  baseline_reason=''
  edge_ca "$work/ca.crt"
  while IFS= read -r url; do
    code=0
    probe_get "$url" 2 || code=$?
    if ((code == 0)); then continue; fi
    log "The running version does not answer over HTTPS at $url (curl exit $code)"
    if ! tls_failure "$code"; then
      other=1
    elif [[ -z "$host" ]]; then
      host="$(host_of "$url")"
      tls_code="$code"
    fi
  done < <(probe_urls)
  if ((other == 1)); then
    log 'It fails for more than certificates, so this deploy goes on: the new version may be the fix.'
    return 0
  fi
  [[ -n "$host" ]] || return 0
  if [[ "$tls_code" == 35 ]]; then
    baseline_reason="HTTPS is not working on this server: no certificate for $host. Fix it first (hamnivo.sh doctor)"
  else
    baseline_reason="HTTPS is not working on this server: the certificate for $host is not valid. Fix it first (hamnivo.sh doctor)"
  fi
  return 1
}

# Whether the API container runs the images built from COMMIT (images built before the revision
# label existed cannot tell, and pass).
runs_commit() {
  local id label
  id="$(container_of api)"
  [[ -n "$id" ]] || return 1
  label="$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$id" 2>/dev/null || true)"
  [[ -z "$label" || "$label" == '<no value>' || "$label" == unknown || "$label" == "$1" ]]
}

# --- guards --------------------------------------------------------------------------------------
# The "when" of each migration in COMMIT's journal (Drizzle's migration timestamps).
journal_whens() { # journal_whens COMMIT
  git_ show "$1:$migrations/meta/_journal.json" 2>/dev/null | grep -o '"when": *[0-9]*' |
    grep -o '[0-9]*$' | LC_ALL=C sort || true
}

# What a rollback could not undo, decided from git alone before anything is built. Sets
# guard_reason. Returns 1 for a mistake to fix in a new commit, 2 for a version that waits for a
# deploy by hand, 0 otherwise.
guard_reason=''
check_guards() { # check_guards FROM TO
  local from="$1" to="$2" changed newest late file sql images
  guard_reason=''
  # Without the running commit there is nothing to compare; the deploy then backs up first.
  known_live "$from" || return 0

  # Drizzle only runs migrations newer than the newest one applied. An edited or removed migration
  # never runs again, and a new one dated before the newest applied one would be skipped forever.
  changed="$(git_ diff --name-only --diff-filter=MDR "$from" "$to" -- "$migrations/*.sql" | head -3 | xargs)"
  if [[ -n "$changed" ]]; then
    guard_reason="migrations that already ran were changed or removed ($changed); add a new migration instead"
    return 1
  fi
  newest="$(journal_whens "$from" | tail -1)"
  if [[ -n "$newest" ]]; then
    late="$(LC_ALL=C comm -13 <(journal_whens "$from") <(journal_whens "$to") |
      awk -v newest="$newest" '$1 <= newest' | head -1)"
    if [[ -n "$late" ]]; then
      guard_reason='a new migration is dated before the newest one that already ran, so it would never run; generate it again'
      return 1
    fi
  fi

  # Dropped, renamed or retyped data, and new versions of other software (Chatwoot migrates its
  # database when it starts), cannot be undone by starting the previous version: a person decides.
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    sql="$(git_ show "$to:$file")"
    if grep -qiE 'drop[[:space:]]+(table|column|schema)|rename[[:space:]]+(to|column)|set[[:space:]]+data[[:space:]]+type|alter[[:space:]]+column[^;]*[[:space:]]type[[:space:]]|set[[:space:]]+not[[:space:]]+null|truncate' <<<"$sql"; then
      guard_reason="the migration $(basename "$file") drops, renames or retypes data"
      return 2
    fi
  done < <(git_ diff --name-only --diff-filter=A "$from" "$to" -- "$migrations/*.sql")
  images="$(git_ diff "$from" "$to" -- deploy/production/compose.yml | grep -E '^\+[[:space:]]+image:' |
    grep -v 'hamnivo/' | sed -E 's/^\+[[:space:]]+image:[[:space:]]*//' | sort -u | xargs || true)"
  if [[ -n "$images" ]]; then
    guard_reason="it changes the version of other software ($images)"
    return 2
  fi
  return 0
}

# --- phases --------------------------------------------------------------------------------------
# Starts COMMIT with the images TAG, using that version's own hamnivo.sh, then checks it. When it
# fails, fail_reason says why.
start_version() { # start_version COMMIT TAG
  fail_reason=''
  git_ checkout --quiet --detach "$1" || {
    fail_reason="could not check out $(short "$1")"
    return 1
  }
  set_kv HAMNIVO_IMAGE_TAG "$2"
  HAMNIVO_FAIL_UNHEALTHY=1 HAMNIVO_WAIT_SECONDS="$(setting HAMNIVO_DEPLOY_HEALTH_SECONDS 600)" \
    "${hamnivo[@]}" up --no-build --quiet || {
    fail_reason='the services did not become healthy'
    return 1
  }
  probe_https || {
    fail_reason="$probe_reason"
    return 1
  }
  runs_commit "$1" || {
    log "The API does not run $(short "$1")."
    fail_reason="the API does not run $(short "$1")"
    return 1
  }
}

# A new version must stay healthy for a while, not only answer once: nothing may restart
# (HAMNIVO_DEPLOY_SOAK_SECONDS, default 45).
soak() {
  local seconds service id state i=0 restarts=()
  seconds="$(setting HAMNIVO_DEPLOY_SOAK_SECONDS 45)"
  ((seconds > 0)) || return 0
  for service in api worker edge; do
    id="$(container_of "$service")"
    restarts+=("$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || echo 0)")
  done
  log "Watching the new version for $seconds s"
  sleep "$seconds"
  for service in api worker edge; do
    id="$(container_of "$service")"
    state="$(docker inspect -f '{{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo 'gone')"
    if [[ "$state" != "${restarts[i]} healthy" && "$state" != "${restarts[i]} running" ]]; then
      "${compose[@]}" logs --tail 80 "$service" >&2 || true
      log "$service did not stay healthy (restarts and state: $state)."
      fail_reason="$service did not stay healthy"
      return 1
    fi
    i=$((i + 1))
  done
  probe_https || {
    fail_reason="$probe_reason"
    return 1
  }
}

# Backs up first (a separate rotation of 5) when the new version changes the database, its
# container settings or its bootstrap, and when nobody knows which version runs. The running
# version's own script makes the backup, before anything of the new version starts.
backup_if_needed() { # backup_if_needed FROM TO
  if ! known_live "$1"; then
    log 'The version running now is not known: backing up first'
  elif git_ diff --quiet "$1" "$2" -- "$migrations" deploy/postgres deploy/production/compose.yml 2>/dev/null; then
    return 0
  else
    log 'This version changes the database or its containers: backing up first'
  fi
  "${hamnivo[@]}" backup --to "$here/backups/before-deploy" --keep "$(setting HAMNIVO_DEPLOY_BACKUPS 5)"
}

# Puts back the settings saved before the switch, in one step (see set_kv).
restore_env() {
  [[ -f "$state_dir/env.before" ]] || return 0
  local file tmp
  file="$(readlink -f "$env_file")"
  tmp="$(mktemp "$file.XXXXXX")"
  cat "$state_dir/env.before" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
  rm -f "$state_dir/env.before"
}

# Removes images of old versions: keeps the live one, the one before, and the newest others up to
# HAMNIVO_DEPLOY_KEEP (default 3) in all; then shrinks the build cache.
prune_images() {
  local keep repo tag kept current_tag previous_tag
  keep="$(setting HAMNIVO_DEPLOY_KEEP 3)"
  current_tag="$(read_state current)"
  current_tag="${current_tag##* }"
  previous_tag="$(read_state previous)"
  previous_tag="${previous_tag##* }"
  for repo in hamnivo/gateway hamnivo/edge; do
    kept=0
    while IFS= read -r tag; do
      [[ -z "$tag" || "$tag" == '<none>' ]] && continue
      if [[ "$tag" == "$current_tag" || "$tag" == "$previous_tag" ]]; then
        kept=$((kept + 1))
        continue
      fi
      if ((kept < keep)); then
        kept=$((kept + 1))
        continue
      fi
      docker image rm "$repo:$tag" >/dev/null 2>&1 && log "Removed old image $repo:$tag"
    done < <(docker image ls "$repo" --format '{{.CreatedAt}}\t{{.Tag}}' | sort -r | cut -f2)
  done
  docker image prune -f >/dev/null 2>&1 || true
  prune_build_cache
}

# The systemd units for this server, from the templates in systemd/.
render_unit() { # render_unit UNIT
  sed -e "s|@USER@|$(id -un)|g" -e "s|@GROUP@|$(id -gn)|g" -e "s|@ROOT@|$root|g" \
    -e "s|@HAMNIVO@|$here/hamnivo.sh|g" -e "s|@ENV_FILE@|$env_file|g" \
    -e "s|@PROJECT@|$project|g" -e "s|@STATE@|$state_dir|g" "$here/systemd/$1"
}

# After a deploy: says so when the new version's units differ from the installed ones.
check_units() {
  local unit
  for unit in hamnivo-deploy.service hamnivo-deploy.path hamnivo-deploy.timer; do
    [[ -f "/etc/systemd/system/$unit" && -f "$here/systemd/$unit" ]] || continue
    if ! render_unit "$unit" | cmp -s - "/etc/systemd/system/$unit"; then
      log "This version changes the systemd units: run hamnivo.sh autodeploy enable to install them."
      return 0
    fi
  done
}

# Checks, builds and starts COMMIT. Returns 0 when it is live (or held for a deploy by hand), 1
# when it failed (the running version stays or is started again), 2 when neither version is
# healthy. Its output goes to the deploy's log file too.
deploy_version() { # deploy_version COMMIT RUNNING_COMMIT RUNNING_TAG TRIGGER
  local target="$1" prev="$2" prev_tag="$3" trigger="$4" tag step guard=0 started=$SECONDS
  local build_dir env_next switch_reason detail
  tag="$(short "$target")"
  log "Deploying $tag: $(git_ log -1 --format=%s "$target" | cut -c1-72)"
  log "Running now: $(short "$prev") (images: $prev_tag); trigger: $trigger"

  if [[ -n "$(git_ status --porcelain --untracked-files=no)" ]]; then
    git_ status --short --untracked-files=no >&2
    log 'Files tracked by git were changed on this server. Commit such changes to the repository'
    log 'instead (or move them to files git ignores); nothing was deployed.'
    record "$target" failed "$trigger" "$((SECONDS - started))" 'local changes on the server'
    return 1
  fi
  if ! check_disk; then
    record "$target" failed "$trigger" "$((SECONDS - started))" 'not enough disk space'
    return 1
  fi
  github_start "$target"

  # 0. What a rollback could not undo.
  check_guards "$prev" "$target" || guard=$?
  if ((guard == 1 && deploy_force == 0)); then
    log "Stopped: $guard_reason. $(short "$prev") keeps running."
    fail_state "$target" guards
    record "$target" failed "$trigger" "$((SECONDS - started))" "stopped at guards: $guard_reason"
    github_status failure "Stopped before building: $guard_reason"
    return 1
  fi
  if ((guard == 2)) && [[ "$trigger" != manual ]]; then
    log "Held: $guard_reason. A rollback could not undo that, so this version waits for you."
    log "Deploy it when ready (a backup is made first): $here/hamnivo.sh deploy $tag"
    mkdir -p "$state_dir/held"
    printf '%s\n' "$guard_reason" >"$state_dir/held/$target"
    record "$target" held "$trigger" "$((SECONDS - started))" "$guard_reason"
    github_status pending "Waiting for a deploy by hand: $guard_reason"
    return 0
  fi
  ((guard == 0)) || log "Deploying although $guard_reason (asked for by hand)."

  # 1. HTTPS must work already. When browsers cannot reach this server over HTTPS either (Caddy
  #    has no certificate), a new version cannot be switched in: its check would fail and the
  #    deploy would roll back after a build for nothing. This is a stop before the switch that
  #    never counts against the commit (see fail_state): automatic runs try it again, every 30
  #    minutes, once HTTPS works. Other failures of the running version do not stop a deploy: the
  #    new version may be the fix. --force skips this check.
  if ((deploy_force == 0)) && ! check_baseline; then
    log "Stopped: $baseline_reason. $(short "$prev") keeps running."
    log "(hamnivo.sh deploy --force $tag deploys without this check.)"
    fail_state "$target" https
    record "$target" failed "$trigger" "$((SECONDS - started))" "stopped before building: $baseline_reason"
    github_status failure "$baseline_reason"
    return 1
  fi

  # 2. Check and build the new version from a clean copy of its files and of the settings, then
  #    back up with the running version's own script. Nothing that runs changes yet.
  build_dir="$state_dir/build/$tag"
  env_next="$build_dir/deploy/production/.env.next"
  # Deploys never overlap, so whatever is here was left by one that was interrupted.
  rm -rf "$state_dir/build"
  mkdir -p "$build_dir"
  step='export'
  if git_ archive --format=tar "$target" | tar -x -C "$build_dir" &&
    install -m 600 "$env_file" "$env_next" &&
    step=setup && HAMNIVO_ENV_FILE="$env_next" bash "$build_dir/deploy/production/hamnivo.sh" setup --quiet &&
    step=checks-and-build && HAMNIVO_ENV_FILE="$env_next" HAMNIVO_RELEASE="$target" \
      bash "$build_dir/deploy/production/hamnivo.sh" build --verify --tag "$tag" &&
    step=backup && backup_if_needed "$prev" "$target"; then
    rm -rf "$build_dir"
  else
    rm -rf "$build_dir"
    log "Stopped at $step; $(short "$prev") keeps running."
    fail_state "$target" "$step"
    record "$target" failed "$trigger" "$((SECONDS - started))" "stopped at $step"
    github_status failure "Stopped at $step; the running version was not touched"
    return 1
  fi

  # 3. Switch: the checkout moves, new settings are added, migrations run and the new version
  #    starts. It must answer over HTTPS and stay healthy. When it does not, fail_reason says why.
  cp "$env_file" "$state_dir/env.before"
  chmod 600 "$state_dir/env.before"
  fail_reason=''
  if git_ checkout --quiet --detach "$target" && "${hamnivo[@]}" setup --quiet &&
    start_version "$target" "$tag" && soak; then
    write_state previous "$prev" "$prev_tag"
    write_state current "$target" "$tag"
    # Versions held before this one are older than what now runs.
    rm -rf "$state_dir/held"
    rm -f "$state_dir/failed/$target" "$state_dir/env.before"
    record "$target" live "$trigger" "$((SECONDS - started))" "replaced $(short "$prev")"
    github_status success "Live"
    prune_images
    check_units
    log "$tag is live (took $((SECONDS - started)) s)."
    return 0
  fi

  # 4. Roll back: the settings, the files and the images of the version that ran before.
  switch_reason="$fail_reason"
  log "$tag is not healthy${switch_reason:+ ($switch_reason)}; starting $(short "$prev") again"
  fail_state "$target" start
  restore_env
  if start_version "$prev" "$prev_tag"; then
    record "$target" rolled-back "$trigger" "$((SECONDS - started))" "${switch_reason:+$switch_reason; }$(short "$prev") runs again"
    github_status failure "${switch_reason:-Not healthy}; rolled back to $(short "$prev")"
    log "Rolled back: $(short "$prev") runs again."
    return 1
  fi
  detail='neither version is healthy'
  if [[ -n "$switch_reason" ]]; then detail+="; the new one: $switch_reason"; fi
  if [[ -n "$fail_reason" ]]; then detail+="; the previous one: $fail_reason"; fi
  record "$target" broken "$trigger" "$((SECONDS - started))" "$detail"
  github_status error "Not healthy, and the previous version did not start either${fail_reason:+: $fail_reason}"
  log "Neither $tag nor $(short "$prev") is healthy. See this log and hamnivo.sh status."
  log "If the database changed, the backup made before this deploy is in $here/backups/before-deploy."
  return 2
}

# --- commands ------------------------------------------------------------------------------------
cmd_deploy() {
  local target_ref='' trigger=manual automatic=0
  while (($#)); do
    case "$1" in
      --latest) target_ref=''; shift ;;
      --force) deploy_force=1; shift ;;
      --trigger) trigger="${2:?--trigger needs a value}"; shift 2 ;;
      # Accepted for older habits (update --no-backup): a deploy backs up when it needs to.
      --no-backup) shift ;;
      -*) fail "Unknown deploy option: $1" ;;
      *) target_ref="$1"; shift ;;
    esac
  done
  need_docker
  need_env
  command -v git >/dev/null || fail 'git is required.'
  command -v curl >/dev/null || fail 'curl is required.'
  mkdir -p "$state_dir/requests"
  # The systemd service says "auto"; it recorded whether a webhook request was waiting.
  if [[ "$trigger" == auto ]]; then
    trigger="$(cat "$state_dir/trigger" 2>/dev/null || echo timer)"
  fi
  [[ "$trigger" == manual ]] || automatic=1
  if ((automatic == 1)) && [[ -f "$state_dir/paused" ]]; then
    log 'Automatic deploys are paused (hamnivo.sh autodeploy resume).'
    return 0
  fi
  # One at a time. An automatic run leaves when another is busy: a push that arrives meanwhile is
  # picked up by the next run (its webhook request waits, and the timer runs every 5 minutes).
  if ((automatic == 1)); then
    exec 9>"$state_dir/deploy.lock"
    flock -n 9 || {
      log 'A deploy, backup or restore is running; trying again later.'
      return 0
    }
    export HAMNIVO_LOCK_HELD=1
  else
    take_lock
  fi
  unset HAMNIVO_IMAGE_TAG

  local branch target running prompt=0 https_stop=0
  branch="$(get HAMNIVO_DEPLOY_BRANCH)"
  branch="${branch:-main}"
  # A person at a terminal may type git credentials; automatic runs never wait for anyone.
  ((automatic == 0)) && [[ -t 0 ]] && prompt=1
  GIT_TERMINAL_PROMPT=$prompt git -C "$root" fetch --quiet --prune --tags "$remote" \
    "+refs/heads/$branch:refs/remotes/$remote/$branch" ||
    fail "Could not fetch from $remote (hamnivo.sh autodeploy status shows the git access)."
  target="$(git_ rev-parse --verify --quiet "${target_ref:-$remote/$branch}^{commit}")" ||
    fail "Unknown commit, tag or branch: ${target_ref:-$remote/$branch}"
  running="$(running_version)"
  if [[ "$target" == "${running%% *}" ]] && ((deploy_force == 0)) && known_live "$target" &&
    docker image inspect "hamnivo/gateway:${running##* }" >/dev/null 2>&1; then
    ((automatic == 1)) || log "$(short "$target") is already live."
    return 0
  fi
  if ((automatic == 1 && deploy_force == 0)); then
    # Held versions wait for a person; they were announced when they were held.
    [[ -f "$state_dir/held/$target" ]] && return 0
    if [[ -f "$state_dir/failed/$target" ]]; then
      [[ "$(failed_step "$target")" == https ]] && https_stop=1
      if ! may_retry "$target"; then
        if [[ "$trigger" != timer ]]; then
          if ((https_stop == 1)); then
            log "$(short "$target") waits until HTTPS works on this server; it is tried again every 30 minutes (hamnivo.sh doctor)."
          else
            log "$(short "$target") failed before and is not retried automatically (hamnivo.sh deploy --force $(short "$target"))."
          fi
        fi
        return 0
      fi
      if ((https_stop == 1)); then
        log "Trying $(short "$target") again: HTTPS did not work on this server 30 minutes ago."
      else
        log "Trying $(short "$target") once more: it stopped before the switch 30 minutes ago."
      fi
    fi
  fi

  # Everything also goes to this deploy's log file. A pipe, not a process substitution, so that
  # the last lines are written before the service ends; set -e still applies inside.
  mkdir -p "$state_dir/logs"
  local logfile status
  logfile="$state_dir/logs/$(date -u +%Y%m%dT%H%M%SZ)-$(short "$target").log"
  set +e
  (
    set -e
    deploy_version "$target" "${running%% *}" "${running##* }" "$trigger"
  ) 2>&1 | tee -a "$logfile"
  status="${PIPESTATUS[0]}"
  set -e
  log "The log of this deploy: $logfile"
  return "$status"
}

cmd_rollback() {
  need_docker
  need_env
  take_lock
  unset HAMNIVO_IMAGE_TAG
  local target tag line running
  running="$(running_version)"
  if (($#)); then
    target="$(git_ rev-parse --verify --quiet "$1^{commit}")" || fail "Unknown commit: $1"
    tag="$(short "$target")"
    line="$(read_state previous)"
    [[ "${line%% *}" == "$target" ]] && tag="${line##* }"
  else
    line="$(read_state previous)"
    [[ -n "$line" ]] || fail 'No earlier version is recorded yet.'
    target="${line%% *}"
    tag="${line##* }"
  fi
  docker image inspect "hamnivo/gateway:$tag" "hamnivo/edge:$tag" >/dev/null 2>&1 ||
    fail "The images of $(short "$target") are gone; build it again with: hamnivo.sh deploy --force $(short "$target")"
  local started=$SECONDS
  github_start "$target"
  log "Rolling back to $(short "$target") (images: $tag)"
  if start_version "$target" "$tag"; then
    write_state previous "${running%% *}" "${running##* }"
    write_state current "$target" "$tag"
    # The version rolled back from is still the branch's newest commit: automatic deploys must
    # not bring it straight back. They resume with the next commit.
    mkdir -p "$state_dir/failed"
    printf '1 left-by-rollback\n' >"$state_dir/failed/${running%% *}"
    record "$target" live manual-rollback "$((SECONDS - started))" "replaced $(short "${running%% *}")"
    github_status success 'Rolled back by hand'
    log "$(short "$target") runs again. Automatic deploys resume with the next new commit."
  else
    record "$target" failed manual-rollback "$((SECONDS - started))" "${fail_reason:-not healthy}"
    github_status failure "Rollback did not come up healthy${fail_reason:+: $fail_reason}"
    fail "$(short "$target") did not come up healthy${fail_reason:+ ($fail_reason)}; see hamnivo.sh status."
  fi
}

cmd_deploys() {
  local count="${1:-20}" line file
  line="$(read_state current)"
  [[ -n "$line" ]] && printf 'Live:     %s (images %s)\n' "$(short "${line%% *}")" "${line##* }"
  line="$(read_state previous)"
  [[ -n "$line" ]] && printf 'Previous: %s (images %s)\n' "$(short "${line%% *}")" "${line##* }"
  [[ -f "$state_dir/paused" ]] && printf 'Automatic deploys are paused.\n'
  for file in "$state_dir"/held/*; do
    [[ -f "$file" ]] || continue
    printf 'Waiting for a deploy by hand: %s, because %s (hamnivo.sh deploy %s)\n' \
      "$(short "$(basename "$file")")" "$(cat "$file")" "$(short "$(basename "$file")")"
  done
  if [[ ! -s "$state_dir/history.tsv" ]]; then
    printf 'No deploys yet.\n'
    return 0
  fi
  printf '\n'
  {
    printf 'TIME\tCOMMIT\tRESULT\tTRIGGER\tTOOK\tDETAIL\n'
    tail -n "$count" "$state_dir/history.tsv"
  } >"$work/history"
  if command -v column >/dev/null; then
    column -t -s $'\t' "$work/history"
  else
    tr '\t' ' ' <"$work/history"
  fi
}

# --- autodeploy ----------------------------------------------------------------------------------
repository_of() { # owner/name of a GitHub remote URL, or nothing
  local url="$1"
  case "$url" in
    https://github.com/*) url="${url#https://github.com/}" ;;
    git@github.com:*) url="${url#git@github.com:}" ;;
    ssh://git@github.com/*) url="${url#ssh://git@github.com/}" ;;
    *) return 0 ;;
  esac
  printf '%s' "${url%.git}"
}

new_deploy_key=''

# Makes `git fetch` work without a person: a remote that already works (a public repository, or a
# credential helper) stays; a private GitHub repository gets a read-only deploy key over SSH, with
# GitHub's host key pinned.
setup_git_access() {
  local url repository key
  url="$(git_ remote get-url "$remote")" || fail "This checkout has no git remote named $remote."
  repository="$(repository_of "$url")"
  [[ -n "$repository" ]] && set_kv HAMNIVO_DEPLOY_REPOSITORY "$repository"
  if git_ ls-remote --exit-code "$remote" HEAD >/dev/null 2>&1; then
    log "Git access works ($url)."
    return 0
  fi
  [[ -n "$repository" ]] || fail "Cannot read $url without a person; give this server access to it first."
  key="$HOME/.ssh/hamnivo_deploy_ed25519"
  if [[ ! -f "$key" ]]; then
    mkdir -p "$HOME/.ssh"
    chmod 700 "$HOME/.ssh"
    ssh-keygen -q -t ed25519 -N '' -C "hamnivo-deploy@$(uname -n)" -f "$key"
    new_deploy_key="$(cat "$key.pub")"
  fi
  printf '%s\n' "$github_host_key" >"$state_dir/known_hosts"
  git_ config core.sshCommand \
    "ssh -i '$key' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='$state_dir/known_hosts' -o HostKeyAlgorithms=ssh-ed25519 -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"
  git_ remote set-url "$remote" "git@github.com:$repository.git"
  if ! git_ ls-remote --exit-code "$remote" HEAD >/dev/null 2>&1; then
    cat >&2 <<EOF

This server cannot read the repository yet. On GitHub, open
  https://github.com/$repository/settings/keys  →  Add deploy key
  Title: $(uname -n)   Key: (below)   Allow write access: leave it off

$(cat "$key.pub")

Then run this again: $here/hamnivo.sh autodeploy enable
EOF
    exit 1
  fi
  log "Git access works over SSH with the deploy key $key."
}

profiles() { # profiles add|remove NAME: edits COMPOSE_PROFILES in .env
  local list=() out='' p
  IFS=',' read -r -a list <<<"$(get COMPOSE_PROFILES)"
  for p in "${list[@]}"; do
    [[ -n "$p" && "$p" != "$2" ]] && out+="${out:+,}$p"
  done
  [[ "$1" == add ]] && out+="${out:+,}$2"
  set_kv COMPOSE_PROFILES "$out"
}

sudo_() { if ((EUID == 0)); then "$@"; else sudo "$@"; fi; }

install_units() { # install_units MODE
  command -v systemctl >/dev/null ||
    fail 'Automatic deploys need systemd (or run "hamnivo.sh deploy --latest --trigger timer" from cron).'
  local unit
  for unit in hamnivo-deploy.service hamnivo-deploy.path hamnivo-deploy.timer; do
    render_unit "$unit" | sudo_ tee "/etc/systemd/system/$unit" >/dev/null
  done
  sudo_ systemctl daemon-reload
  sudo_ systemctl enable --now hamnivo-deploy.timer >/dev/null
  if [[ "$1" == webhook ]]; then
    sudo_ systemctl enable --now hamnivo-deploy.path >/dev/null
  else
    sudo_ systemctl disable --now hamnivo-deploy.path >/dev/null 2>&1 || true
  fi
  log 'Installed the systemd units hamnivo-deploy.{service,path,timer}.'
}

autodeploy_enable() {
  need_docker
  need_env
  local mode=webhook token_file='' systemd=1
  while (($#)); do
    case "$1" in
      --mode) mode="${2:?--mode needs webhook or poll}"; shift 2 ;;
      --github-token-file) token_file="${2:?--github-token-file needs a file}"; shift 2 ;;
      --no-systemd) systemd=0; shift ;;
      *) fail "Unknown autodeploy option: $1" ;;
    esac
  done
  [[ "$mode" == webhook || "$mode" == poll ]] || fail '--mode is webhook or poll.'
  command -v git >/dev/null || fail 'git is required.'
  command -v curl >/dev/null || fail 'curl is required (sudo apt-get install curl).'
  command -v flock >/dev/null || fail 'flock is required (sudo apt-get install util-linux).'
  # Deploys run as the user who runs this; git refuses to work in another user's checkout.
  [[ "$(stat -c %u "$root")" == "$(id -u)" ]] ||
    fail "Run this as the owner of $root ($(stat -c %U "$root")), without sudo."
  mkdir -p "$state_dir/requests" "$state_dir/logs" "$state_dir/failed"
  chmod 770 "$state_dir/requests"

  setup_git_access
  local branch
  branch="$(get HAMNIVO_DEPLOY_BRANCH)"
  branch="${branch:-main}"
  git_ ls-remote --exit-code "$remote" "refs/heads/$branch" >/dev/null ||
    fail "The remote has no branch $branch (set HAMNIVO_DEPLOY_BRANCH in $env_file)."
  # The version running now is what the first deploy rolls back to. It is recorded only when its
  # images name this commit; otherwise the first automatic run deploys the branch (with a backup).
  if [[ ! -f "$state_dir/current" && "$(api_commit)" == "$(git_ rev-parse HEAD)" ]]; then
    write_state current "$(git_ rev-parse HEAD)" "$(image_tag)"
  fi

  set_kv HAMNIVO_AUTODEPLOY "$mode"
  # The receiver creates request files as the deploy user. A root deploy user gets nobody instead
  # (the receiver never needs root); root can still read and empty the folder.
  if ((EUID == 0)); then
    chown 65534:65534 "$state_dir/requests"
    set_kv HAMNIVO_DEPLOY_UID 65534
    set_kv HAMNIVO_DEPLOY_GID 65534
  else
    set_kv HAMNIVO_DEPLOY_UID "$(id -u)"
    set_kv HAMNIVO_DEPLOY_GID "$(id -g)"
  fi
  if [[ -n "$token_file" ]]; then
    [[ -s "$token_file" ]] || fail "No token in $token_file."
    set_kv GITHUB_DEPLOY_TOKEN "$(tr -d '[:space:]' <"$token_file")"
    log 'Saved the GitHub token: deploys will appear under Environments → production.'
  fi
  if [[ "$mode" == webhook ]]; then
    [[ -n "$(get HAMNIVO_DEPLOY_REPOSITORY)" ]] ||
      fail "Set HAMNIVO_DEPLOY_REPOSITORY=owner/name in $env_file (the webhook accepts only that repository)."
    ensure HAMNIVO_DEPLOY_WEBHOOK_SECRET "$(openssl rand -hex 32)"
    profiles add autodeploy
    log 'Starting the webhook receiver and turning on its route'
    "${hamnivo[@]}" build --hook
    "${compose[@]}" up -d --no-deps deploy-hook edge >&2
    wait_healthy deploy-hook edge
  else
    profiles remove autodeploy
    "${compose[@]}" rm -sf deploy-hook >/dev/null 2>&1 || true
    "${compose[@]}" up -d --no-deps edge >&2
    wait_healthy edge
  fi
  ((systemd == 1)) && install_units "$mode"

  local repository
  repository="$(get HAMNIVO_DEPLOY_REPOSITORY)"
  cat >&2 <<EOF

Automatic deploys are on: every push to $branch goes live after its checks pass (mode: $mode).
EOF
  if [[ -n "$new_deploy_key" ]]; then
    printf '\nThe deploy key of this server (added on GitHub already, since fetching works):\n  %s\n' \
      "$new_deploy_key" >&2
  fi
  if [[ "$mode" == webhook ]]; then
    cat >&2 <<EOF

On GitHub, add the webhook: https://github.com/$repository/settings/hooks  →  Add webhook
  Payload URL    $(get HAMNIVO_API_ORIGIN)/_deploy/github
  Content type   application/json
  Secret         $(get HAMNIVO_DEPLOY_WEBHOOK_SECRET)
  Events         Just the push event
GitHub then sends a ping; "Recent Deliveries" should show 200.
EOF
  fi
  cat >&2 <<EOF

Also on GitHub:
  - Protect $branch (Settings → Branches): require a pull request and block force pushes, because
    whatever reaches $branch goes live.
  - Optional: GitHub can show each deploy under Environments → production. Create a fine-grained
    token (this repository only, "Deployments: Read and write"), save it in a file, and run:
      $here/hamnivo.sh autodeploy enable --github-token-file /path/to/file

Watch deploys: $here/hamnivo.sh deploys   (live: journalctl -u hamnivo-deploy -f)
Pause them:    $here/hamnivo.sh autodeploy pause
EOF
}

autodeploy_disable() {
  need_env
  if command -v systemctl >/dev/null && [[ -f /etc/systemd/system/hamnivo-deploy.service ]]; then
    sudo_ systemctl disable --now hamnivo-deploy.path hamnivo-deploy.timer >/dev/null 2>&1 || true
    sudo_ rm -f /etc/systemd/system/hamnivo-deploy.{service,path,timer}
    sudo_ systemctl daemon-reload
  fi
  set_kv HAMNIVO_AUTODEPLOY off
  profiles remove autodeploy
  "${compose[@]}" rm -sf deploy-hook >/dev/null 2>&1 || true
  "${compose[@]}" up -d --no-deps edge >&2
  log 'Automatic deploys are off. Deploy by hand with: hamnivo.sh update'
  log 'Remove the webhook on GitHub too (Settings → Webhooks).'
}

autodeploy_status() {
  need_env
  local mode unit state
  mode="$(get HAMNIVO_AUTODEPLOY)"
  printf 'Mode:       %s%s\n' "${mode:-off}" "$([[ -f "$state_dir/paused" ]] && echo ' (paused)')"
  printf 'Branch:     %s of %s\n' "$(get HAMNIVO_DEPLOY_BRANCH)" "$(git_ remote get-url "$remote" 2>/dev/null)"
  if git_ ls-remote --exit-code "$remote" HEAD >/dev/null 2>&1; then
    printf 'Git access: works\n'
  else
    printf 'Git access: FAILS (see: hamnivo.sh autodeploy enable)\n'
  fi
  [[ "$mode" == webhook ]] && printf 'Webhook:    %s/_deploy/github\n' "$(get HAMNIVO_API_ORIGIN)"
  printf 'Statuses:   %s\n' "$([[ -n "$(get GITHUB_DEPLOY_TOKEN)" ]] && echo 'reported to GitHub' || echo 'not reported (no GITHUB_DEPLOY_TOKEN)')"
  if command -v systemctl >/dev/null; then
    for unit in hamnivo-deploy.path hamnivo-deploy.timer hamnivo-deploy.service; do
      state="$(systemctl is-active "$unit" 2>/dev/null || true)"
      printf '%-22s %s\n' "$unit" "${state:-not installed}"
    done
  fi
  printf '\n'
  cmd_deploys 5
  printf '\nDeploys fail or roll back? Check the whole server: %s/hamnivo.sh doctor\n' "$here"
}

cmd_autodeploy() {
  local action="${1:-status}"
  shift || true
  case "$action" in
    enable) autodeploy_enable "$@" ;;
    disable) autodeploy_disable ;;
    pause)
      mkdir -p "$state_dir"
      : >"$state_dir/paused"
      log 'Automatic deploys are paused. Resume with: hamnivo.sh autodeploy resume'
      ;;
    resume)
      rm -f "$state_dir/paused"
      log 'Automatic deploys are resumed.'
      ;;
    status) autodeploy_status ;;
    *) fail "Unknown autodeploy action: $action (enable, disable, pause, resume or status)" ;;
  esac
}

main() {
  local command="${1:-}"
  shift || true
  case "$command" in
    deploy) cmd_deploy "$@" ;;
    rollback) cmd_rollback "$@" ;;
    deploys) cmd_deploys "$@" ;;
    autodeploy) cmd_autodeploy "$@" ;;
    *) fail "Unknown command: ${command:-none} (deploy, rollback, deploys or autodeploy)" ;;
  esac
}

# One line: bash has read all of it before a deploy checks out another version of this file.
main "$@"; exit
