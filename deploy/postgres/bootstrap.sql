-- Hamnivo cluster bootstrap: roles and databases. Runs as a PostgreSQL superuser and is idempotent.
-- Invoked by deploy/postgres/init.sh, which passes the psql variables below.
--   owner_password, app_password, platform_password  role passwords
--   databases                                        comma-separated database names
--
-- Roles
--   hamnivo_owner     owns the schema and runs migrations; no BYPASSRLS, so FORCE'd policies apply to it
--   hamnivo_app       the gateway and worker; no superuser, no BYPASSRLS, owns nothing
--   hamnivo_platform  platform console metadata reads only
--   hamnivo_resolver  NOLOGIN, BYPASSRLS; owns only the SECURITY DEFINER lookup/maintenance functions

SELECT format('CREATE ROLE hamnivo_owner LOGIN PASSWORD %L', :'owner_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hamnivo_owner') \gexec
SELECT format('CREATE ROLE hamnivo_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hamnivo_app') \gexec
SELECT format('CREATE ROLE hamnivo_platform LOGIN PASSWORD %L', :'platform_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hamnivo_platform') \gexec
SELECT 'CREATE ROLE hamnivo_resolver NOLOGIN BYPASSRLS'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hamnivo_resolver') \gexec

-- Re-assert attributes and passwords on every run so a drifted role is corrected.
ALTER ROLE hamnivo_owner LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOBYPASSRLS NOREPLICATION;
ALTER ROLE hamnivo_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
ALTER ROLE hamnivo_platform LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
ALTER ROLE hamnivo_resolver NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS NOREPLICATION;
SELECT format('ALTER ROLE hamnivo_owner PASSWORD %L', :'owner_password') \gexec
SELECT format('ALTER ROLE hamnivo_app PASSWORD %L', :'app_password') \gexec
SELECT format('ALTER ROLE hamnivo_platform PASSWORD %L', :'platform_password') \gexec

-- The owner hands function ownership to hamnivo_resolver and uses SET ROLE in tests.
GRANT hamnivo_app, hamnivo_platform, hamnivo_resolver TO hamnivo_owner;

SELECT format('CREATE DATABASE %I OWNER hamnivo_owner', d)
FROM unnest(string_to_array(:'databases', ',')) AS d
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = d) \gexec
