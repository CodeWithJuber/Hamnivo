#!/usr/bin/env bash
# Creates Hamnivo roles/databases on a CI PostgreSQL service (superuser credentials via PG* env vars).
set -euo pipefail
psql -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE ROLE hamnivo_owner LOGIN CREATEDB PASSWORD 'hamnivo_owner_dev';
CREATE ROLE hamnivo_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'hamnivo_app_dev';
CREATE ROLE hamnivo_platform LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'hamnivo_platform_dev';
GRANT hamnivo_app TO hamnivo_owner;
GRANT hamnivo_platform TO hamnivo_owner;
CREATE DATABASE hamnivo OWNER hamnivo_owner;
CREATE DATABASE hamnivo_test OWNER hamnivo_owner;
SQL
for db in hamnivo hamnivo_test; do
  psql -v ON_ERROR_STOP=1 -q -d "$db" <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
GRANT CONNECT ON DATABASE $db TO hamnivo_app, hamnivo_platform;
SQL
done
