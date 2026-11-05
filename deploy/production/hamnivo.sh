#!/usr/bin/env bash
# Runs Hamnivo on this server with Docker Compose (deploy/production/compose.yml).
#
#   hamnivo.sh setup --domain example.com --email you@example.com
#                           create or complete deploy/production/.env (secrets are generated)
#   hamnivo.sh up           build the images, start everything, connect Chatwoot, print the addresses
#   hamnivo.sh status       services and their health
#   hamnivo.sh doctor       check this server (services, HTTPS for every name, ports, disk, memory,
#                           certificates, deploys) and say how to fix what is wrong; only reads
#   hamnivo.sh logs [service...]
#   hamnivo.sh mail [ADDRESS]   the latest emails, while SMTP_URL is not set (they go to the API log)
#   hamnivo.sh backup [--to DIR] [--keep N] [--no-secrets]
#   hamnivo.sh restore DIR [--yes] [--ignore-current-database]
#   hamnivo.sh update       deploy the latest commit of the deploy branch now (see deploy)
#   hamnivo.sh deploy [--latest | REF] [--force]   check, build, start, and roll back on failure
#   hamnivo.sh rollback [COMMIT]   run the previous (or a given) version again
#   hamnivo.sh deploys      recent deploys and their results
#   hamnivo.sh autodeploy enable|disable|pause|resume|status   deploy on every push to GitHub
#   hamnivo.sh down         stop everything (data stays in Docker volumes)
#   hamnivo.sh compose ...  any docker compose command with this stack's files and settings
#
# Setup options: --tls internal (Caddy's own CA instead of Let's Encrypt, for tests and private
# networks), --https-port N and --http-port N (other ports than 443 and 80), --public-port N (the
# HTTPS port browsers use, when a web server in front of this one answers on it and passes the
# requests on to --https-port; usually 443), --cloudflare on|off (the names are proxied by
# Cloudflare: believe the visitor addresses it reports), --quiet.
# Environment: HAMNIVO_ENV_FILE (default deploy/production/.env), HAMNIVO_PROJECT (compose
# project name), HAMNIVO_BUILD_CA (CA file for builds behind a TLS-inspecting proxy),
# HAMNIVO_BUILD_NETWORK (docker build --network), HAMNIVO_BUILD_CONCURRENCY (packages built at
# once, default 2; also read from .env), HAMNIVO_WAIT_SECONDS (default 900).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/production/lib.sh
source "$here/lib.sh"

# --- setup ---------------------------------------------------------------------------------------
cmd_setup() {
  local domain='' tls='' https_port='' http_port='' public_port='' cloudflare='' quiet=0
  while (($#)); do
    case "$1" in
      --quiet) quiet=1; shift ;;
      --cloudflare) cloudflare="${2:?--cloudflare needs on or off}"; shift 2 ;;
      --domain) domain="${2:?--domain needs a value}"; shift 2 ;;
      --email) tls="${2:?--email needs a value}"; shift 2 ;;
      --tls) tls="${2:?--tls needs a value}"; shift 2 ;;
      --https-port) https_port="${2:?--https-port needs a value}"; shift 2 ;;
      --http-port) http_port="${2:?--http-port needs a value}"; shift 2 ;;
      --public-port) public_port="${2:?--public-port needs a value}"; shift 2 ;;
      *) fail "Unknown setup option: $1" ;;
    esac
  done
  command -v openssl >/dev/null || fail 'openssl is required (sudo apt-get install openssl).'
  umask 077
  touch "$env_file"

  [[ -n "$https_port" ]] && set_kv HAMNIVO_HTTPS_PORT "$https_port"
  [[ -n "$http_port" ]] && set_kv HAMNIVO_HTTP_PORT "$http_port"
  if [[ -n "$public_port" ]]; then
    [[ "$public_port" =~ ^[0-9]+$ ]] || fail "Not a port: $public_port"
    set_kv HAMNIVO_PUBLIC_HTTPS_PORT "$public_port"
  fi
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

  # The addresses carry the port browsers use: the edge's own HTTPS port, unless a web server in
  # front of this one answers on another (HAMNIVO_PUBLIC_HTTPS_PORT, usually 443).
  local port suffix='' site old_api
  port="$(get HAMNIVO_PUBLIC_HTTPS_PORT)"
  [[ -n "$port" ]] || port="$(get HAMNIVO_HTTPS_PORT)"
  [[ "$port" == 443 ]] || suffix=":$port"
  site="$(get HAMNIVO_SITE_HOSTS)"
  site="${site%% *}"
  old_api="$(get HAMNIVO_API_ORIGIN)"
  set_kv HAMNIVO_APP_ORIGIN "https://$(get HAMNIVO_APP_HOST)$suffix"
  set_kv HAMNIVO_API_ORIGIN "https://$(get HAMNIVO_API_HOST)$suffix"
  set_kv HAMNIVO_CHAT_ORIGIN "https://$(get HAMNIVO_CHAT_HOST)$suffix"
  set_kv HAMNIVO_SUPPORT_ORIGIN "https://$(get HAMNIVO_SUPPORT_HOST)$suffix"
  set_kv HAMNIVO_SITE_ORIGIN "https://$site$suffix"
  # Chatwoot calls the gateway's webhooks at its public HTTPS name, and follows the API's address
  # unless it was set to another one.
  if ((renamed == 1)) || ! has CHATWOOT_WEBHOOK_BASE_URL ||
    [[ "$(get CHATWOOT_WEBHOOK_BASE_URL)" == "$old_api" ]]; then
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

  if [[ -n "$cloudflare" ]]; then
    [[ "$cloudflare" == on || "$cloudflare" == off ]] || fail '--cloudflare is on or off.'
    set_kv HAMNIVO_CLOUDFLARE "$cloudflare"
    [[ "$cloudflare" == on ]] || set_kv HAMNIVO_TRUSTED_PROXIES ''
  fi
  ensure HAMNIVO_CLOUDFLARE off
  refresh_trusted_proxies

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
  local public
  public="$(get HAMNIVO_PUBLIC_HTTPS_PORT)"
  if [[ -n "$public" && "$public" != "$(get HAMNIVO_HTTPS_PORT)" ]]; then
    printf '%s\n' "Browsers use port $public: the web server in front of this one must pass it on to port $(get HAMNIVO_HTTPS_PORT)." >&2
  fi
  if [[ -z "$(get SMTP_URL)" ]]; then
    printf '%s\n' "Email: set SMTP_URL in $env_file to send sign-in emails (until then, read them with: $0 mail)." >&2
  fi
}

# --- Cloudflare ----------------------------------------------------------------------------------
# Behind Cloudflare's proxy (HAMNIVO_CLOUDFLARE=on), every connection comes from Cloudflare. The
# edge then takes each visitor's address from Cloudflare's headers, but only on connections from
# Cloudflare's published ranges, kept in HAMNIVO_TRUSTED_PROXIES and refreshed by setup and up.
# The ranges this version knows, for when cloudflare.com can't be reached and none are stored yet:
cloudflare_ranges='173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18
108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15
104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32
2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32'

# Prints the address ranges of one list (ips-v4 or ips-v6); fails when it can't get a valid list.
cloudflare_list() {
  local body range out=''
  body="$(curl -fsS --max-time 10 "${HAMNIVO_CLOUDFLARE_IPS_URL:-https://www.cloudflare.com}/$1" 2>/dev/null)" || return 1
  while IFS= read -r range; do
    range="${range//[[:space:]]/}"
    [[ -z "$range" ]] && continue
    [[ "$range" =~ ^[0-9a-fA-F.:]+/[0-9]{1,3}$ ]] || return 1
    out+="${out:+ }$range"
  done <<<"$body"
  [[ -n "$out" ]] && printf '%s' "$out"
}

refresh_trusted_proxies() {
  [[ "$(get HAMNIVO_CLOUDFLARE)" == on ]] || return 0
  local v4 v6 list
  if v4="$(cloudflare_list ips-v4)" && v6="$(cloudflare_list ips-v6)"; then
    list="$v4 $v6"
  elif [[ -n "$(get HAMNIVO_TRUSTED_PROXIES)" ]]; then
    log "Could not fetch Cloudflare's address ranges; keeping the ones from before"
    return 0
  else
    log "Could not fetch Cloudflare's address ranges; using the ones this version knows"
    list="$(printf '%s' "$cloudflare_ranges" | tr '\n' ' ')"
  fi
  [[ "$list" == "$(get HAMNIVO_TRUSTED_PROXIES)" ]] || set_kv HAMNIVO_TRUSTED_PROXIES "$list"
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

# How many packages are built and tested at once. Builds share the server with the live services,
# so this bounds their memory: lower it (1) on small servers, raise it on big ones.
concurrency() { setting HAMNIVO_BUILD_CONCURRENCY 2; }

# The webhook receiver; the month in a build argument reinstalls its package with Debian's fixes.
build_hook() {
  log 'Building the deploy webhook receiver'
  docker_build --target deploy-hook --build-arg "HAMNIVO_APT_REFRESH=$(date -u +%Y-%m)" \
    -t hamnivo/deploy-hook:local
}

build_images() {
  local tag="${1:-$(image_tag)}" release
  release="$(release_of)"
  log 'Building the gateway image (the first build takes several minutes)'
  docker_build --target gateway --build-arg "HAMNIVO_RELEASE=$release" \
    --build-arg "HAMNIVO_BUILD_CONCURRENCY=$(concurrency)" -t "hamnivo/gateway:$tag"
  log 'Building the edge image (static apps and HTTPS)'
  docker_build --target edge --build-arg "HAMNIVO_RELEASE=$release" \
    --build-arg "HAMNIVO_BUILD_CONCURRENCY=$(concurrency)" \
    --build-arg "HAMNIVO_API_ORIGIN=$(get HAMNIVO_API_ORIGIN)" \
    --build-arg "HAMNIVO_CHAT_ORIGIN=$(get HAMNIVO_CHAT_ORIGIN)" \
    --build-arg "HAMNIVO_SITE_URL=$(get HAMNIVO_SITE_ORIGIN)" \
    --build-arg "HAMNIVO_DEMO_WIDGET_ID=$(get HAMNIVO_DEMO_WIDGET_ID)" \
    -t "hamnivo/edge:$tag"
  if [[ "$(get HAMNIVO_AUTODEPLOY)" == webhook ]]; then
    build_hook
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
        build_hook
        return 0
        ;;
      *) fail "Unknown build option: $1" ;;
    esac
  done
  if ((verify == 1)); then
    log 'Checking the code: Biome, type checks and unit tests'
    docker_build --target verify --build-arg "HAMNIVO_BUILD_CONCURRENCY=$(concurrency)" \
      -t hamnivo/verify:last
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
  local no_build=()
  if ((build == 1)); then
    build_images
  else
    # Only images already on this server: a missing one fails here instead of being built.
    no_build=(--no-build)
  fi
  # The webhook receiver's folder, made by this user (Docker would make it as root). When this is
  # root, the receiver runs as nobody (autodeploy enable), so the folder belongs to nobody.
  mkdir -p "$state_dir/requests"
  if ((EUID == 0)) && [[ "$(get HAMNIVO_DEPLOY_UID)" == 65534 ]]; then
    chown 65534:65534 "$state_dir/requests"
  fi
  refresh_trusted_proxies
  log "Starting the services (images: $(image_tag))"
  "${compose[@]}" up -d --remove-orphans "${no_build[@]}" >&2
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
  if [[ -z "$(get SMTP_URL)" ]]; then
    cat >&2 <<EOF

Email is not set up (SMTP_URL in $env_file), so no email leaves this server. The link that
confirms your account is in the API log instead: $0 mail
EOF
  fi
}

# Without SMTP_URL, the API writes each email to its log instead of sending it: account
# confirmations, invitations and password resets. Prints the latest three, to ADDRESS if given.
cmd_mail() {
  need_env
  local to="${1:-}" found
  if [[ -n "$(get SMTP_URL)" ]]; then
    log 'SMTP_URL is set, so emails are sent, not written to the log. Failures to send are in: logs api'
  fi
  found="$("${compose[@]}" logs --no-log-prefix api 2>/dev/null | TO="$to" awk '
    /^\[mail\] to=/ {
      keep = ENVIRON["TO"] == "" || index($0, "[mail] to=" ENVIRON["TO"] " ") == 1
      if (keep) { n++; mail[n] = $0 }
      next
    }
    keep && (/^[{]/ || /^\[Nest\]/) { keep = 0 }
    keep { mail[n] = mail[n] "\n" $0 }
    END { for (i = (n > 3 ? n - 2 : 1); i <= n; i++) printf "%s\n\n", mail[i] }')"
  [[ -n "$found" ]] || fail "No emails${to:+ to $to} in the API log since it last started."
  printf '%s\n' "$found"
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

# --- restores keep customers' newer privacy decisions --------------------------------------------
# Consent to memory, memory deletion receipts and their tombstones, and customers' export and
# erasure requests with the erasures' tombstones (A10), are never removed, so the current database
# has every such row a backup has, plus those made since. A restore saves them before it replaces
# the database, adds them to the restored one and replays the tombstones before anything starts:
# restoring an older backup never brings back memory a customer asked to forget, consent they
# withdrew, nor a customer who was erased. Saved rows wait in state/restore/ until the databases are switched,
# so an interrupted restore picks them up again. A table added here must never lose rows, and gets
# its parents' check in carry_privacy.
privacy_tables='learning_consents memory_deletions deletion_tombstones privacy_requests erasure_tombstones'

db_psql() { # db_psql DATABASE [PSQL_ARGS...]: psql in the Hamnivo database server, as superuser
  "${compose[@]}" exec -T hamnivo-db psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$@"
}

# Saves the current database's privacy rows (table and row as JSON, in CSV). Nothing to save on a
# new server.
save_privacy() {
  local found tables t query='' file
  found="$(db_psql postgres -At -c "select 1 from pg_database where datname = 'hamnivo'")" || return 1
  [[ "$found" == 1 ]] || return 0
  tables="$(db_psql hamnivo -At -c "select string_agg(t, ' ') from unnest(string_to_array('$privacy_tables', ' ')) as t where to_regclass('public.' || t) is not null")" || return 1
  for t in $tables; do
    query+="${query:+ union all }select '$t', to_jsonb(r) from public.$t as r"
  done
  [[ -n "$query" ]] || return 0
  mkdir -p "$state_dir/restore"
  file="$state_dir/restore/carry-$(date -u +%Y%m%dT%H%M%SZ)-$$.csv"
  if ! (umask 077 && db_psql hamnivo -c "copy ($query) to stdout (format csv)" >"$file.part"); then
    rm -f "$file.part"
    return 1
  fi
  mv -f "$file.part" "$file"
}

# In one transaction: adds the saved rows to DATABASE, except rows it has and rows whose brand,
# customer or deletion it lacks; queues the deletions still running, so that the worker finishes
# them; and replays every tombstone.
carry_privacy() { # carry_privacy DATABASE
  local file
  {
    printf '%s\n' 'begin;' 'create temp table carry (tbl text not null, j jsonb not null) on commit drop;'
    for file in "$state_dir"/restore/carry-*.csv; do
      [[ -f "$file" ]] || continue
      printf '%s\n' 'copy carry from stdin (format csv);'
      cat "$file"
      printf '%s\n' '\.'
    done
    cat <<'SQL'
do $carry$
declare
  target text;
  parents text;
  cols text;
  vals text;
  n bigint;
begin
  for target, parents in select * from (values
    ('learning_consents', 'exists (select from public.brands as b where b.tenant_id = r.tenant_id and b.id = r.brand_id)
       and exists (select from public.customer_principals as p where p.tenant_id = r.tenant_id and p.id = r.subject_id)'),
    ('memory_deletions', 'exists (select from public.brands as b where b.tenant_id = r.tenant_id and b.id = r.brand_id)'),
    ('deletion_tombstones', 'exists (select from public.memory_deletions as d where d.tenant_id = r.tenant_id and d.id = r.deletion_id)'),
    ('privacy_requests', 'exists (select from public.brands as b where b.tenant_id = r.tenant_id and b.id = r.brand_id)'),
    ('erasure_tombstones', 'exists (select from public.privacy_requests as q where q.tenant_id = r.tenant_id and q.id = r.request_id)')
  ) as v (t, p) loop
    continue when to_regclass('public.' || target) is null;
    -- The columns the saved rows have: a column added since takes its default.
    select string_agg(format('%I', a.attname), ', ' order by a.attnum),
           string_agg(format('r.%I', a.attname), ', ' order by a.attnum)
      into cols, vals
    from pg_attribute as a
    where a.attrelid = to_regclass('public.' || target) and a.attnum > 0 and not a.attisdropped
      and exists (select from carry as c where c.tbl = target and c.j ? a.attname);
    continue when cols is null;
    execute format('insert into public.%1$I (%2$s) select %3$s
      from (select j from carry where tbl = %1$L) as c
      cross join lateral jsonb_populate_record(null::public.%1$I, c.j) as r
      where %4$s on conflict do nothing', target, cols, vals, parents);
    get diagnostics n = row_count;
    raise notice '% % carried over', n, target;
  end loop;
  if to_regclass('public.memory_deletions') is not null then
    -- The worker purges caches, verifies and completes the receipt (apps/gateway/src/memory/
    -- deletion.service.ts, topic memory.deleted).
    insert into public.outbox_events (id, tenant_id, topic, aggregate_type, aggregate_id, payload)
    select gen_random_uuid(), d.tenant_id, 'memory.deleted', 'memory_deletion', d.id::text,
      jsonb_build_object('deletionId', d.id)
    from public.memory_deletions as d
    where d.status = 'pending'
      and not exists (select from public.outbox_events as o where o.tenant_id = d.tenant_id
        and o.topic = 'memory.deleted' and o.aggregate_id = d.id::text and o.processed_at is null);
  end if;
  if to_regprocedure('app.apply_memory_tombstones()') is not null then
    n := app.apply_memory_tombstones();
    raise notice '% deleted memory records removed again', n;
  end if;
  if to_regclass('public.privacy_requests') is not null then
    -- Exports and erasures that had not finished go on once the worker starts.
    insert into public.outbox_events (id, tenant_id, topic, aggregate_type, aggregate_id, payload)
    select gen_random_uuid(), q.tenant_id, 'privacy.' || q.kind, 'privacy_request', q.id::text,
      jsonb_build_object('requestId', q.id)
    from public.privacy_requests as q
    where q.state in ('queued', 'running')
      and not exists (select from public.outbox_events as o where o.tenant_id = q.tenant_id
        and o.topic = 'privacy.' || q.kind and o.aggregate_id = q.id::text and o.processed_at is null);
  end if;
  if to_regprocedure('app.apply_erasure_tombstones()') is not null then
    -- Customers erased since the backup are erased again; the worker checks Chatwoot for them.
    n := app.apply_erasure_tombstones();
    raise notice '% erased customers erased again', n;
  end if;
end
$carry$;
commit;
SQL
  } | db_psql "$1"
}

# A restore that fails before the databases are switched has replaced nothing: start the
# applications it stopped, so the server does not stay down. Runs on exit (see cmd_restore).
# shellcheck disable=SC2317 # called by the EXIT trap
restart_unchanged() {
  local status=$?
  ((status == 0)) && return 0
  log 'The restore failed before replacing anything. Starting the current version again.'
  "${compose[@]}" up -d >&2 || log "Could not start it: run $0 up --no-build"
  return "$status"
}

cmd_restore() {
  need_docker
  local dir='' yes=0 answer='' current=1
  while (($#)); do
    case "$1" in
      --yes) yes=1; shift ;;
      --ignore-current-database) current=0; shift ;;
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
  # A backup restored on another server names images that were never built there.
  if ! docker image inspect "hamnivo/gateway:$(image_tag)" "hamnivo/edge:$(image_tag)" >/dev/null 2>&1; then
    log "The images of $(image_tag) are not on this server; building this checkout's version instead"
    set_kv HAMNIVO_IMAGE_TAG local
    build_images local
  fi
  mkdir -p "$state_dir/requests"
  log 'Stopping the applications'
  trap restart_unchanged EXIT
  "${compose[@]}" stop api worker edge chatwoot-web chatwoot-sidekiq >&2 2>/dev/null || true
  "${compose[@]}" up -d hamnivo-db chatwoot-db >&2
  wait_healthy hamnivo-db chatwoot-db

  if ((current == 1)); then
    log 'Saving consent and memory deletions from the current database'
    save_privacy || fail "Could not read consent and memory deletions from the current database. \
Without them, memory that customers asked to forget since the backup would come back. Nothing \
was changed. Repair the database, or add --ignore-current-database to restore without them."
  fi

  # Restored beside the current database, which stays untouched until the restored one is ready.
  log 'Restoring the Hamnivo database'
  "${compose[@]}" exec -T hamnivo-db dropdb -U postgres --if-exists --force hamnivo_restore
  HAMNIVO_DATABASES=hamnivo_restore "${compose[@]}" run --rm -e HAMNIVO_DATABASES db-init >&2
  "${compose[@]}" exec -T hamnivo-db pg_restore -U postgres -d hamnivo_restore --exit-on-error \
    --single-transaction <"$dir/hamnivo.dump"
  DATABASE_OWNER_URL="postgres://hamnivo_owner:$(get HAMNIVO_DB_OWNER_PASSWORD)@hamnivo-db:5432/hamnivo_restore" \
    "${compose[@]}" run --rm --no-deps -T -e DATABASE_OWNER_URL migrate >&2
  log 'Adding consent and memory deletions made since the backup'
  carry_privacy hamnivo_restore
  "${compose[@]}" exec -T hamnivo-db dropdb -U postgres --if-exists --force hamnivo
  db_psql postgres -c 'alter database hamnivo_restore rename to hamnivo'
  trap - EXIT
  rm -f "$state_dir"/restore/carry-*.csv

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
    mail) cmd_mail "$@" ;;
    backup) cmd_backup "$@" ;;
    restore) cmd_restore "$@" ;;
    build) cmd_build "$@" ;;
    update) exec bash "$here/deploy.sh" deploy --latest --trigger manual "$@" ;;
    deploy | rollback | deploys | autodeploy) exec bash "$here/deploy.sh" "$command" "$@" ;;
    doctor) exec bash "$here/doctor.sh" "$@" ;;
    down) need_env; "${compose[@]}" down ;;
    compose) need_env; "${compose[@]}" "$@" ;;
    help | -h | --help) awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0" ;;
    *) fail "Unknown command: $command (try: $0 help)" ;;
  esac
}

# One line, so bash has read it completely before `update` replaces this file.
main "$@"; exit
