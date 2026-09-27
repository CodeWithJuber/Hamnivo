#!/usr/bin/env bash
# Automatic deploy smoke test (deploy/production/deploy.sh). A bare repository stands in for GitHub,
# a clone of it for the server, and a small local server for GitHub's deployment API. The stack
# runs in its own compose project with Caddy's internal CA; everything is deleted afterwards.
#
#   bash scripts/ci/autodeploy-smoke.sh [--keep]
#
# What a push goes through, end to end:
#   A  the first install (hamnivo.sh up), then autodeploy enable (webhook mode, without systemd)
#      the webhook, through Caddy: a wrong signature, then GitHub's ping
#   B  a signed push is deployed: checks, build, start, health; GitHub hears each step
#   C  a version that never gets healthy is rolled back to B, and not retried automatically
#   D  a failing unit test stops the deploy before anything restarts
#   E  the fix goes live; a rollback by hand brings B back, and E is not redeployed automatically
# The test does what the systemd units would (see run_service). HAMNIVO_BUILD_CA and
# HAMNIVO_BUILD_NETWORK are passed to the image builds (see deploy/production/hamnivo.sh).
set -euo pipefail

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
export HAMNIVO_DEPLOY_MIN_FREE_GB="${HAMNIVO_DEPLOY_MIN_FREE_GB:-2}"
state="$server/deploy/production/state"
hv=(bash "$server/deploy/production/hamnivo.sh")
failures=0
api_pid=''

cleanup() {
  [[ -n "$api_pid" ]] && kill "$api_pid" 2>/dev/null
  if ((keep == 1)); then
    printf 'Left running: HAMNIVO_ENV_FILE=%s HAMNIVO_PROJECT=%s %s status\n' \
      "$HAMNIVO_ENV_FILE" "$HAMNIVO_PROJECT" "${hv[1]}" >&2
    return
  fi
  if [[ -f "$HAMNIVO_ENV_FILE" ]]; then
    "${hv[@]}" compose --profile autodeploy down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  # The images this test built: the first install's and those of the commits it deployed.
  local tag
  for tag in autodeploy-a $(cut -f2 "$state/history.tsv" 2>/dev/null | sort -u); do
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

# Posts a GitHub-style webhook through Caddy; prints the HTTP status.
webhook() { # webhook EVENT BODY [SECRET]
  local secret="${3:-$(env_value HAMNIVO_DEPLOY_WEBHOOK_SECRET)}" signature host port
  signature="sha256=$(printf '%s' "$2" | openssl dgst -sha256 -hmac "$secret" | sed 's/^.* //')"
  host="$(env_value HAMNIVO_API_HOST)"
  port="$(env_value HAMNIVO_HTTPS_PORT)"
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 --cacert "$work/ca.crt" \
    --resolve "$host:$port:127.0.0.1" -X POST -H 'content-type: application/json' \
    -H "X-GitHub-Event: $1" -H "X-Hub-Signature-256: $signature" --data-binary "$2" \
    "https://$host:$port/_deploy/github"
}
push_body() { printf '{"ref":"refs/heads/main","after":"%s","repository":{"full_name":"smoke/hamnivo"}}' "$1"; }

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

say 'The webhook, through Caddy'
check 'a wrong signature is refused' test "$(webhook push "$(push_body x)" wrong-secret)" != 200
check 'and requests nothing' test -z "$(ls -A "$state/requests")"
check "GitHub's ping is accepted" test "$(webhook ping '{"zen":"Design for failure."}')" = 200
sleep 1
check 'and requests a deploy check' test -n "$(ls -A "$state/requests")"
run_service
check 'with nothing new, nothing is deployed' test "$(history_lines)" -eq 0

say 'B: a push goes live'
printf 'B\n' >"$dev/apps/site/public/autodeploy-smoke.txt"
b="$(commit_push 'Autodeploy smoke B: a new website file')"
check 'the push webhook is accepted' test "$(webhook push "$(push_body "$b")")" = 200
sleep 1
run_service
check 'B is live' test "$(current_commit)" = "$b"
check 'the history says so, triggered by the webhook' history_has "$(short "$b")	live	webhook"
check 'the API runs the images of B' test "$(api_label)" = "$b"
check '.env names the images of B' test "$(env_value HAMNIVO_IMAGE_TAG)" = "$(short "$b")"
check 'the website serves B' test "$(site_file)" = B
check 'GitHub heard: in progress, then success' github_saw "$b" in_progress success

say 'C: a version that never gets healthy'
sed -i "s|    command: \['node', 'dist/main.api.js'\]|    command: ['node', '-e', 'process.exit(3)']|" \
  "$dev/deploy/production/compose.yml"
c="$(commit_push 'Autodeploy smoke C: the API stops at once')"
webhook push "$(push_body "$c")" >/dev/null
sleep 1
run_service || true
check 'C was rolled back' history_has "$(short "$c")	rolled-back"
check 'B is live again' test "$(current_commit)" = "$b"
check 'the API runs B again' test "$(api_label)" = "$b"
check 'the website still serves B' test "$(site_file)" = B
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
sleep 1
run_service
check 'E is live' test "$(current_commit)" = "$e"
check 'the images of the first install were pruned' \
  bash -c '! docker image inspect hamnivo/gateway:autodeploy-a >/dev/null 2>&1'
"${hv[@]}" rollback
check 'the rollback by hand brings B back' test "$(current_commit)" = "$b"
check 'the API runs B' test "$(api_label)" = "$b"
run_service
check 'E is not redeployed automatically after that' test "$(current_commit)" = "$b"
"${hv[@]}" deploys

if ((failures > 0)); then
  printf '\n%d check(s) failed\n' "$failures"
  exit 1
fi
printf '\nAll automatic deploy checks passed.\n'
