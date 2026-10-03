-- Migration (M01–M08): forced RLS on the new tables. Hamnivo keeps job state here; imported
-- conversations live in Chatwoot. An uploaded export stays in migration_files.raw only while its job
-- needs it: the worker clears it once purge_after has passed (retention), across tenants, here.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
GRANT SELECT (tenant_id, id, raw, purge_after), UPDATE (raw, state, purged_at)
  ON migration_files TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.purge_migration_files(p_batch integer DEFAULT 100)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.migration_files AS f
  SET raw = NULL, state = 'purged', purged_at = now()
  FROM (
    SELECT x.tenant_id, x.id FROM public.migration_files AS x
    WHERE x.raw IS NOT NULL AND x.purge_after IS NOT NULL AND x.purge_after < now()
    ORDER BY x.purge_after
    LIMIT least(greatest(p_batch, 1), 1000)
  ) AS d
  WHERE f.tenant_id = d.tenant_id AND f.id = d.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.purge_migration_files(integer) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.purge_migration_files(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.purge_migration_files(integer) TO hamnivo_app;
