#!/usr/bin/env bash
# Creates Hamnivo roles, databases and extensions. Run as a PostgreSQL superuser; idempotent.
# Used as a docker-entrypoint-initdb.d script (deploy/compose/services.yml), by scripts/dev/up.sh
# and by scripts/ci/local.sh.
#
# Required: HAMNIVO_DB_OWNER_PASSWORD, HAMNIVO_DB_APP_PASSWORD, HAMNIVO_DB_PLATFORM_PASSWORD
# Optional: HAMNIVO_DATABASES (default "hamnivo,hamnivo_test"), HAMNIVO_DB_SQL_DIR (default: this
#           script's directory), and the usual PG* variables for the superuser connection.
set -euo pipefail

sql_dir="${HAMNIVO_DB_SQL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
databases="${HAMNIVO_DATABASES:-hamnivo,hamnivo_test}"
: "${HAMNIVO_DB_OWNER_PASSWORD:?HAMNIVO_DB_OWNER_PASSWORD is required}"
: "${HAMNIVO_DB_APP_PASSWORD:?HAMNIVO_DB_APP_PASSWORD is required}"
: "${HAMNIVO_DB_PLATFORM_PASSWORD:?HAMNIVO_DB_PLATFORM_PASSWORD is required}"
export PGUSER="${PGUSER:-${POSTGRES_USER:-postgres}}"
export PGOPTIONS="${PGOPTIONS:--c client_min_messages=warning}"

psql_base=(psql -v ON_ERROR_STOP=1 -q -X)

"${psql_base[@]}" -d postgres \
  -v owner_password="$HAMNIVO_DB_OWNER_PASSWORD" \
  -v app_password="$HAMNIVO_DB_APP_PASSWORD" \
  -v platform_password="$HAMNIVO_DB_PLATFORM_PASSWORD" \
  -v databases="$databases" \
  -f "$sql_dir/bootstrap.sql"

IFS=',' read -ra dbs <<<"$databases"
for db in "${dbs[@]}"; do
  "${psql_base[@]}" -d "$db" -v dbname="$db" -f "$sql_dir/bootstrap-database.sql"
done
echo "[hamnivo] database roles and databases ready: $databases"
