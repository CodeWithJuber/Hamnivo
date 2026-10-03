#!/usr/bin/env bash
# Automatic deploy smoke test (deploy/production/deploy.sh). A bare repository stands in for GitHub,
# a clone of it for the server, and a small local server for GitHub's deployment API. The stack
# runs in its own compose project with Caddy's internal CA; everything is deleted afterwards.
#
#   bash scripts/ci/autodeploy-smoke.sh [--keep]
#
# What a push goes through, end to end:
#   A  the first install (hamnivo.sh up), then autodeploy enable (webhook mode, without systemd);
#      the webhook through Caddy (signatures, events, repositories, branches), GitHub's published
#      test vector, the deploy lock
#   B  a signed push is deployed: checks, build, start, health; GitHub hears each step. Before
#      that, a file changed on the server stops the deploy.
#   C  a version with a new migration never gets healthy: backed up first, rolled back to B, not
#      retried automatically
#   D  a failing unit test stops the deploy before anything restarts
#   E  the fix goes live; a rollback by hand brings B back, and E is not redeployed automatically
#   G  a new version of other software is held for a deploy by hand
#   H  the next commit goes live as usual
#   F  an update after a `git pull` by hand, onto images that do not say which commit they run
# The test does what the systemd units would (see run_service). HAMNIVO_BUILD_CA and
# HAMNIVO_BUILD_NETWORK are passed to the image builds (see deploy/production/hamnivo.sh).
set -euo pipefail
# Compose takes settings from this shell too: the stacks never call the real Jev.
unset TYPESAFE_API_KEY TYPESAFE_BASE_URL JEV_API_KEY JEV_BASE_URL

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
keep=0
[[ "${1:-}" == --keep ]] && keep=1

work="$(mktemp -d)"
github="$work/github.git"
server="$work/server"
dev="$work/dev"
export HAMNIVO_PROJECT="hamnivo-autodeploy-$$"
export HAMNIVO_ENV_FILE="$server/deploy/production/.env"
export HAMNIVO_WAIT_SECONDS="${HAMNIVO_WAIT_SECONDS:-1200}"
export HAMNIVO_DEPLOY_HEALTH_SECONDS=300
export HAMNIVO_DEPLOY_SOAK_SECONDS=10
export HAMNIVO_DEPLOY_MIN_FREE_GB="${HAMNIVO_DEPLOY_MIN_FREE_GB:-2}"
state="$server/deploy/production/state"
backups="$server/deploy/production/backups"
hv=(bash "$server/deploy/production/hamnivo.sh")
failures=0
api_pid=''
lock_pid=''

cleanup() {
  [[ -n "$api_pid" ]] && kill "$api_pid" 2>/dev/null
  [[ -n "$lock_pid" ]] && kill "$lock_pid" 2>/dev/null
  docker rm -f "$HAMNIVO_PROJECT-vector" >/dev/null 2>&1 || true
  if ((keep == 1)); then
    printf 'Left running: HAMNIVO_ENV_FILE=%s HAMNIVO_PROJECT=%s %s status\n' \
      "$HAMNIVO_ENV_FILE" "$HAMNIVO_PROJECT" "${hv[1]}" >&2
    return
  fi
  if [[ -f "$HAMNIVO_ENV_FILE" ]]; then
    "${hv[@]}" compose --profile autodeploy down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  # The images this test built: the first install's, the relabelled ones and those of the commits
  # it deployed.
  local tag
  for tag in autodeploy-a unlabelled $(cut -f2 "$state/history.tsv" 2>/dev/null | sort -u); do
    docker image rm "hamnivo/gateway:$tag" "hamnivo/edge:$tag" >/dev/null 2>&1 || true
  done
  rm -rf "$work"
}
trap cleanup EXIT

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
check() { # check NAME COMMAND...
  if "${@:2}"; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s\n' "$1"
    failures=$((failures + 1))
  fi
}
free_port() {
  node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })'
}
set_env() {
  local tmp
  tmp="$(mktemp)"
  K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$HAMNIVO_ENV_FILE" >"$tmp"
  cat "$tmp" >"$HAMNIVO_ENV_FILE"
  rm -f "$tmp"
}
env_value() { sed -n "s/^$1=//p" "$HAMNIVO_ENV_FILE" | tail -1 | sed 's/^"\(.*\)"$/\1/'; }
short() { printf '%s' "${1:0:12}"; }

# What the systemd units do: hamnivo-deploy.path starts the service when a webhook request waits,
# and its ExecStartPre notes that and empties the folder (hamnivo-deploy.service).
run_service() {
  if [[ -n "$(ls -A "$state/requests")" ]]; then echo webhook; else echo timer; fi >"$state/trigger"
  find "$state/requests" -mindepth 1 -delete
  "${hv[@]}" deploy --latest --trigger auto
}

current_commit() { cut -d' ' -f1 "$state/current"; }
history_lines() { if [[ -f "$state/history.tsv" ]]; then wc -l <"$state/history.tsv"; else echo 0; fi; }
history_has() { grep -q "$1" "$state/history.tsv"; }
api_id() { "${hv[@]}" compose ps -q api; }
api_label() { docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$(api_id)"; }
backup_count() { find "$backups/before-deploy" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l; }
commit_push() { # commit_push MESSAGE → prints the new commit
  git -C "$dev" add -A
  git -C "$dev" commit -qm "$1"
  git -C "$dev" push -q origin HEAD:main
  git -C "$dev" rev-parse HEAD
}

https_get() { # https_get HOST PATH → the body
  local port
  port="$(env_value HAMNIVO_HTTPS_PORT)"
  curl -fsS --max-time 10 --cacert "$work/ca.crt" --resolve "$1:$port:127.0.0.1" "https://$1:$port$2"
}
site_file() {
  local host
  host="$(env_value HAMNIVO_SITE_HOSTS)"
  https_get "${host%% *}" /autodeploy-smoke.txt
}

# Posts a GitHub-style webhook through Caddy; prints the HTTP status. SECRET "none" sends no
# signature.
webhook() { # webhook EVENT BODY [SECRET]
  local secret="${3:-$(env_value HAMNIVO_DEPLOY_WEBHOOK_SECRET)}" signature=() host port
  if [[ "$secret" != none ]]; then
    signature=(-H "X-Hub-Signature-256: sha256=$(printf '%s' "$2" | openssl dgst -sha256 -hmac "$secret" | sed 's/^.* //')")
  fi
  host="$(env_value HAMNIVO_API_HOST)"
  port="$(env_value HAMNIVO_HTTPS_PORT)"
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 --cacert "$work/ca.crt" \
    --resolve "$host:$port:127.0.0.1" -X POST -H 'content-type: application/json' \
    -H "X-GitHub-Event: $1" "${signature[@]}" --data-binary "$2" \
    "https://$host:$port/_deploy/github"
}
push_body() { # push_body COMMIT [BRANCH] [REPOSITORY]
  printf '{"ref":"refs/heads/%s","after":"%s","repository":{"full_name":"%s"}}' \
    "${2:-main}" "$1" "${3:-smoke/hamnivo}"
}
no_requests() { test -z "$(ls -A "$state/requests")"; }

# A stand-in for GitHub's deployment API: records each call, answers with increasing ids.
fake_github() {
  local port
  port="$(free_port)"
  # shellcheck disable=SC2016 # JavaScript template literals
  node -e '
    const [log, port] = process.argv.slice(1);
    let next = 1;
    require("node:http").createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const call = { method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") };
        require("node:fs").appendFileSync(log, `${JSON.stringify(call)}\n`);
        const id = req.url.endsWith("/deployments") ? next++ : 0;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ url: "https://api.github.test", id, creator: { id: 999 } }));
      });
    }).listen(Number(port), "127.0.0.1");
  ' "$work/github-api.log" "$port" &
  api_pid=$!
  export HAMNIVO_GITHUB_API="http://127.0.0.1:$port"
}
# The deployment of COMMIT got exactly these statuses, in order, with the token.
github_saw() { # github_saw COMMIT STATE...
  # shellcheck disable=SC2016 # JavaScript template literals
  node -e '
    const [log, ref, ...want] = process.argv.slice(1);
    const calls = require("node:fs").readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    let id = 0;
    let count = 0;
    const states = [];
    for (const call of calls) {
      if (call.auth !== "Bearer smoke-token") process.exit(2);
      if (call.url.endsWith("/deployments")) {
        count += 1;
        if (call.body.ref === ref) id = count;
      } else if (id && call.url.endsWith(`/deployments/${id}/statuses`)) states.push(call.body.state);
    }
    if (JSON.stringify(states) !== JSON.stringify(want)) {
      console.error(`    GitHub statuses: ${states.join(", ") || "none"}`);
      process.exit(1);
    }
  ' "$work/github-api.log" "$1" "${@:2}"
}

# GitHub's published example (docs: "Validating webhook deliveries"), sent to a receiver of its
# own: a secret with a quote in it must still work.
github_test_vector() {
  local port status
  mkdir -p "$work/vector"
  chmod 777 "$work/vector"
  docker run -d --rm --name "$HAMNIVO_PROJECT-vector" -p 127.0.0.1::9000 --read-only --cap-drop ALL \
    -e "HAMNIVO_DEPLOY_WEBHOOK_SECRET=It's a Secret to Everybody" -e HAMNIVO_DEPLOY_REPOSITORY=smoke/hamnivo \
    -v "$work/vector:/requests" hamnivo/deploy-hook:local >/dev/null
  for _ in $(seq 1 20); do
    port="$(docker port "$HAMNIVO_PROJECT-vector" 9000/tcp 2>/dev/null | head -1 | sed 's/.*://')"
    status="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: text/plain' \
      -H 'X-GitHub-Event: ping' \
      -H 'X-Hub-Signature-256: sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17' \
      --data-binary 'Hello, World!' "http://127.0.0.1:${port:-1}/hooks/github" || true)"
    [[ "$status" == 000 ]] || break
    sleep 0.5
  done
  docker rm -f "$HAMNIVO_PROJECT-vector" >/dev/null 2>&1 || true
  [[ "$status" == 200 && -n "$(ls -A "$work/vector")" ]]
}

# The units as hamnivo.sh autodeploy enable writes them, checked by systemd where it exists.
units_valid() {
  command -v systemd-analyze >/dev/null || return 0
  local dir="$work/units" unit
  mkdir -p "$dir"
  for unit in hamnivo-deploy.service hamnivo-deploy.path hamnivo-deploy.timer; do
    sed -e "s|@USER@|$(id -un)|g" -e "s|@GROUP@|$(id -gn)|g" -e "s|@ROOT@|$server|g" \
      -e "s|@HAMNIVO@|$server/deploy/production/hamnivo.sh|g" -e "s|@ENV_FILE@|$HAMNIVO_ENV_FILE|g" \
      -e "s|@PROJECT@|$HAMNIVO_PROJECT|g" -e "s|@STATE@|$state|g" \
      "$server/deploy/production/systemd/$unit" >"$dir/$unit"
  done
  (cd "$dir" && systemd-analyze verify ./hamnivo-deploy.service ./hamnivo-deploy.path ./hamnivo-deploy.timer)
}

# Adds a migration that changes nothing to the developer's clone, the way drizzle-kit would.
add_smoke_migration() {
  local migrations="$dev/packages/db/migrations" stamp name
  stamp="$(date -u +%Y%m%d%H%M%S)"
  name="${stamp}_autodeploy_smoke"
  printf -- '-- Autodeploy smoke test: changes nothing.\nSELECT 1;\n' >"$migrations/$name.sql"
  cp "$(find "$migrations/meta" -name '*_snapshot.json' | sort | tail -1)" "$migrations/meta/${stamp}_snapshot.json"
  # shellcheck disable=SC2016 # JavaScript template literals
  node -e '
    const fs = require("node:fs");
    const [file, tag] = process.argv.slice(1);
    const journal = JSON.parse(fs.readFileSync(file, "utf8"));
    const last = journal.entries.at(-1);
    journal.entries.push({ idx: last.idx + 1, version: last.version, when: Date.now(), tag, breakpoints: true });
    fs.writeFileSync(file, `${JSON.stringify(journal, null, 2)}\n`);
  ' "$migrations/meta/_journal.json" "$name"
}

say 'GitHub, the server and a developer'
git clone --quiet --bare "$root" "$github"
head="$(git -C "$root" rev-parse HEAD)"
git -C "$github" update-ref refs/heads/main "$head"
git -C "$github" symbolic-ref HEAD refs/heads/main
git clone --quiet --branch main "$github" "$server"
git clone --quiet --branch main "$github" "$dev"
git -C "$dev" config user.email smoke@hamnivo.test
git -C "$dev" config user.name 'Autodeploy smoke test'

say 'A: the first install, then automatic deploys'
"${hv[@]}" setup --domain hamnivo.localhost --tls internal \
  --https-port "$(free_port)" --http-port "$(free_port)" --quiet
set_env REQUIRE_EMAIL_VERIFICATION false
set_env CHATWOOT_WEBHOOK_BASE_URL http://api:4000
set_env CHATWOOT_ALLOW_PRIVATE_WEBHOOKS true
set_env COMPOSE_PROFILES ''
set_env CLAMAV_URL ''
set_env HAMNIVO_IMAGE_TAG autodeploy-a
set_env HAMNIVO_DEPLOY_REPOSITORY smoke/hamnivo
set_env GITHUB_DEPLOY_TOKEN smoke-token
fake_github
"${hv[@]}" up --quiet
"${hv[@]}" autodeploy enable --mode webhook --no-systemd
edge="$("${hv[@]}" compose ps -q edge)"
for _ in $(seq 1 30); do
  docker cp "$edge:/data/caddy/pki/authorities/local/root.crt" "$work/ca.crt" 2>/dev/null && break
  sleep 2
done
check 'version A is recorded as live' test "$(current_commit)" = "$head"
check 'the systemd units are valid' units_valid

say 'The webhook, through Caddy'
check 'a wrong signature is refused (500)' test "$(webhook push "$(push_body x)" wrong-secret)" = 500
check 'a missing signature is refused (403)' test "$(webhook push "$(push_body x)" none)" = 403
check 'another repository is refused (403)' test "$(webhook push "$(push_body x main other/repo)")" = 403
check 'another event is refused (403)' test "$(webhook issues "$(push_body x)")" = 403
check 'and none of them requests anything' no_requests
check "GitHub's ping is accepted" test "$(webhook ping '{"zen":"Design for failure."}')" = 200
check 'and requests a deploy check' test -n "$(ls -A "$state/requests")"
run_service
check 'with nothing new, nothing is deployed' test "$(history_lines)" -eq 0
check 'a push to another branch is accepted' test "$(webhook push "$(push_body x feature/y)")" = 200
run_service
check 'and deploys nothing' test "$(history_lines)" -eq 0
check "GitHub's published test vector passes" github_test_vector

say 'The runner'
# flock -o: the lock goes away with flock itself, not with the sleep it runs.
flock -o "$state/deploy.lock" sleep 60 &
lock_pid=$!
sleep 1
check 'a run while another holds the lock leaves at once' run_service
kill "$lock_pid" 2>/dev/null
wait "$lock_pid" 2>/dev/null || true
lock_pid=''

say 'B: a push goes live'
mkdir -p "$dev/apps/site/public"
printf 'B\n' >"$dev/apps/site/public/autodeploy-smoke.txt"
b="$(commit_push 'Autodeploy smoke B: a new website file')"
printf '\n' >>"$server/README.md"
run_service || true
check 'a file changed on the server stops the deploy' history_has "$(short "$b")	failed	timer	.*local changes"
check 'and A keeps running' test "$(current_commit)" = "$head"
git -C "$server" checkout -- README.md
check 'the push webhook is accepted' test "$(webhook push "$(push_body "$b")")" = 200
run_service
check 'B is live' test "$(current_commit)" = "$b"
check 'the history says so, triggered by the webhook' history_has "$(short "$b")	live	webhook"
check 'the API runs the images of B' test "$(api_label)" = "$b"
check '.env names the images of B' test "$(env_value HAMNIVO_IMAGE_TAG)" = "$(short "$b")"
check 'the website serves B' test "$(site_file)" = B
check 'GitHub heard: in progress, then success' github_saw "$b" in_progress success
check 'nothing changed the database, so there is no backup' test "$(backup_count)" -eq 0

say 'C: a version with a new migration that never gets healthy'
add_smoke_migration
sed -i "s|    command: \['node', 'dist/main.api.js'\]|    command: ['node', '-e', 'process.exit(3)']|" \
  "$dev/deploy/production/compose.yml"
c="$(commit_push 'Autodeploy smoke C: a migration, and the API stops at once')"
webhook push "$(push_body "$c")" >/dev/null
run_service || true
check 'the database was backed up first' test "$(backup_count)" -eq 1
check 'not into the nightly backups' test -z "$(find "$backups" -mindepth 1 -maxdepth 1 -name '20*')"
check 'C was rolled back' history_has "$(short "$c")	rolled-back"
check 'B is live again' test "$(current_commit)" = "$b"
check 'the API runs B again, on the migrated database' test "$(api_label)" = "$b"
check 'the website still serves B' test "$(site_file)" = B
check '.env is as it was' test "$(env_value HAMNIVO_IMAGE_TAG)" = "$(short "$b")"
check 'GitHub heard: in progress, then failure' github_saw "$c" in_progress failure
lines="$(history_lines)"
run_service
check 'C is not retried automatically' test "$(history_lines)" -eq "$lines"

say 'D: a failing unit test'
git -C "$dev" checkout -q HEAD~1 -- deploy/production/compose.yml
cat >"$dev/packages/domain/test/autodeploy-smoke.test.ts" <<'EOF'
import { expect, it } from 'vitest';

it('fails on purpose (autodeploy smoke test)', () => {
  expect(1).toBe(2);
});
EOF
d="$(commit_push 'Autodeploy smoke D: a failing test')"
before="$(api_id)"
run_service || true
check 'D stopped at the checks' history_has "$(short "$d")	failed	timer	.*stopped at checks-and-build"
check 'B is still live' test "$(current_commit)" = "$b"
check 'its containers were not restarted' test "$(api_id)" = "$before"
check 'GitHub heard: in progress, then failure' github_saw "$d" in_progress failure

say 'E: the fix, then a rollback by hand'
git -C "$dev" rm -q packages/domain/test/autodeploy-smoke.test.ts
e="$(commit_push 'Autodeploy smoke E: the fix')"
webhook push "$(push_body "$e")" >/dev/null
run_service
check 'E is live' test "$(current_commit)" = "$e"
check "it carries C's migration, so it backed up too" test "$(backup_count)" -eq 2
check 'the images of the first install were pruned' \
  bash -c '! docker image inspect hamnivo/gateway:autodeploy-a >/dev/null 2>&1'
"${hv[@]}" rollback
check 'the rollback by hand brings B back' test "$(current_commit)" = "$b"
check 'the API runs B' test "$(api_label)" = "$b"
run_service
check 'E is not redeployed automatically after that' test "$(current_commit)" = "$b"

say 'G: a new version of other software waits for a person'
awk '/^  chatwoot-redis:/ { redis = 1 } redis && /image: valkey\/valkey:8-alpine/ { sub(/8-alpine/, "8.1-alpine"); redis = 0 } { print }' \
  "$dev/deploy/production/compose.yml" >"$work/compose.yml"
cp "$work/compose.yml" "$dev/deploy/production/compose.yml"
g="$(commit_push 'Autodeploy smoke G: a newer Valkey for Chatwoot')"
webhook push "$(push_body "$g")" >/dev/null
run_service
check 'G is held' history_has "$(short "$g")	held	webhook	.*valkey/valkey:8.1-alpine"
check 'B is still live' test "$(current_commit)" = "$b"
check 'GitHub heard: in progress, then pending' github_saw "$g" in_progress pending
check 'the deploy list says it waits' bash -c '"$@" deploys | grep -q "Waiting for a deploy by hand"' _ "${hv[@]}"
lines="$(history_lines)"
run_service
check 'G is not tried again automatically' test "$(history_lines)" -eq "$lines"

say 'H: the next commit goes live as usual'
git -C "$dev" checkout -q HEAD~1 -- deploy/production/compose.yml
h="$(commit_push 'Autodeploy smoke H: Valkey as before')"
webhook push "$(push_body "$h")" >/dev/null
run_service
check 'H is live' test "$(current_commit)" = "$h"
check 'the API runs H' test "$(api_label)" = "$h"
check "C's migration made another backup" test "$(backup_count)" -eq 3
check 'the held version no longer waits' bash -c '! "$@" deploys | grep -q "Waiting for a deploy by hand"' _ "${hv[@]}"

say 'F: an update after a git pull by hand, onto images that do not name their commit'
printf 'FROM hamnivo/gateway:%s\nLABEL org.opencontainers.image.revision=""\n' "$(short "$h")" |
  docker build -q -t hamnivo/gateway:unlabelled - >/dev/null
docker tag "hamnivo/edge:$(short "$h")" hamnivo/edge:unlabelled
set_env HAMNIVO_IMAGE_TAG unlabelled
"${hv[@]}" up --no-build --quiet
rm -f "$state/current" "$state/previous"
git -C "$server" checkout -q -B main origin/main
"${hv[@]}" update </dev/null
check 'the update deployed H although HEAD was already H' test "$(current_commit)" = "$h"
check 'the API runs images labelled H' test "$(api_label)" = "$h"
check 'it backed up first' test "$(backup_count)" -eq 4
"${hv[@]}" deploys

if ((failures > 0)); then
  printf '\n%d check(s) failed\n' "$failures"
  exit 1
fi
printf '\nAll automatic deploy checks passed.\n'
