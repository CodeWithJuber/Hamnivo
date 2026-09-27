#!/usr/bin/env bash
# Deploys Hamnivo from git. Run it through hamnivo.sh: deploy, rollback, deploys, autodeploy.
#
# A deploy takes the newest commit of the deploy branch (HAMNIVO_DEPLOY_BRANCH, default main) from
# the git remote. It checks that commit (Biome, type checks, unit tests), builds its images and
# starts it. If the new version does not come up healthy, the version that ran before is started
# again. See docs/self-hosting.md, "Automatic deployment from GitHub".
#
#   hamnivo.sh deploy [--latest | REF] [--force]   REF: a commit, tag or branch
#   hamnivo.sh rollback [COMMIT]                   default: the version that ran before
#   hamnivo.sh deploys [N]                         the last N deploys (default 20)
#   hamnivo.sh autodeploy enable [--mode webhook|poll] [--github-token-file FILE] [--no-systemd]
#   hamnivo.sh autodeploy disable | pause | resume | status
#
# State, in HAMNIVO_STATE_DIR (next to .env):
#   current, previous   "<commit> <image tag>" of the live version and the one before
#   history.tsv         one line per deploy; logs/ holds each deploy's full log
#   failed/<commit>     commits that failed; automatic deploys skip them until a newer commit
#   requests/           the webhook receiver creates a file here for each accepted push
#   paused, deploy.lock
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/production/lib.sh
source "$here/lib.sh"

hamnivo=(bash "$here/hamnivo.sh")
remote="${HAMNIVO_DEPLOY_REMOTE:-origin}"
# GitHub's published SSH host key (docs.github.com, "GitHub's SSH key fingerprints"):
# SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU
github_host_key='github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

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

# "<commit> <tag>" of the live version. Before the first deploy: HEAD and the images running now.
running_version() {
  local line
  line="$(read_state current)"
  [[ -n "$line" ]] || line="$(git_ rev-parse HEAD) $(image_tag)"
  printf '%s' "$line"
}

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
  local limit="${1:-${HAMNIVO_DEPLOY_BUILD_CACHE_GB:-8}}gb"
  docker builder prune --all -f --max-used-space "$limit" >/dev/null 2>&1 ||
    docker builder prune --all -f --keep-storage "$limit" >/dev/null 2>&1 ||
    docker builder prune --all -f --filter until=168h >/dev/null 2>&1 || true
}

check_disk() {
  local dir free need="${HAMNIVO_DEPLOY_MIN_FREE_GB:-8}"
  dir="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  free="$(df -Pk "$dir" 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }')"
  ((${free:-0} >= need)) && return 0
  log "Only ${free:-0} GB free for Docker; shrinking the build cache"
  prune_build_cache 2
  free="$(df -Pk "$dir" 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }')"
  ((${free:-0} >= need)) || {
    log "Not enough disk space: ${free:-0} GB free, $need GB needed (HAMNIVO_DEPLOY_MIN_FREE_GB)."
    return 1
  }
}

# Checks the stack from outside, through the edge: API health, Studio and the chat loader.
probe() {
  local port url host ca=()
  port="$(get HAMNIVO_HTTPS_PORT)"
  if [[ "$(get HAMNIVO_TLS)" == internal ]] &&
    "${compose[@]}" exec -T edge cat /data/caddy/pki/authorities/local/root.crt >"$work/ca.crt" 2>/dev/null; then
    ca=(--cacert "$work/ca.crt")
  fi
  for url in "$(get HAMNIVO_API_ORIGIN)/health/ready" "$(get HAMNIVO_APP_ORIGIN)/" \
    "$(get HAMNIVO_CHAT_ORIGIN)/loader.js"; do
    host="${url#https://}"
    host="${host%%/*}"
    host="${host%%:*}"
    if ! curl -fsS -o /dev/null --max-time 10 --retry 10 --retry-delay 3 --retry-all-errors \
      --resolve "$host:$port:127.0.0.1" "${ca[@]}" "$url"; then
      log "Not reachable over HTTPS: $url"
      return 1
    fi
  done
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

# --- phases --------------------------------------------------------------------------------------
# Starts COMMIT with the images TAG, using that version's own hamnivo.sh, then checks it.
start_version() { # start_version COMMIT TAG
  git_ checkout --quiet --detach "$1" || return 1
  set_kv HAMNIVO_IMAGE_TAG "$2"
  HAMNIVO_FAIL_UNHEALTHY=1 HAMNIVO_WAIT_SECONDS="${HAMNIVO_DEPLOY_HEALTH_SECONDS:-600}" \
    "${hamnivo[@]}" up --no-build --quiet || return 1
  probe || return 1
  runs_commit "$1" || {
    log "The API does not run $(short "$1")."
    return 1
  }
}

# A version that changes the database is backed up first (a separate rotation of 5).
backup_if_migrations() { # backup_if_migrations FROM TO
  git_ diff --quiet "$1" "$2" -- packages/db/migrations 2>/dev/null && return 0
  log 'This version changes the database: backing up first'
  "${hamnivo[@]}" backup --to "$here/backups/before-deploy" --keep "${HAMNIVO_DEPLOY_BACKUPS:-5}"
}

# Removes images of old versions: keeps the live one, the one before, and the newest others up to
# HAMNIVO_DEPLOY_KEEP (default 3) in all; then shrinks the build cache.
prune_images() {
  local keep="${HAMNIVO_DEPLOY_KEEP:-3}" repo tag kept current_tag previous_tag
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

# Checks, builds and starts COMMIT. Returns 0 when it is live, 1 when it failed (the running
# version stays or is started again), 2 when neither version is healthy.
deploy_version() { # deploy_version COMMIT RUNNING_COMMIT RUNNING_TAG TRIGGER
  local target="$1" prev="$2" prev_tag="$3" trigger="$4" tag step started=$SECONDS logfile
  tag="$(short "$target")"
  mkdir -p "$state_dir/logs" "$state_dir/failed"
  logfile="$state_dir/logs/$(date -u +%Y%m%dT%H%M%SZ)-$tag.log"
  # From here on, everything also goes to this deploy's log file.
  exec > >(tee -a "$logfile") 2>&1
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

  # 1. Check and build the new version from its own files. Nothing that runs changes yet.
  step=checkout
  if git_ checkout --quiet --detach "$target" &&
    step=setup && "${hamnivo[@]}" setup --quiet &&
    step=checks-and-build && HAMNIVO_RELEASE="$target" "${hamnivo[@]}" build --verify --tag "$tag" &&
    step=backup && backup_if_migrations "$prev" "$target"; then
    :
  else
    log "Stopped at $step; $(short "$prev") keeps running."
    git_ checkout --quiet --detach "$prev" || true
    : >"$state_dir/failed/$target"
    record "$target" failed "$trigger" "$((SECONDS - started))" "stopped at $step"
    github_status failure "Stopped at $step; the running version was not touched"
    return 1
  fi

  # 2. Switch: migrations run, the new version starts, and it must answer.
  if start_version "$target" "$tag"; then
    write_state previous "$prev" "$prev_tag"
    write_state current "$target" "$tag"
    rm -f "$state_dir/failed/$target"
    record "$target" live "$trigger" "$((SECONDS - started))" "replaced $(short "$prev")"
    github_status success "Live"
    prune_images
    log "$tag is live (took $((SECONDS - started)) s)."
    return 0
  fi

  # 3. Roll back to the version that ran before.
  log "$tag is not healthy; starting $(short "$prev") again"
  : >"$state_dir/failed/$target"
  if start_version "$prev" "$prev_tag"; then
    record "$target" rolled-back "$trigger" "$((SECONDS - started))" "$(short "$prev") runs again"
    github_status failure "Not healthy; rolled back to $(short "$prev")"
    log "Rolled back: $(short "$prev") runs again. The log of this deploy: $logfile"
    return 1
  fi
  record "$target" broken "$trigger" "$((SECONDS - started))" 'neither version is healthy'
  github_status error 'Not healthy, and the previous version did not start either'
  log "Neither $tag nor $(short "$prev") is healthy. See $logfile and hamnivo.sh status."
  log "If the database changed, the backup taken before this deploy is in $here/backups/before-deploy."
  return 2
}

# --- commands ------------------------------------------------------------------------------------
cmd_deploy() {
  local target_ref='' force=0 trigger=manual automatic=0
  while (($#)); do
    case "$1" in
      --latest) target_ref=''; shift ;;
      --force) force=1; shift ;;
      --trigger) trigger="${2:?--trigger needs a value}"; shift 2 ;;
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

  local branch target running
  branch="$(get HAMNIVO_DEPLOY_BRANCH)"
  branch="${branch:-main}"
  git_ fetch --quiet --prune --tags "$remote" "+refs/heads/$branch:refs/remotes/$remote/$branch" ||
    fail "Could not fetch from $remote (hamnivo.sh autodeploy status shows the git access)."
  target="$(git_ rev-parse --verify --quiet "${target_ref:-$remote/$branch}^{commit}")" ||
    fail "Unknown commit, tag or branch: ${target_ref:-$remote/$branch}"
  running="$(running_version)"
  if [[ "$target" == "${running%% *}" ]] && ((force == 0)) &&
    docker image inspect "hamnivo/gateway:${running##* }" >/dev/null 2>&1; then
    ((automatic == 1)) || log "$(short "$target") is already live."
    return 0
  fi
  if [[ -f "$state_dir/failed/$target" ]] && ((automatic == 1 && force == 0)); then
    log "$(short "$target") failed before and is not retried automatically (hamnivo.sh deploy --force $(short "$target"))."
    return 0
  fi
  deploy_version "$target" "${running%% *}" "${running##* }" "$trigger"
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
  docker image inspect "hamnivo/gateway:$tag" >/dev/null 2>&1 ||
    fail "The images of $(short "$target") are gone; build it again with: hamnivo.sh deploy --force $(short "$target")"
  local started=$SECONDS
  github_start "$target"
  log "Rolling back to $(short "$target") (images: $tag)"
  if start_version "$target" "$tag"; then
    write_state previous "${running%% *}" "${running##* }"
    write_state current "$target" "$tag"
    # The version rolled back from is still the branch's newest commit: automatic deploys must
    # not bring it straight back. They resume with the next commit.
    : >"$state_dir/failed/${running%% *}"
    record "$target" live manual-rollback "$((SECONDS - started))" "replaced $(short "${running%% *}")"
    github_status success 'Rolled back by hand'
    log "$(short "$target") runs again. Automatic deploys resume with the next new commit."
  else
    record "$target" failed manual-rollback "$((SECONDS - started))" 'not healthy'
    github_status failure 'Rollback did not come up healthy'
    fail "$(short "$target") did not come up healthy; see hamnivo.sh status."
  fi
}

cmd_deploys() {
  local count="${1:-20}" line
  line="$(read_state current)"
  [[ -n "$line" ]] && printf 'Live:     %s (images %s)\n' "$(short "${line%% *}")" "${line##* }"
  line="$(read_state previous)"
  [[ -n "$line" ]] && printf 'Previous: %s (images %s)\n' "$(short "${line%% *}")" "${line##* }"
  [[ -f "$state_dir/paused" ]] && printf 'Automatic deploys are paused.\n'
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
    "ssh -i '$key' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='$state_dir/known_hosts'"
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
    sed -e "s|@USER@|$(id -un)|g" -e "s|@GROUP@|$(id -gn)|g" -e "s|@ROOT@|$root|g" \
      -e "s|@HAMNIVO@|$here/hamnivo.sh|g" -e "s|@ENV_FILE@|$env_file|g" \
      -e "s|@PROJECT@|$project|g" -e "s|@STATE@|$state_dir|g" "$here/systemd/$unit" |
      sudo_ tee "/etc/systemd/system/$unit" >/dev/null
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
  mkdir -p "$state_dir/requests" "$state_dir/logs" "$state_dir/failed"
  chmod 770 "$state_dir/requests"

  setup_git_access
  local branch
  branch="$(get HAMNIVO_DEPLOY_BRANCH)"
  branch="${branch:-main}"
  git_ ls-remote --exit-code "$remote" "refs/heads/$branch" >/dev/null ||
    fail "The remote has no branch $branch (set HAMNIVO_DEPLOY_BRANCH in $env_file)."
  # The version running now is what the first deploy rolls back to.
  [[ -f "$state_dir/current" ]] || write_state current "$(git_ rev-parse HEAD)" "$(image_tag)"

  set_kv HAMNIVO_AUTODEPLOY "$mode"
  set_kv HAMNIVO_DEPLOY_UID "$(id -u)"
  set_kv HAMNIVO_DEPLOY_GID "$(id -g)"
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
