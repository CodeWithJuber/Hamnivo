#!/usr/bin/env bash
# Hamnivo's complete check pipeline, for your own machine or server (there is no hosted CI).
#
#   pnpm ci:local                    every check below except the opt-in production smoke test
#   pnpm ci:local --quick            install, lint, typecheck, unit tests, status/licence checks,
#                                    and that no workflow uses what GitHub bills for
#   pnpm ci:local --skip-a11y        skip the Storybook accessibility audit
#   pnpm ci:local --skip-chatwoot    skip the contract suite against a real Chatwoot
#   pnpm ci:local --skip-e2e         skip the browser checks (widget journey and website)
#   pnpm ci:local --with-production  also build the production images and check the real
#                                    deployment with a backup and restore drill (10–20 minutes)
#   pnpm ci:local --with-autodeploy  also check automatic deploys: webhook, checks, rollback
#                                    against a stand-in for GitHub (20–40 minutes)
#   PG_VERSIONS=18 pnpm ci:local     run integration tests on one PostgreSQL major only
#
# Integration tests run against throwaway PostgreSQL (+pgvector), Valkey and Chatwoot containers
# with generated passwords, so your development data is never touched.
# Needs: Node >= 22.12 (24 recommended), pnpm 10, Docker, openssl; shellcheck for the scripts.
# Writes a summary to test-results/ci-local.md.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

quick=0
a11y=1
chatwoot=1
e2e=1
production=0
autodeploy=0
for arg in "$@"; do
  case "$arg" in
    --quick) quick=1 ;;
    --skip-a11y) a11y=0 ;;
    --skip-chatwoot) chatwoot=0 ;;
    --skip-e2e) e2e=0 ;;
    --with-production) production=1 ;;
    --with-autodeploy) autodeploy=1 ;;
    -h | --help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

# A runner short of memory (deploy/ci-runner) sets HAMNIVO_CI_CONCURRENCY to run fewer turbo tasks
# at once; turbo has no variable of its own for this. Elsewhere turbo keeps its default.
turbo_limit=()
if [[ -n "${HAMNIVO_CI_CONCURRENCY:-}" ]]; then
  turbo_limit=(--concurrency="$HAMNIVO_CI_CONCURRENCY")
fi
# Type checks and builds take the most memory: the gateway's and Studio's type checks need about
# 1.7 GB each, so two side by side outgrow a 4 GB runner (ADR 0019). On such a runner they run one
# at a time (HAMNIVO_CI_HEAVY_CONCURRENCY, or 1 when only HAMNIVO_CI_CONCURRENCY is set).
heavy_limit=()
if [[ -n "${HAMNIVO_CI_HEAVY_CONCURRENCY:-}" ]]; then
  heavy_limit=(--concurrency="$HAMNIVO_CI_HEAVY_CONCURRENCY")
elif [[ -n "${HAMNIVO_CI_CONCURRENCY:-}" ]]; then
  heavy_limit=(--concurrency=1)
fi

results=()
containers=()
compose_projects=()
chatwoot_file="$root/deploy/compose/chatwoot.yml"
remove_chatwoot() {
  # Interpolation needs the required variables even when tearing down.
  CHATWOOT_SECRET_KEY_BASE=unused CHATWOOT_DB_PASSWORD=unused \
    docker compose -p "$1" -f "$chatwoot_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
cleanup() {
  ((${#containers[@]})) && docker rm -f -v "${containers[@]}" >/dev/null 2>&1
  # The ${a[@]+...} form: macOS bash 3.2 treats an empty array as unbound under set -u.
  for project in ${compose_projects[@]+"${compose_projects[@]}"}; do remove_chatwoot "$project"; done
  true
}
trap cleanup EXIT

summary() {
  mkdir -p test-results
  {
    echo "# Hamnivo local checks"
    echo
    echo "- Commit: \`$(git rev-parse --short HEAD 2>/dev/null || echo unknown)\`$(git diff --quiet 2>/dev/null || echo ' (with uncommitted changes)')"
    echo "- Host: $(uname -srm), Node $(node --version), pnpm $(pnpm --version)"
    echo "- Finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo
    printf -- '- %s\n' "${results[@]}"
  } | tee test-results/ci-local.md
}

step() {
  local name="$1"
  shift
  printf '\n\033[1;36m==> %s\033[0m\n' "$name"
  local start=$SECONDS
  if "$@"; then
    results+=("PASS $name ($((SECONDS - start))s)")
  else
    results+=("FAIL $name")
    printf '\n\033[1;31mFAILED: %s\033[0m\n\n' "$name"
    summary
    exit 1
  fi
}

require() {
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null || { echo "Missing required command: $cmd (see docs/self-hosting.md)" >&2; exit 1; }
  done
}

# Unit tests, then the commerce adapter's contract tests against stripe-mock (Stripe's own API
# mock) on a random local port; without it those tests are skipped. They run directly, not
# through turbo, which would neither pass STRIPE_MOCK_URL on nor rerun a cached result. The
# full run needs Docker for them; --quick leaves them out when Docker is not available.
unit_tests() {
  local stripe="hamnivo-check-stripe-$$" port
  pnpm test ${turbo_limit[@]+"${turbo_limit[@]}"} || return 1
  if ((quick == 1)) && ! docker info >/dev/null 2>&1; then
    return 0
  fi
  docker run -d --rm --name "$stripe" -p 127.0.0.1::12111 stripe/stripe-mock:v0.205.0 >/dev/null ||
    return 1
  containers+=("$stripe")
  port="$(docker port "$stripe" 12111/tcp | head -1 | awk -F: '{print $NF}')"
  for _ in $(seq 1 30); do
    curl -fsS -o /dev/null -u sk_test_123: "http://127.0.0.1:$port/v1/charges" && break
    sleep 1
  done
  STRIPE_MOCK_URL="http://127.0.0.1:$port" pnpm --filter @hamnivo/adapters exec \
    vitest run test/commerce/stripe-mock.test.ts
}

# The chat's first open within its gzip budget (scripts/ci/widget-size.ts). The widget is built in
# a step of its own, one heavy task at a time, so its build never shares memory with the unit tests.
widget_size() {
  pnpm exec turbo run build --filter=@hamnivo/widget ${heavy_limit[@]+"${heavy_limit[@]}"} >/dev/null ||
    return 1
  pnpm exec tsx scripts/ci/widget-size.ts
}

wait_for_postgres() {
  local container="$1"
  for _ in $(seq 1 120); do
    # The init phase only listens on the Unix socket, so TCP readiness means init has finished.
    docker exec "$container" pg_isready -q -h 127.0.0.1 -U postgres && return 0
    sleep 1
  done
  docker logs "$container" | tail -40
  return 1
}

# Starts a throwaway PostgreSQL (with pgvector and the Hamnivo roles) and Valkey with fresh random
# passwords, and sets `service_env` (for `env`) and `service_pg` (the container to remove).
throwaway_services() {
  local version="$1" su owner app platform valkey pg_port valkey_port
  su="$(openssl rand -hex 16)"
  owner="$(openssl rand -hex 16)"
  app="$(openssl rand -hex 16)"
  platform="$(openssl rand -hex 16)"
  service_pg="hamnivo-check-pg${version}-$$-$RANDOM"
  valkey="hamnivo-check-valkey-$$"

  docker run -d --rm --name "$service_pg" \
    -e POSTGRES_PASSWORD="$su" \
    -e HAMNIVO_DB_OWNER_PASSWORD="$owner" \
    -e HAMNIVO_DB_APP_PASSWORD="$app" \
    -e HAMNIVO_DB_PLATFORM_PASSWORD="$platform" \
    -e HAMNIVO_DB_SQL_DIR=/hamnivo-db-init \
    -v "$root/deploy/postgres:/hamnivo-db-init:ro" \
    -v "$root/deploy/postgres/init.sh:/docker-entrypoint-initdb.d/10-hamnivo.sh:ro" \
    -p 127.0.0.1::5432 "pgvector/pgvector:pg${version}" >/dev/null || return 1
  containers+=("$service_pg")
  if ! docker ps --format '{{.Names}}' | grep -qx "$valkey"; then
    docker run -d --rm --name "$valkey" -p 127.0.0.1::6379 valkey/valkey:8-alpine \
      valkey-server --maxmemory-policy noeviction >/dev/null || return 1
    containers+=("$valkey")
  fi
  # errexit is suspended inside `if step ...`, so every fallible command returns explicitly.
  wait_for_postgres "$service_pg" || return 1
  pg_port="$(docker port "$service_pg" 5432/tcp | head -1 | awk -F: '{print $NF}')"
  valkey_port="$(docker port "$valkey" 6379/tcp | head -1 | awk -F: '{print $NF}')"
  service_env=(
    DATABASE_URL="postgres://hamnivo_app:$app@127.0.0.1:$pg_port/hamnivo"
    DATABASE_OWNER_URL="postgres://hamnivo_owner:$owner@127.0.0.1:$pg_port/hamnivo"
    DATABASE_PLATFORM_URL="postgres://hamnivo_platform:$platform@127.0.0.1:$pg_port/hamnivo"
    REDIS_URL="redis://127.0.0.1:$valkey_port"
    HAMNIVO_PG_MAJOR="$version"
  )
}

integration() {
  throwaway_services "$1" || return 1
  env -u CHATWOOT_URL -u CHATWOOT_PLATFORM_TOKEN "${service_env[@]}" pnpm test:int
  local status=$?
  docker rm -f -v "$service_pg" >/dev/null 2>&1 || true
  return "$status"
}

# The customer journey in a real browser: host page → loader → widget → gateway and worker (built,
# as separate processes) → fake Chatwoot, with an accessibility audit of the widget.
widget_journey() {
  throwaway_services 18 || return 1
  pnpm build ${heavy_limit[@]+"${heavy_limit[@]}"} >/dev/null || return 1
  env -u CHATWOOT_URL -u CHATWOOT_PLATFORM_TOKEN -u WIDGET_SIGNING_KEY "${service_env[@]}" \
    pnpm --filter @hamnivo/widget test:e2e
  local status=$?
  docker rm -f -v "$service_pg" >/dev/null 2>&1 || true
  return "$status"
}

# Studio (the staff console) in a real browser: sign-up to install snippet, publishing with a fresh
# sign-in, model keys, knowledge, stopping the AI and runs, with axe audits in English and Arabic.
studio_journey() {
  throwaway_services 18 || return 1
  pnpm build ${heavy_limit[@]+"${heavy_limit[@]}"} >/dev/null || return 1
  env -u CHATWOOT_URL -u CHATWOOT_PLATFORM_TOKEN -u WIDGET_SIGNING_KEY "${service_env[@]}" \
    pnpm --filter @hamnivo/console test:e2e
  local status=$?
  docker rm -f -v "$service_pg" >/dev/null 2>&1 || true
  return "$status"
}

# The deploy scripts run unattended on servers, so every shell script must pass shellcheck.
shell_scripts() {
  if ! command -v shellcheck >/dev/null; then
    echo 'shellcheck is not installed (sudo apt-get install shellcheck): skipped.' >&2
    return 0
  fi
  git ls-files -z '*.sh' .githooks/pre-push | xargs -0 shellcheck -x
}

free_port() {
  node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })'
}

chatwoot_contract() {
  local project="hamnivo-check-chatwoot-$$" port output token status
  port="$(free_port)" || return 1
  compose_projects+=("$project")
  output="$(
    COMPOSE_PROJECT_NAME="$project" CHATWOOT_BIND=127.0.0.1 CHATWOOT_PORT="$port" \
      CHATWOOT_URL="http://127.0.0.1:$port" \
      CHATWOOT_SECRET_KEY_BASE="$(openssl rand -hex 64)" CHATWOOT_DB_PASSWORD="$(openssl rand -hex 16)" \
      CHATWOOT_ADMIN_EMAIL="admin-$$@hamnivo.invalid" CHATWOOT_ADMIN_PASSWORD="Hv-$(openssl rand -hex 12)-9a!" \
      bash "$root/scripts/chatwoot/up.sh" --ephemeral
  )" || return 1
  token="$(printf '%s\n' "$output" | sed -n 's/^CHATWOOT_PLATFORM_TOKEN=//p' | tail -1)"
  [[ -n "$token" ]] || return 1
  CHATWOOT_URL="http://127.0.0.1:$port" CHATWOOT_PLATFORM_TOKEN="$token" \
    pnpm --filter @hamnivo/chatwoot test:int
  status=$?
  remove_chatwoot "$project"
  return "$status"
}

# The supply chain (production-ready plan): what ships has no high or critical advisory, and the
# code holds no secret. The audit asks npm's registry; gitleaks reads the whole git history with
# the rules in .gitleaks.toml (made-up keys in tests and examples are allowed).
dependency_audit() {
  pnpm audit --prod --audit-level=high
}
secret_scan() {
  if ! command -v gitleaks >/dev/null; then
    echo 'gitleaks is not installed (deploy/ci-runner/Dockerfile installs it): skipped.' >&2
    return 0
  fi
  gitleaks git --no-banner --redact --config .gitleaks.toml .
}

require node pnpm git openssl
step "Install dependencies (frozen lockfile)" pnpm install --frozen-lockfile
step "Lint and format (Biome)" pnpm lint
step "Typecheck" pnpm typecheck ${heavy_limit[@]+"${heavy_limit[@]}"}
step "Unit tests" unit_tests
step "Chat's first open within its size budget" widget_size
step "Shell scripts (shellcheck)" shell_scripts
step "Workflows use nothing GitHub bills for" bash scripts/ci/no-github-billing.sh
step "Production dependencies have no high or critical advisory" dependency_audit
step "No secrets in the code (gitleaks)" secret_scan

# The deploy scripts run on Linux servers and use flock and GNU touch, which macOS lacks; elsewhere
# the same test runs in a Debian container (safe.directory: the mount belongs to another user).
deploy_scripts() {
  if [[ "$(uname -s)" == Linux ]]; then
    bash scripts/ci/deploy-https-test.sh
    return
  fi
  docker run --rm -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e 'GIT_CONFIG_VALUE_0=*' \
    -v "$root:/repo:ro" -w /repo debian:bookworm-slim bash -c \
    'apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends git curl ca-certificates util-linux procps >/dev/null && bash scripts/ci/deploy-https-test.sh'
}
step "Deploy scripts: doctor and HTTPS rules (stand-ins; in Linux)" deploy_scripts
step "Feature status matrix is current" pnpm exec tsx scripts/feature-status/generate.ts --check
step "Licence inventory is current and reviewed" pnpm exec tsx scripts/licenses/inventory.ts --check

if ((quick == 0)); then
  require docker
  for version in ${PG_VERSIONS:-16 18}; do
    step "Integration tests (PostgreSQL $version + Valkey)" integration "$version"
  done
  if ((chatwoot == 1)); then
    step "Chatwoot contract suite (real Chatwoot v4.18.0-ce)" chatwoot_contract
  fi
  if ((a11y == 1)); then
    step "Build brand assets" pnpm --filter @hamnivo/brand build
    step "Build Storybook" pnpm --filter @hamnivo/ui build-storybook
    step "Accessibility audit (light/dark x LTR/RTL)" pnpm --filter @hamnivo/ui test:a11y
  fi
  if ((e2e == 1)); then
    step "Widget journey in a browser (Playwright + axe)" widget_journey
    step "Studio in a browser (Playwright + axe)" studio_journey
    # The journey's build step also built the static website.
    step "Website in a browser (Playwright + axe, 4 languages)" pnpm --filter @hamnivo/site test:e2e
  fi
fi

if ((quick == 0 && production == 1)); then
  step "Production deployment smoke test (images, HTTPS, Chatwoot, backup and restore)" \
    bash "$root/scripts/ci/production-smoke.sh"
fi
if ((quick == 0 && autodeploy == 1)); then
  step "Automatic deploy smoke test (webhook, checks, rollback)" \
    bash "$root/scripts/ci/autodeploy-smoke.sh"
fi

summary
printf '\n\033[1;32mAll checks passed.\033[0m\n'
