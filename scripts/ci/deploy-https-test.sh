#!/usr/bin/env bash
# HTTPS checks of the deploy scripts (deploy/production), without Docker: `hamnivo.sh doctor` and the
# HTTPS rules of `hamnivo.sh deploy`. Fake docker, curl, ss and systemctl stand in on PATH (they
# answer from files in one folder), and a bare git repository stands in for GitHub. Takes under a
# minute and changes nothing outside a temporary folder.
#
#   bash scripts/ci/deploy-https-test.sh [--keep]
#
#   A  curl's exit codes: a failed TLS handshake or certificate is told from a refused connection
#      and from an HTTP error
#   B  doctor: a healthy server; the incident (no certificate for any name); an HTTP error is not a
#      certificate problem; Docker down; low disk; no Caddy volume; units; a failed deploy; no secret
#      is printed; HAMNIVO_TLS=internal trusts Caddy's CA
#   C  deploy: HTTPS broken before the deploy stops it before building, with the reason in the log,
#      the history and GitHub, and is tried again every 30 minutes without ever counting as failed;
#      an HTTP error at that point does not stop it; --force skips the check; a TLS failure after the
#      switch restarts the edge once, then goes on or rolls back with the reason
#   D  the migration guard: SQL that loses data (drops, renames, retypes or empties) holds a version
#      for a person; comments and privilege changes such as REVOKE ... TRUNCATE do not
#   E  behind another web server: setup --public-port gives the addresses the port browsers use, the
#      webhook address follows them, and doctor names addresses that still carry another port
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
keep=0
[[ "${1:-}" == --keep ]] && keep=1

work="$(mktemp -d)"
cleanup() {
  if ((keep == 1)); then
    printf 'Left in %s\n' "$work" >&2
  else
    rm -rf "$work"
  fi
}
trap cleanup EXIT

export FAKE_DIR="$work/fake"
bin="$work/bin"
origin="$work/origin.git"
dev="$work/dev"
server="$work/server"
export HAMNIVO_ENV_FILE="$server/deploy/production/.env"
export HAMNIVO_PROJECT=hamnivo-https-test
export HAMNIVO_DEPLOY_SOAK_SECONDS=0
export HAMNIVO_DEPLOY_MIN_FREE_GB=1
export HAMNIVO_WAIT_SECONDS=10
export HAMNIVO_MEMINFO="$work/meminfo"
export HAMNIVO_GITHUB_API=http://github.test
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.test
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.test
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export NO_COLOR=1
unset TYPESAFE_API_KEY JEV_API_KEY HAMNIVO_IMAGE_TAG HAMNIVO_TLS HAMNIVO_AUTODEPLOY
state="$server/deploy/production/state"
hv=(bash "$server/deploy/production/hamnivo.sh")
failures=0
out="$work/out"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
check() { # check NAME COMMAND...
  if "${@:2}"; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s\n' "$1"
    failures=$((failures + 1))
  fi
}
has() { grep -qF -- "$1" "$out"; } # the last output has this text
lacks() { ! grep -qF -- "$1" "$out"; }
matches() { grep -qE -- "$1" "$out"; }

# --- the stand-ins -------------------------------------------------------------------------------
mkdir -p "$bin" "$FAKE_DIR"

# docker: logs each call in $FAKE_DIR/docker.log. Knobs: FAKE_DOCKER_DOWN=1, FAKE_UNHEALTHY="svc ...",
# FAKE_MISSING="svc ...", FAKE_VOLUME (empty: no volume), FAKE_LABEL (the API image's revision).
cat >"$bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_DIR/docker.log"
state_of() { case " ${FAKE_UNHEALTHY:-} " in *" $1 "*) echo unhealthy ;; *) echo healthy ;; esac; }
case "${1:-}" in
  compose)
    shift
    while (($#)); do
      case "$1" in
        --project-name | --project-directory | -f | --env-file) shift 2 ;;
        *) break ;;
      esac
    done
    case "${1:-}" in
      version) echo 'Docker Compose version v2.0.0' ;;
      config) printf '%s\n' hamnivo-db valkey db-init migrate api worker edge chatwoot-db chatwoot-redis \
        chatwoot-prepare chatwoot-web chatwoot-sidekiq clamav ;;
      ps)
        service="${*: -1}"
        case " ${FAKE_MISSING:-} " in *" $service "*) ;; *) echo "cid-$service" ;; esac ;;
      logs) cat "$FAKE_DIR/edge.log" 2>/dev/null || true ;;
      exec) case "$*" in *root.crt*) echo 'FAKE CA' ;; esac ;;
    esac
    ;;
  info)
    if [[ -n "${FAKE_DOCKER_DOWN:-}" ]]; then
      echo 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' >&2
      exit 1
    fi
    case "$*" in
      *DockerRootDir*) echo "$FAKE_DIR" ;;
      *ServerVersion*) echo 29.0.0 ;;
    esac
    ;;
  inspect)
    fmt="$3"
    id="${*: -1}"
    case "$fmt" in
      *Labels*) echo "${FAKE_LABEL:-unknown}" ;;
      *RestartCount*Health*) echo "0 $(state_of "${id#cid-}")" ;;
      *RestartCount*) echo 0 ;;
      *Health*) state_of "${id#cid-}" ;;
    esac
    ;;
  image) ;;
  system) printf '%s\n' 'Images|2.1GB' 'Build Cache|5.2GB' ;;
  volume) if [[ -n "${FAKE_VOLUME-hamnivo-https-test_caddy-data}" ]]; then echo "${FAKE_VOLUME-hamnivo-https-test_caddy-data}"; fi ;;
esac
exit 0
EOF

# curl: for requests through the edge (--connect-to HOST::IP:PORT), the rules in $FAKE_DIR/curl.rules say
# how each name answers: "HOST EXIT[,EXIT...] [HTTP]". The nth request for a name exits with the nth
# code, and the last code repeats. 0 answers HTTP (200 unless given), 35 is a failed TLS handshake,
# 22 an HTTP error, 7 a refused connection. A request to GitHub's deployment API is only logged.
cat >"$bin/curl" <<'EOF'
#!/usr/bin/env bash
host='' format='' body='' url="${*: -1}"
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    --connect-to | --resolve) host="${args[i + 1]%%:*}" ;;
    -w) format="${args[i + 1]}" ;;
    -d) body="${args[i + 1]}" ;;
  esac
done
if [[ -z "$host" ]]; then
  case "$url" in
    */deployments*) printf '%s %s\n' "$url" "$body" >>"$FAKE_DIR/github.log"; echo '{"id": 7, "creator": {"id": 1}}' ;;
  esac
  exit 0
fi
echo "curl $host $*" >>"$FAKE_DIR/curl.log"
n="$(grep -c "^curl $host " "$FAKE_DIR/curl.log")"
rule="$(grep "^$host " "$FAKE_DIR/curl.rules" 2>/dev/null | head -1 || true)"
codes="$(awk '{ print $2 }' <<<"$rule")"
http="$(awk '{ print $3 }' <<<"$rule")"
IFS=, read -r -a list <<<"${codes:-0}"
code="${list[n - 1]:-${list[${#list[@]} - 1]}}"
case "$format" in *http_code*) if ((code == 0)); then printf '%s' "${http:-200}"; else printf '000'; fi ;; esac
case "$code" in
  0) ;;
  35) echo "curl: (35) OpenSSL/3.0: error:0A000438:SSL routines::tlsv1 alert internal error" >&2 ;;
  22) echo 'curl: (22) The requested URL returned error: 503' >&2 ;;
  7) echo "curl: (7) Failed to connect to $host port 443: Connection refused" >&2 ;;
  *) echo "curl: ($code) failed" >&2 ;;
esac
exit "$code"
EOF

# ss: the listening ports in $FAKE_PORTS (default "80 443"). systemctl: units active in $FAKE_UNITS.
cat >"$bin/ss" <<'EOF'
#!/usr/bin/env bash
echo 'State   Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process'
for port in ${FAKE_PORTS:-80 443}; do
  echo "LISTEN  0       4096         0.0.0.0:$port       0.0.0.0:*"
done
EOF
cat >"$bin/systemctl" <<'EOF'
#!/usr/bin/env bash
unit="${2#hamnivo-deploy.}"
unit="${unit%.service}"
case " ${FAKE_UNITS-timer path} " in *" $unit "*) echo active ;; *) echo inactive; exit 3 ;; esac
EOF
# df: the real one, unless FAKE_DF_FAIL is set (a disk that cannot be read).
real_df="$(command -v df)"
cat >"$bin/df" <<EOF
#!/usr/bin/env bash
if [[ -n "\${FAKE_DF_FAIL:-}" ]]; then exit 1; fi
exec $real_df "\$@"
EOF
chmod +x "$bin"/*
export PATH="$bin:$PATH"

rules() { printf '%s\n' "$@" >"$FAKE_DIR/curl.rules"; : >"$FAKE_DIR/curl.log"; }
fresh() { : >"$FAKE_DIR/docker.log"; : >"$FAKE_DIR/curl.log"; : >"$FAKE_DIR/github.log"; rm -f "$FAKE_DIR/edge.log"; }
calls() { grep -c -- "$1" "$FAKE_DIR/docker.log" || true; }  # how often docker was called with this text
history_lines() { if [[ -f "$state/history.tsv" ]]; then wc -l <"$state/history.tsv"; else echo 0; fi; }
last_history() { tail -n 1 "$state/history.tsv"; }
set_env() { # set_env NAME VALUE: in the server's settings
  local tmp
  tmp="$(mktemp)"
  K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$HAMNIVO_ENV_FILE" >"$tmp"
  cat "$tmp" >"$HAMNIVO_ENV_FILE"
  rm -f "$tmp"
}
# Run a command of the server; its output is in $out, its exit status in $status.
status=0
doctor() { status=0; "${hv[@]}" doctor >"$out" 2>&1 || status=$?; }
deploy() { status=0; "${hv[@]}" deploy "$@" >"$out" 2>&1 || status=$?; }
exit_is() { [[ "$status" == "$1" ]]; }
history_has() { grep -qE -- "$1" "$state/history.tsv"; }
tab=$'\t'

# --- A: curl's exit codes ------------------------------------------------------------------------
say 'A  TLS failures are told from connection and HTTP failures'
# lib.sh wants `here` (the folder it is in); a shell of its own reads it.
classify() { here="$root/deploy/production" bash -c 'source "$here/lib.sh" && tls_failure "$1"' _ "$1"; }
not_tls() { ! classify "$1"; }
for code in 35 51 58 60 83 90 91; do check "curl exit $code is a TLS failure" classify "$code"; done
for code in 6 7 22 28 52 56; do check "curl exit $code is no TLS failure" not_tls "$code"; done

# --- the server: a clone of a repository with the deploy scripts at their working-tree state --------
say 'Setting up a fake server'
git init -q --bare -b main "$origin"
git init -q -b main "$dev"
(cd "$root" && git ls-files -z --cached --others --exclude-standard -- deploy/production deploy/docker \
  scripts/chatwoot .gitignore | tar --null -T - -cf -) | tar -C "$dev" -xf -
git -C "$dev" add -A
git -C "$dev" commit -qm 'The first version'
git -C "$dev" remote add origin "$origin"
git -C "$dev" push -q origin main
c1="$(git -C "$dev" rev-parse HEAD)"
git clone -q "$origin" "$server"
"${hv[@]}" setup --quiet --domain example.test --tls ops@example.test
set_env CHATWOOT_PLATFORM_TOKEN token-not-printed
set_env HAMNIVO_DB_OWNER_PASSWORD password-not-printed
printf 'MemTotal: 16000000 kB\nMemAvailable: 8000000 kB\nSwapTotal: 4000000 kB\nSwapFree: 4000000 kB\n' >"$HAMNIVO_MEMINFO"
mkdir -p "$state"
printf '%s %s\n' "$c1" first >"$state/current"
rules ''

# --- B: doctor -----------------------------------------------------------------------------------
say 'B  doctor: a healthy server'
fresh
check 'exits 0' doctor
check 'says all checks passed' has 'All checks passed.'
check 'Docker and services' matches '^✓ Docker runs'
check 'services' matches '^✓ Services: all 10 are healthy'
check 'HTTPS for the app name' has '✓ HTTPS app.example.test: answers 200'
check 'HTTPS for the website names' has '✓ HTTPS www.example.test: answers 200'
check 'HTTPS for the API uses its health page' grep -q 'health/ready' "$FAKE_DIR/curl.log"
check 'curl is told where the edge is' grep -q -- '--connect-to api.example.test::127.0.0.1:443' "$FAKE_DIR/curl.log"
check 'the addresses carry the port browsers use' has '✓ Addresses: https://app.example.test'
check 'ports' has '✓ Port 443: listening'
check 'disk' matches '^✓ Disk: [0-9]+ GB free for Docker .*build cache 5.2GB'
check 'memory' has '✓ Memory: 7.6 GB of 15.3 GB free'
check 'volume' has '✓ Caddy data volume: hamnivo-https-test_caddy-data'
check 'automatic deploys are off' has '✓ Automatic deploys: off'
check 'git reads origin' has '✓ Git: can read origin'
check 'the checkout is up to date' has '✓ Checkout: up to date with origin/main'
check 'no deploys yet' has '✓ Deploys: none yet'
check 'backups not scheduled is no failure, with the command to schedule them' has '✓ Backups: not scheduled (back up every night with:'
check 'Jev: not set is no failure' has '✓ Jev: TYPESAFE_API_KEY is not set'
check 'a secret in the settings is never printed' lacks 'password-not-printed'
check 'doctor changes no setting' grep -q '^HAMNIVO_DB_OWNER_PASSWORD=password-not-printed$' "$HAMNIVO_ENV_FILE"

say 'B  doctor: the incident, Caddy answers every TLS handshake with an internal error'
fresh
rules 'app.example.test 35' 'api.example.test 35' 'chat.example.test 35' 'support.example.test 35' \
  'example.test 35' 'www.example.test 35'
cat >"$FAKE_DIR/edge.log" <<'EOF'
{"level":"info","ts":1759000000.1,"msg":"serving initial configuration"}
{"level":"error","ts":1759000001.2,"logger":"tls.obtain","msg":"could not get certificate from issuer","identifier":"api.example.test","error":"HTTP 429 urn:ietf:params:acme:error:rateLimited: too many failed authorizations"}
{"level":"info","ts":1759000002.3,"logger":"http.log.access","msg":"handled request"}
EOF
set_env TYPESAFE_API_KEY sk-secret-jev-value
doctor
check 'exits 1' exit_is 1
check 'tells a missing certificate for the app name' has '✗ HTTPS app.example.test: has no certificate (the TLS handshake failed, curl exit 35)'
check 'for every name' matches '✗ HTTPS www.example.test: has no certificate'
check 'first fix: restart the edge, with the exact command' has "Run: $server/deploy/production/hamnivo.sh compose restart edge"
check 'shows what Caddy logged' has "Caddy's log, the last lines about certificates:"
check 'including the rate limit' has 'rateLimited'
check 'and leaves out lines about other things' lacks 'handled request'
check 'rate limit fix comes first when the log says so' has "1. Let's Encrypt limits its attempts"
check 'then DNS' has '2. DNS: every name must point at this server.   Run: dig +short app.example.test'
check 'then ports 80 and 443' has '3. Ports 80 and 443 must be open to the internet'
check 'deploys try again by themselves' has 'try again 30 minutes after their last try'
check 'the other checks still run' has '✓ Port 80: listening'
check 'Jev: shows set, not the key' has '✓ Jev: TYPESAFE_API_KEY is set'
check 'and never the key' lacks 'sk-secret-jev-value'
check 'the summary counts the failures' matches '6 checks failed'

say 'B  doctor: without a rate limit in the log, that step is left out'
fresh
printf '%s\n' '{"level":"error","logger":"tls.obtain","msg":"will retry","error":"dial tcp: i/o timeout"}' >"$FAKE_DIR/edge.log"
doctor
check 'DNS is the first step' has '1. DNS: every name must point at this server.'
check 'no rate limit step' lacks "Let's Encrypt limits its attempts"

say 'B  doctor: an HTTP error is no certificate problem'
fresh
rules 'api.example.test 0 503' 'chat.example.test 7'
doctor
check 'the API answers 503' has '✗ HTTPS api.example.test: the certificate works, but the service answers 503'
check 'its fix is the log of the API' has "Run: $server/deploy/production/hamnivo.sh logs api"
check 'a refused connection says so' has '✗ HTTPS chat.example.test: nothing answers on port 443 (connection refused)'
check 'neither is called a missing certificate' lacks 'has no certificate'
check 'and no certificate help is printed' lacks "Caddy's log, the last lines"

say 'B  doctor: Docker is down'
fresh
rules ''
export FAKE_DOCKER_DOWN=1
doctor
unset FAKE_DOCKER_DOWN
check 'Docker is not running' has '✗ Docker is not running'
check 'with the command that starts it' has 'Run: sudo systemctl enable --now docker'
check 'services cannot be checked' has '✗ Services: cannot be checked while Docker is down'
check 'doctor goes on to the other checks' has '✓ Port 80: listening'

say 'B  doctor: low disk, no Caddy volume'
fresh
export FAKE_VOLUME=''
HAMNIVO_DEPLOY_MIN_FREE_GB=100000 doctor
unset FAKE_VOLUME
check 'the disk is short' matches '✗ Disk: [0-9]+ GB free for Docker, a deploy needs 100000'
check 'the fix removes only the build cache' has 'Run: docker builder prune -af'
check 'with the warning about volumes' has 'never run "docker volume prune" or "docker system prune --volumes"'
check 'the volume is missing' has '✗ Caddy data volume: none for the project hamnivo-https-test'

say 'B  doctor: the free space cannot be read'
fresh
FAKE_DF_FAIL=1 doctor
check 'it is reported' has '✗ Disk: the free space could not be read'
check 'and the checks after it still run' has '✓ Memory:'
check 'to the end' has '✓ Jev:'

say 'B  doctor: a service is down, ports are closed, memory is low'
fresh
printf 'MemTotal: 3000000 kB\nMemAvailable: 300000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n' >"$HAMNIVO_MEMINFO"
FAKE_MISSING='edge' FAKE_UNHEALTHY='api' FAKE_PORTS='80' doctor
printf 'MemTotal: 16000000 kB\nMemAvailable: 8000000 kB\nSwapTotal: 4000000 kB\nSwapFree: 4000000 kB\n' >"$HAMNIVO_MEMINFO"
check 'names the services' has '✗ Services: api is unhealthy, edge is missing'
check 'port 443 is closed' has '✗ Port 443: nothing listens on it'
check 'memory is low' matches '✗ Memory: 0.3 GB of 2.9 GB free'

say 'B  doctor: automatic deploys, a failed deploy, a checkout that is behind'
echo 'A second version' >"$dev/NOTES.txt"
git -C "$dev" add -A
git -C "$dev" commit -qm 'The second version'
git -C "$dev" push -q origin main
c2="$(git -C "$dev" rev-parse HEAD)"
set_env HAMNIVO_AUTODEPLOY webhook
mkdir -p "$state/logs"
printf '2026-10-03T10:00:00Z\t%s\tlive\ttimer\t90s\treplaced an older one\n' "${c1:0:12}" >"$state/history.tsv"
printf '2026-10-03T11:00:00Z\t%s\trolled-back\twebhook\t300s\tno HTTPS certificate for api.example.test (run hamnivo.sh doctor); %s runs again\n' \
  "${c2:0:12}" "${c1:0:12}" >>"$state/history.tsv"
echo 'the log of the deploy' >"$state/logs/20261003T110000Z-${c2:0:12}.log"
fresh
FAKE_UNITS='timer' doctor
check 'the path unit is not active' matches '✗ Automatic deploys: webhook, but a systemd unit is not active \(path inactive, timer active'
check 'the fix installs the units again' has 'Run: '"$server"'/deploy/production/hamnivo.sh autodeploy enable --mode webhook'
check 'the checkout is behind' has '✗ Checkout: 1 commit behind origin/main, although automatic deploys are on'
check 'the newest deploy rolled back, with its reason' has '✗ Deploys: the newest one, '"${c2:0:12}"', rolled-back: no HTTPS certificate for api.example.test'
check 'the fix reads that deploy'"'"'s log' has "Run: tail -n 60 $state/logs/20261003T110000Z-${c2:0:12}.log"
check 'the last deploys are listed' has "${c1:0:12}  live"
touch "$state/paused"
FAKE_UNITS='timer path' doctor
check 'paused deploys are told' has '✗ Automatic deploys: webhook, but paused: nothing deploys'
rm -f "$state/paused"
FAKE_UNITS='timer path' doctor
check 'with both units active, they are reported' has '✓ Automatic deploys: webhook (path active, timer active, service inactive)'

say 'B  doctor: git cannot read origin; no settings; HAMNIVO_TLS=internal'
git -C "$server" remote set-url origin "$work/missing.git"
fresh
doctor
git -C "$server" remote set-url origin "$origin"
check 'a git failure is a failed check' has '✗ Git: cannot read origin'
check 'with the command to set up access' has 'autodeploy enable'
fresh
set_env HAMNIVO_TLS internal
doctor
set_env HAMNIVO_TLS ops@example.test
check 'the CA of the edge is trusted for these requests' grep -q -- '--cacert' "$FAKE_DIR/curl.log"
mv "$HAMNIVO_ENV_FILE" "$HAMNIVO_ENV_FILE.away"
doctor
mv "$HAMNIVO_ENV_FILE.away" "$HAMNIVO_ENV_FILE"
check 'missing settings are reported' has '✗ Settings:'
check 'with the setup command' has 'hamnivo.sh setup --domain example.com'
set_env HAMNIVO_AUTODEPLOY off
: >"$state/history.tsv"
rm -f "$state/logs/"*


# --- C: deploys ----------------------------------------------------------------------------------
# Puts the server back to the first version, as the live one, for the next deploy of the second.
back_to_first() {
  git -C "$server" checkout -q --detach "$c1"
  printf '%s %s\n' "$c1" first >"$state/current"
  rm -f "$state/failed/$c2"
  fresh
}

say 'C  deploy: HTTPS is broken before the deploy, so nothing is built'
set_env GITHUB_DEPLOY_TOKEN token-not-printed
set_env HAMNIVO_DEPLOY_REPOSITORY owner/name
fresh
rules 'app.example.test 35' 'api.example.test 35' 'chat.example.test 35'
deploy --latest
check 'the deploy stops' exit_is 1
check 'with the reason, as the owner reads it' has 'HTTPS is not working on this server: no certificate for api.example.test. Fix it first (hamnivo.sh doctor)'
check 'the running version stays' has "${c1:0:12} keeps running"
check 'nothing was built' test "$(calls 'build')" -eq 0
check 'nothing was started' test "$(calls 'up -d')" -eq 0
check 'the edge was not restarted' test "$(calls 'restart edge')" -eq 0
check 'the history has the reason' history_has "${tab}failed${tab}manual${tab}[0-9]+s${tab}stopped before building: HTTPS is not working on this server: no certificate for api.example.test"
check 'GitHub hears the reason' grep -q 'HTTPS is not working on this server: no certificate for api.example.test. Fix it first (hamnivo.sh doctor)' "$FAKE_DIR/github.log"
check 'GitHub hears it as a failure' grep -q '"state":"failure"' "$FAKE_DIR/github.log"
check 'the live version is unchanged' grep -q "^$c1 first$" "$state/current"
check 'the checkout is unchanged' test "$(git -C "$server" rev-parse HEAD)" = "$c1"
check 'the commit is noted as one attempt at https' grep -qx '1 https' "$state/failed/$c2"

say 'C  deploy: automatic runs wait 30 minutes, then try again, as often as it takes'
lines="$(history_lines)"
deploy --latest --trigger timer
check 'a timer run right after does nothing' test "$(history_lines)" -eq "$lines"
deploy --latest --trigger webhook
check 'a webhook run says it waits for HTTPS' has 'waits until HTTPS works on this server; it is tried again every 30 minutes'
check 'and does nothing either' test "$(history_lines)" -eq "$lines"
touch -d '31 minutes ago' "$state/failed/$c2"
deploy --latest --trigger timer
check 'after 30 minutes it tries again' has "Trying ${c2:0:12} again: HTTPS did not work on this server 30 minutes ago."
check 'and stops again, with a new history line' test "$(history_lines)" -eq "$((lines + 1))"
check 'the second stop is still one attempt' grep -qx '1 https' "$state/failed/$c2"
touch -d '31 minutes ago' "$state/failed/$c2"
deploy --latest --trigger timer
check 'a third try is made: it never counts as failed for good' test "$(history_lines)" -eq "$((lines + 2))"
touch -d '31 minutes ago' "$state/failed/$c2"
fresh
rules ''
deploy --latest --trigger timer
check 'once HTTPS works, the commit goes live without a new commit' history_has "${c2:0:12}${tab}live${tab}timer"
check 'it was built' test "$(calls 'build')" -gt 0
check 'the live version is that commit' grep -q "^$c2 " "$state/current"
check 'the failure note is gone' test ! -e "$state/failed/$c2"
check 'the edge was not restarted' test "$(calls 'restart edge')" -eq 0

say 'C  deploy: an HTTP error before the deploy does not stop it'
back_to_first
rules 'api.example.test 22,0'
deploy --latest
check 'the deploy goes on' exit_is 0
check 'and says why' has 'does not answer over HTTPS at https://api.example.test/health/ready'
check 'the new version is live' history_has "${c2:0:12}${tab}live${tab}manual"
check 'it was built' test "$(calls 'build')" -gt 0

say 'C  deploy: --force skips that check; a certificate that comes after one restart is enough'
back_to_first
rules 'api.example.test 35,0'
deploy --latest --force
check 'the deploy goes live' exit_is 0
check 'it was built, so the check before the build was skipped' test "$(calls 'build')" -gt 0
check 'the edge was restarted once' test "$(calls 'restart edge')" -eq 1
check 'the log says so' has 'restarting the edge once'
check 'it is live' history_has "${c2:0:12}${tab}live${tab}manual"
check 'the API was asked twice, both times after the switch' test "$(grep -c '^curl api.example.test' "$FAKE_DIR/curl.log")" -eq 2

say 'C  deploy: no certificate after the switch, even after a restart: rolled back, with the reason'
back_to_first
rules 'api.example.test 0,35,35,0'
deploy --latest
check 'the deploy fails' exit_is 1
check 'the edge was restarted once, not twice' test "$(calls 'restart edge')" -eq 1
check 'the log names the reason' has 'no HTTPS certificate for api.example.test (run hamnivo.sh doctor)'
check 'the history names it, and the rollback' history_has "${c2:0:12}${tab}rolled-back.*no HTTPS certificate for api.example.test \(run hamnivo.sh doctor\); ${c1:0:12} runs again"
check 'GitHub hears it' grep -q 'no HTTPS certificate for api.example.test (run hamnivo.sh doctor); rolled back to' "$FAKE_DIR/github.log"
check 'the old version runs again' grep -q "^$c1 " "$state/current"
check 'a failure after the switch is not retried' grep -qx '1 start' "$state/failed/$c2"

say 'C  deploy: a failure that is not TLS does not restart the edge'
back_to_first
rules 'api.example.test 0,22,0'
deploy --latest
check 'the deploy fails' exit_is 1
check 'the edge was not restarted' test "$(calls 'restart edge')" -eq 0
check 'the history says the API does not answer' history_has "${c2:0:12}${tab}rolled-back.*https://api.example.test/health/ready does not answer over HTTPS"

# --- D: the migration guard ----------------------------------------------------------------------
say 'D  the migration guard holds a version for lost data only'
destructive() { here="$root/deploy/production" bash -c 'source "$here/lib.sh" && printf "%b" "$1" | destructive_sql' _ "$1"; }
harmless() { ! destructive "$1"; }
check 'REVOKE ... TRUNCATE takes rights away: no hold' \
  harmless 'REVOKE UPDATE, DELETE, TRUNCATE ON billing_events FROM hamnivo_app;'
check 'a GRANT on a column named like an action: no hold' \
  harmless 'GRANT SELECT (truncated) ON t TO hamnivo_app;'
check 'a comment that names a drop: no hold' \
  harmless '-- drop table old\nCREATE TABLE t (id uuid);\n--> statement-breakpoint\nALTER TABLE t ADD COLUMN n text;'
check 'TRUNCATE empties a table: hold' destructive 'CREATE TABLE t (id uuid);\nTRUNCATE t;'
check 'DROP COLUMN: hold' destructive 'ALTER TABLE t DROP COLUMN n;'
check 'SET NOT NULL: hold' destructive 'ALTER TABLE "t" ALTER COLUMN "n" SET NOT NULL;'
check 'SET DATA TYPE: hold' destructive 'ALTER TABLE "t" ALTER COLUMN "n" SET DATA TYPE integer;'
check 'RENAME TO: hold' destructive 'ALTER TABLE t RENAME TO u;'

# --- E: the port browsers use --------------------------------------------------------------------
say 'E  behind another web server: the addresses carry the port browsers use'
public_env="$work/public.env"
setup_public() { HAMNIVO_ENV_FILE="$public_env" "${hv[@]}" setup --quiet "$@" >/dev/null 2>&1; }
public_value() { grep "^$1=" "$public_env" | tail -n 1 | cut -d= -f2-; }
doctor_public() { status=0; HAMNIVO_ENV_FILE="$public_env" "${hv[@]}" doctor >"$out" 2>&1 || status=$?; }
setup_public --domain example.test --tls ops@example.test --https-port 8443 --http-port 8080
check 'without --public-port, the addresses name the edge port' \
  test "$(public_value HAMNIVO_APP_ORIGIN)" = https://app.example.test:8443
doctor_public
check 'doctor says how to drop the port behind a web server on 443' has 'setup --public-port 443'
setup_public --public-port 443
check '--public-port 443 drops the port from the addresses' \
  test "$(public_value HAMNIVO_APP_ORIGIN) $(public_value HAMNIVO_API_ORIGIN)" = \
  'https://app.example.test https://api.example.test'
check 'the chat address too' test "$(public_value HAMNIVO_CHAT_ORIGIN)" = https://chat.example.test
check 'the edge keeps its own port' test "$(public_value HAMNIVO_HTTPS_PORT)" = 8443
check 'the webhook address follows the API address' \
  test "$(public_value CHATWOOT_WEBHOOK_BASE_URL)" = https://api.example.test
sed -i 's#^HAMNIVO_APP_ORIGIN=.*#HAMNIVO_APP_ORIGIN=https://app.example.test:8443#' "$public_env"
doctor_public
check 'doctor finds an address that still carries the old port' \
  has "Addresses: Studio's address is https://app.example.test:8443, but browsers use https://app.example.test"
sed -i 's#^CHATWOOT_WEBHOOK_BASE_URL=.*#CHATWOOT_WEBHOOK_BASE_URL=http://api:3000#' "$public_env"
setup_public --public-port 8443
check 'a webhook address set by hand stays' test "$(public_value CHATWOOT_WEBHOOK_BASE_URL)" = http://api:3000
check 'and the addresses follow the port' test "$(public_value HAMNIVO_APP_ORIGIN)" = https://app.example.test:8443

if ((failures > 0)); then
  printf '\n%d check(s) failed\n' "$failures"
  exit 1
fi
printf '\nAll checks passed.\n'
