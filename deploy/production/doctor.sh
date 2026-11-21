#!/usr/bin/env bash
# Checks this server and says how to fix what is wrong. Run it on the server, through hamnivo.sh.
#
#   hamnivo.sh doctor
#
# One line for each check: ✓ when it is fine, ✗ when it is not, and under each ✗ one line saying what
# to do and the exact command. The exit status is 1 when any check fails. It only reads: no setting,
# service or data changes, and the one thing it writes is git's copy of origin/main (a fetch, as every
# deploy makes it). It never prints a secret: of the settings it shows names, and "set" or "not set",
# never values.
#
# Checks: Docker and the services; HTTPS for every public name (HAMNIVO_APP_HOST, HAMNIVO_API_HOST,
# HAMNIVO_CHAT_HOST, HAMNIVO_SUPPORT_HOST, HAMNIVO_SITE_HOSTS), the way a deploy checks it; ports 80
# and 443; disk space and Docker's build cache; memory and swap; the volume that keeps Caddy's
# certificates; automatic deploys (mode, systemd units, git access, how far behind origin the
# checkout is, the last three deploys); scheduled backups (the timers, the last runs, the age of the
# newest); and the Jev key.
# HAMNIVO_MEMINFO names another file than /proc/meminfo (for tests).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/production/lib.sh
source "$here/lib.sh"

hv="$here/hamnivo.sh"
failures=0
docker_ok=0
tmp=''
# Services that run once and stop: they are no part of the health check.
one_shot='db-init migrate chatwoot-prepare'

# --- the report ----------------------------------------------------------------------------------
green=''
red=''
plain=''
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  green=$'\033[1;32m'
  red=$'\033[1;31m'
  plain=$'\033[0m'
fi

pass() { printf '%s✓%s %s\n' "$green" "$plain" "$*"; }
note() { printf '    %s\n' "$*"; }
# A failed check: what is wrong, one line saying what to do, and the exact command.
problem() { # problem WHAT FIX [COMMAND]
  failures=$((failures + 1))
  printf '%s✗%s %s\n' "$red" "$plain" "$1"
  printf '    Fix: %s\n' "$2"
  if [[ -n "${3:-}" ]]; then printf '    Run: %s\n' "$3"; fi
}

with_timeout() { # with_timeout SECONDS COMMAND...: a network that hangs cannot hold doctor
  if command -v timeout >/dev/null; then timeout "$@"; else shift && "$@"; fi
}

plural() { # plural N WORD
  if (($1 == 1)); then printf '1 %s' "$2"; else printf '%s %ss' "$1" "$2"; fi
}

join() { # join WORD...: "a, b, c"
  local out='' word
  for word in "$@"; do out+="${out:+, }$word"; done
  printf '%s' "$out"
}

# --- Docker and the services ---------------------------------------------------------------------
check_docker() {
  local version
  if ! command -v docker >/dev/null; then
    problem 'Docker is not installed' 'install Docker and its Compose plugin.' 'curl -fsSL https://get.docker.com | sudo sh'
    return 0
  fi
  if version="$(docker info --format '{{.ServerVersion}}' 2>"$tmp/docker.err")" && [[ -n "$version" ]]; then
    if docker compose version >/dev/null 2>&1; then
      docker_ok=1
      pass "Docker runs (version $version, with the Compose plugin)"
    else
      problem 'The Docker Compose plugin is missing' 'install Docker with its Compose plugin.' 'curl -fsSL https://get.docker.com | sudo sh'
    fi
  elif grep -qi 'permission denied' "$tmp/docker.err"; then
    problem 'Docker runs, but this user may not use it' 'add this user to the docker group, then log out and in again.' "sudo usermod -aG docker \$USER"
  else
    problem 'Docker is not running' 'start it, and make it start at boot.' 'sudo systemctl enable --now docker'
  fi
}

check_services() {
  local services service state restarts count=0 bad=()
  if ((docker_ok == 0)); then
    problem 'Services: cannot be checked while Docker is down' 'fix the Docker line above first.' "$hv status"
    return 0
  fi
  if ! services="$("${compose[@]}" config --services 2>/dev/null)" || [[ -z "$services" ]]; then
    problem 'Services: Docker Compose cannot read this stack' 'add the settings that are missing.' "$hv setup --quiet"
    return 0
  fi
  for service in $services; do
    case " $one_shot " in *" $service "*) continue ;; esac
    count=$((count + 1))
    read -r state restarts <<<"$(service_state "$service")"
    if [[ "$state" != healthy && "$state" != running ]]; then
      bad+=("$service is $state")
    elif ((restarts >= 3)); then
      bad+=("$service keeps restarting")
    fi
  done
  if ((${#bad[@]} == 0)); then
    pass "Services: all $count are healthy"
    return 0
  fi
  problem "Services: $(join "${bad[@]}")" 'start what is down; one that stays unhealthy says why in its log.' "$hv up --no-build"
  note "The log of the first: $hv logs ${bad[0]%% *}"
}

# --- HTTPS for every public name -----------------------------------------------------------------
# The page that proves a name works: what a deploy asks for, and the front page of the others.
page_of() { # page_of HOST
  case "$1" in
    "$(get HAMNIVO_API_HOST)") printf '/health/ready' ;;
    "$(get HAMNIVO_CHAT_HOST)") printf '/loader.js' ;;
    *) printf '/' ;;
  esac
}

# The service behind a name, for the log to read when it answers with an error.
service_of() { # service_of HOST
  case "$1" in
    "$(get HAMNIVO_API_HOST)") printf 'api' ;;
    "$(get HAMNIVO_SUPPORT_HOST)") printf 'chatwoot-web' ;;
    *) printf 'edge' ;;
  esac
}

# After names without a certificate: what Caddy says about certificates, and what to try, in order.
tls_help() { # tls_help FIRST_HOST
  local log_tail lines line rate=0 step=1
  log_tail="$("${compose[@]}" logs --no-log-prefix --tail 400 edge 2>&1 || true)"
  lines="$(grep -iE 'acme|certificate|obtain|error' <<<"$log_tail" | tail -n 5 | cut -c1-400 || true)"
  if [[ -n "$lines" ]]; then
    note "Caddy's log, the last lines about certificates:"
    while IFS= read -r line; do note "  $line"; done <<<"$lines"
  else
    note "Caddy's log has no line about certificates (all of it: $hv logs edge)."
  fi
  if [[ "$(get HAMNIVO_TLS)" == internal ]]; then
    note 'This server uses Caddy'"'"'s own CA (HAMNIVO_TLS=internal): restart the edge; the log above says why if that is not enough.'
  else
    if grep -qiE 'rateLimited|rate limit|too many' <<<"$log_tail"; then rate=1; fi
    note 'If restarting the edge does not bring the certificates, try this, in order:'
    if ((rate == 1)); then
      note "  $step. Let's Encrypt limits its attempts and the log says this server reached the limit. Wait until the"
      note "     time the log names (between an hour and a week away), then restart the edge again."
      step=$((step + 1))
    fi
    note "  $step. DNS: every name must point at this server.   Run: dig +short $1"
    step=$((step + 1))
    note "  $step. Ports $(setting HAMNIVO_HTTP_PORT 80) and $(setting HAMNIVO_HTTPS_PORT 443) must be open to the internet, because Let's Encrypt calls them.   Run: sudo ufw status"
  fi
  note 'Automatic deploys that stopped because of this try again 30 minutes after their last try; no new commit is needed.'
}

check_https() {
  local port suffix='' host url code http what first_tls='' public
  port="$(https_port)"
  public="$(public_https_port)"
  [[ "$public" == 443 ]] || suffix=":$public"
  edge_ca "$tmp/ca.crt"
  while IFS= read -r host; do
    url="https://$host$suffix$(page_of "$host")"
    code=0
    http="$(curl_edge "$url" -sS -o /dev/null -w '%{http_code}' --max-time 10 2>"$tmp/curl.err")" || code=$?
    if ((code == 0)); then
      case "$http" in
        2* | 3*) pass "HTTPS $host: answers $http" ;;
        *) problem "HTTPS $host: the certificate works, but the service answers $http" 'read the log of the service behind this name.' "$hv logs $(service_of "$host")" ;;
      esac
    elif tls_failure "$code"; then
      [[ -n "$first_tls" ]] || first_tls="$host"
      if [[ "$code" == 35 ]]; then
        what='has no certificate (the TLS handshake failed, curl exit 35)'
      else
        what="has a certificate that is not valid or not trusted (curl exit $code)"
      fi
      problem "HTTPS $host: $what" 'restart the edge, so that Caddy asks for the certificate again.' "$hv compose restart edge"
    elif ((code == 7)); then
      problem "HTTPS $host: nothing answers on port $port (connection refused)" 'start the edge.' "$hv up --no-build"
    elif ((code == 28)); then
      problem "HTTPS $host: no answer within 10 seconds" 'read the log of the edge.' "$hv logs edge"
    else
      problem "HTTPS $host: curl exit $code ($(tr -d '\n' <"$tmp/curl.err" | cut -c1-150))" 'read the log of the edge.' "$hv logs edge"
    fi
  done < <(public_hosts)
  if [[ -n "$first_tls" ]]; then tls_help "$first_tls"; fi
}

# The addresses that browsers are given (Studio, the API, the chat) must carry the port browsers
# use. Behind another web server on 443 the edge listens on another port, and addresses with that
# port reach nothing from outside: Studio then cannot reach the API.
check_addresses() {
  local public suffix='' want have
  public="$(public_https_port)"
  [[ "$public" == 443 ]] || suffix=":$public"
  want="https://$(get HAMNIVO_APP_HOST)$suffix"
  have="$(get HAMNIVO_APP_ORIGIN)"
  if [[ "$have" != "$want" ]]; then
    problem "Addresses: Studio's address is $have, but browsers use $want" 'write the addresses again and rebuild, so that Studio, the API and the chat use them.' "$hv setup --quiet && $hv up"
  elif [[ "$public" != 443 ]]; then
    pass "Addresses: browsers use port $public ($have)"
    note "Behind a web server that answers on 443 and passes requests on to port $(https_port), run: $hv setup --public-port 443, then $hv up"
  else
    pass "Addresses: $have"
  fi
}

# --- ports ---------------------------------------------------------------------------------------
port_listening() { # port_listening PORT
  if command -v ss >/dev/null; then
    ss -ltn 2>/dev/null | awk -v p=":$1" '$1 == "LISTEN" && $4 ~ (p "$") { found = 1 } END { exit !found }'
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}

check_ports() {
  local port
  for port in "$(setting HAMNIVO_HTTP_PORT 80)" "$(setting HAMNIVO_HTTPS_PORT 443)"; do
    if port_listening "$port"; then
      pass "Port $port: listening"
    else
      problem "Port $port: nothing listens on it" 'the edge publishes it; start the edge.' "$hv up --no-build"
    fi
  done
}

# --- disk, memory and the certificates' volume ---------------------------------------------------
check_disk() {
  local free need cache=unknown
  need="$(setting HAMNIVO_DEPLOY_MIN_FREE_GB 8)"
  free="$(docker_free_gb || true)"
  if ((docker_ok == 1)); then
    cache="$(docker system df --format '{{.Type}}|{{.Size}}' 2>/dev/null | awk -F'|' '$1 == "Build Cache" { print $2 }' || true)"
    cache="${cache:-unknown}"
  fi
  if [[ ! "$free" =~ ^[0-9]+$ ]]; then
    problem 'Disk: the free space could not be read' 'look at the disks.' 'df -h'
    return 0
  fi
  if ((free >= need)); then
    pass "Disk: $free GB free for Docker (a deploy needs $need), build cache $cache"
    return 0
  fi
  problem "Disk: $free GB free for Docker, a deploy needs $need (HAMNIVO_DEPLOY_MIN_FREE_GB); build cache $cache" \
    'remove the build cache: it holds no data, the next build is only slower.' 'docker builder prune -af'
  note 'Warning: never run "docker volume prune" or "docker system prune --volumes". They delete the databases and the certificates.'
}

kb_to_gb() { awk -v kb="$1" 'BEGIN { printf "%.1f", kb / 1048576 }'; }

check_memory() {
  local total avail swap swap_free text
  read -r total avail swap swap_free <<<"$(awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 }
    /^SwapTotal:/ { s = $2 } /^SwapFree:/ { f = $2 } END { print t + 0, a + 0, s + 0, f + 0 }' \
    "${HAMNIVO_MEMINFO:-/proc/meminfo}" 2>/dev/null || echo '0 0 0 0')"
  if ((total == 0)); then
    pass 'Memory: not checked (no /proc/meminfo here)'
    return 0
  fi
  text="$(kb_to_gb "$avail") GB of $(kb_to_gb "$total") GB free; swap $(kb_to_gb "$swap") GB, $(kb_to_gb $((swap - swap_free))) GB used"
  if ((avail < 524288)); then
    problem "Memory: $text" 'nearly all memory is in use: see what takes it (ClamAV alone takes about 2 GB).' 'docker stats --no-stream'
  elif ((swap == 0 && total < 9437184)) && (($(setting HAMNIVO_BUILD_CONCURRENCY 2) > 1)); then
    problem "Memory: $text" 'add a 4 GB swap file: a build next to the live services can push them out of memory.' \
      "sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab"
  else
    pass "Memory: $text"
  fi
}

check_volume() {
  local volume
  if ((docker_ok == 0)); then
    problem 'Caddy data volume: cannot be checked while Docker is down' 'fix the Docker line above first.' "$hv status"
    return 0
  fi
  volume="$(docker volume ls -q --filter "label=com.docker.compose.project=$project" \
    --filter 'label=com.docker.compose.volume=caddy-data' 2>/dev/null | head -n 1 || true)"
  if [[ -n "$volume" ]]; then
    pass "Caddy data volume: $volume (Caddy keeps its certificates there)"
    return 0
  fi
  problem "Caddy data volume: none for the project $project, so Caddy has nowhere to keep its certificates" \
    'start the stack, which creates it (a backup restores the old certificates).' "$hv up --no-build"
  note 'Warning: never run "docker volume prune" or "docker system prune --volumes": they delete the volumes of a stack that is down.'
}

# --- automatic deploys ---------------------------------------------------------------------------
automatic_mode() {
  local mode
  mode="$(get HAMNIVO_AUTODEPLOY)"
  printf '%s' "${mode:-off}"
}

check_autodeploy() {
  local mode unit state states=() inactive=0 needed
  needed='hamnivo-deploy.timer'
  mode="$(automatic_mode)"
  if [[ "$mode" == off ]]; then
    pass "Automatic deploys: off (deploy by hand with: $hv update)"
    return 0
  fi
  if ! command -v systemctl >/dev/null; then
    pass "Automatic deploys: $mode (there is no systemd here, so the units are not checked)"
    return 0
  fi
  if [[ "$mode" == webhook ]]; then needed+=' hamnivo-deploy.path'; fi
  for unit in hamnivo-deploy.path hamnivo-deploy.timer hamnivo-deploy.service; do
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    state="${state:-not installed}"
    states+=("${unit#hamnivo-deploy.} $state")
    case " $needed " in *" $unit "*) [[ "$state" == active ]] || inactive=1 ;; esac
  done
  if ((inactive == 1)); then
    problem "Automatic deploys: $mode, but a systemd unit is not active ($(join "${states[@]}"))" \
      'install and start the units, as the user who owns this checkout, without sudo.' "$hv autodeploy enable --mode $mode"
  elif [[ -f "$state_dir/paused" ]]; then
    problem "Automatic deploys: $mode, but paused: nothing deploys" 'resume them.' "$hv autodeploy resume"
  else
    pass "Automatic deploys: $mode ($(join "${states[@]}"))"
  fi
}

check_git() {
  local remote="${HAMNIVO_DEPLOY_REMOTE:-origin}" branch behind
  branch="$(get HAMNIVO_DEPLOY_BRANCH)"
  branch="${branch:-main}"
  if ! command -v git >/dev/null; then
    problem 'Git is not installed' 'install it.' 'sudo apt-get install -y git'
    return 0
  fi
  if ! GIT_TERMINAL_PROMPT=0 with_timeout 20 git -C "$root" ls-remote --exit-code "$remote" HEAD </dev/null >/dev/null 2>&1; then
    problem "Git: cannot read $remote (or it gave no answer within 20 seconds)" \
      'check this server'"'"'s network and its read access to the repository (the deploy key).' "$hv autodeploy enable"
    return 0
  fi
  pass "Git: can read $remote"
  if ! GIT_TERMINAL_PROMPT=0 with_timeout 60 git -C "$root" fetch --quiet --no-tags "$remote" \
    "+refs/heads/$branch:refs/remotes/$remote/$branch" </dev/null >/dev/null 2>&1; then
    problem "Checkout: $remote has no branch $branch to compare with" \
      'name the branch that deploys in HAMNIVO_DEPLOY_BRANCH, in the settings.' "git -C $root ls-remote --heads $remote"
    return 0
  fi
  behind="$(git -C "$root" rev-list --count "HEAD..$remote/$branch" 2>/dev/null || true)"
  if [[ ! "$behind" =~ ^[0-9]+$ ]]; then
    pass "Checkout: cannot tell how far behind $remote/$branch it is"
  elif ((behind == 0)); then
    pass "Checkout: up to date with $remote/$branch"
  elif [[ "$(automatic_mode)" != off ]]; then
    problem "Checkout: $(plural "$behind" commit) behind $remote/$branch, although automatic deploys are on (a push goes live in about 10 minutes)" \
      'see below why the last deploys did not go live, or deploy now.' "$hv update"
  else
    pass "Checkout: $(plural "$behind" commit) behind $remote/$branch (automatic deploys are off; $hv update deploys them)"
  fi
}

check_deploys() {
  local file="$state_dir/history.tsv" last result commit entry logfile='' live
  live="$(cat "$state_dir/current" 2>/dev/null || true)"
  if [[ ! -s "$file" ]]; then
    pass 'Deploys: none yet'
    return 0
  fi
  last="$(tail -n 1 "$file")"
  result="$(cut -f3 <<<"$last")"
  commit="$(cut -f2 <<<"$last")"
  case "$result" in
    failed | rolled-back | broken)
      for entry in "$state_dir"/logs/*-"$commit"*.log; do
        if [[ -f "$entry" ]]; then logfile="$entry"; fi
      done
      problem "Deploys: the newest one, $commit, $result: $(cut -f6 <<<"$last")" \
        'read the end of that deploy'"'"'s log, and fix what it names.' "tail -n 60 ${logfile:-$state_dir/logs/LOGFILE}"
      ;;
    *) pass "Deploys: the newest one, $commit, $result" ;;
  esac
  [[ -z "$live" ]] || note "Live: ${live:0:12} (images ${live##* })"
  note 'The last three:'
  tail -n 3 "$file" | awk -F'\t' '{ printf "      %s  %s  %-11s %-8s %-6s %s\n", $1, $2, $3, $4, $5, $6 }'
}

# --- Jev -----------------------------------------------------------------------------------------
# --- backups -------------------------------------------------------------------------------------
# `hamnivo.sh backups on` runs a backup every night and a backup check every month; a timer that
# stopped, a failed run or an old newest backup would otherwise go unnoticed.
check_backups() {
  local newest age_h result unit failed=()
  newest="$(find "$here/backups" -mindepth 1 -maxdepth 1 -type d -name '20*Z' 2>/dev/null | sort | tail -1 || true)"
  if [[ ! -f /etc/systemd/system/hamnivo-backup.timer ]]; then
    pass "Backups: not scheduled (${newest:+newest $(basename "$newest"); }back up every night with: $hv backups on)"
    return 0
  fi
  if [[ "$(systemctl is-active hamnivo-backup.timer 2>/dev/null || true)" != active ]]; then
    problem 'Backups: scheduled, but the nightly timer is not running' 'install and start the timers again.' "$hv backups on"
    return 0
  fi
  for unit in hamnivo-backup hamnivo-backup-check; do
    # "success" after a good run, empty before the first one; anything else says why it failed.
    result="$(systemctl show -p Result --value "$unit.service" 2>/dev/null || true)"
    [[ -z "$result" || "$result" == success ]] || failed+=("$unit ($result)")
  done
  if ((${#failed[@]} > 0)); then
    problem "Backups: the last run failed: $(join "${failed[@]}")" 'read why, fix it, then run it again by hand.' \
      "journalctl -u ${failed[0]%% *} -n 50"
    return 0
  fi
  if [[ -z "$newest" ]]; then
    pass 'Backups: every night; the first one has not run yet'
    return 0
  fi
  age_h=$((($(date +%s) - $(stat -c %Y "$newest")) / 3600))
  if ((age_h > 36)); then
    problem "Backups: the newest is $age_h hours old ($(basename "$newest"))" 'see why the nightly backup did not run.' \
      'journalctl -u hamnivo-backup -n 50'
  else
    pass "Backups: every night, checked monthly; the newest is $age_h hours old ($(basename "$newest"))"
  fi
}

check_jev() {
  if [[ -n "$(get TYPESAFE_API_KEY)" ]]; then
    pass 'Jev: TYPESAFE_API_KEY is set'
  elif [[ -n "$(get JEV_API_KEY)" ]]; then
    pass 'Jev: JEV_API_KEY (the older name of TYPESAFE_API_KEY) is set'
  else
    pass 'Jev: TYPESAFE_API_KEY is not set (optional; without it, the fixed keyword rules route)'
  fi
}

# --- the report ----------------------------------------------------------------------------------
main() {
  case "${1:-}" in
    '') ;;
    -h | --help)
      awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
      return 0
      ;;
    *) fail "Unknown doctor option: $1" ;;
  esac
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  printf 'Hamnivo doctor: %s, %s\n\n' "$(uname -n)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ ! -f "$env_file" ]]; then
    problem "Settings: $env_file does not exist" 'create the settings first.' "$hv setup --domain example.com --email you@example.com"
  else
    check_docker
    check_services
    check_https
    check_addresses
    check_ports
    check_disk
    check_memory
    check_volume
    check_autodeploy
    check_git
    check_deploys
    check_backups
    check_jev
  fi
  if ((failures == 0)); then
    printf '\nAll checks passed.\n'
    return 0
  fi
  printf '\n%s failed. Start at the top: the first ✗ often explains the others.\n' "$(plural "$failures" check)"
  return 1
}

# One line: bash has read all of it before a deploy checks out another version of this file.
main "$@"; exit
