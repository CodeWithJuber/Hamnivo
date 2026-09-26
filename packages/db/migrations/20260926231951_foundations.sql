-- Foundations: prerequisites, the `app` helper schema, tenant context functions and default
-- privileges. Runs as hamnivo_owner; roles and extensions come from deploy/postgres/init.sh.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(e, ', ') INTO missing
  FROM unnest(ARRAY['vector', 'pgcrypto', 'pg_trgm', 'citext']) AS e
  WHERE NOT EXISTS (SELECT FROM pg_extension WHERE extname = e);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Missing PostgreSQL extensions: % (run deploy/postgres/init.sh as a superuser)', missing;
  END IF;

  SELECT string_agg(r, ', ') INTO missing
  FROM unnest(ARRAY['hamnivo_app', 'hamnivo_platform', 'hamnivo_resolver']) AS r
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Missing database roles: % (run deploy/postgres/init.sh as a superuser)', missing;
  END IF;

  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'hamnivo_app' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'hamnivo_app must not be a superuser or bypass row-level security';
  END IF;
END
$$;
--> statement-breakpoint
CREATE SCHEMA app;
--> statement-breakpoint
REVOKE ALL ON SCHEMA app FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO hamnivo_app, hamnivo_platform, hamnivo_resolver;
--> statement-breakpoint
-- Functions stay private unless granted explicitly.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint
-- Tables and sequences created from here on are usable by the application role; row-level
-- security decides which rows it sees. Exceptions are revoked explicitly (audit, partitions).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hamnivo_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hamnivo_app;
--> statement-breakpoint
-- The tenant of the current transaction, set by withTenant() with set_config(..., true).
-- NULLIF: after a transaction-local setting ends, the value reads as '' rather than NULL.
CREATE FUNCTION app.current_tenant() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app.current_actor() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.actor_id', true), '') $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_tenant(), app.current_actor()
  TO hamnivo_app, hamnivo_platform, hamnivo_resolver;
--> statement-breakpoint
-- Applies FORCE ROW LEVEL SECURITY to every RLS-enabled table (so the owner is bound by the
-- policies too) and removes direct access to partitions, whose parent carries the policies.
-- Every migration that adds tables ends with: SELECT app.harden_tenant_tables();
CREATE FUNCTION app.harden_tenant_tables() RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND c.relrowsecurity AND NOT c.relforcerowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', r.tbl);
  END LOOP;

  FOR r IN
    SELECT c.oid::regclass AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relispartition
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM hamnivo_app, hamnivo_platform, hamnivo_resolver', r.tbl);
  END LOOP;
END
$$;
