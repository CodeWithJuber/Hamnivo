-- Custom SQL migration file, put your code below! --
-- Blocked visitors (H20): forced RLS like every tenant table. A block is lifted, never deleted by
-- the application, so who blocked whom stays on record; a lifted or expired block is removed 90
-- days later by the worker's maintenance schedule.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
REVOKE DELETE ON visitor_blocks FROM hamnivo_app;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, expires_at, lifted_at), DELETE ON visitor_blocks TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.purge_visitor_blocks(p_batch integer DEFAULT 5000)
  RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  lim integer := least(greatest(p_batch, 1), 50000);
  removed bigint;
BEGIN
  DELETE FROM public.visitor_blocks AS v
  USING (
    SELECT x.tenant_id, x.id FROM public.visitor_blocks AS x
    WHERE coalesce(x.lifted_at, x.expires_at) < now() - interval '90 days'
    ORDER BY coalesce(x.lifted_at, x.expires_at) LIMIT lim
  ) AS d
  WHERE v.tenant_id = d.tenant_id AND v.id = d.id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.purge_visitor_blocks(integer) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.purge_visitor_blocks(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.purge_visitor_blocks(integer) TO hamnivo_app;
