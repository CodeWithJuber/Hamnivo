-- Custom SQL migration file, put your code below! --
-- AI power tools: forced RLS on the new tables; custom HTTP tool definitions are never deleted by
-- the application (a tool is turned off, like every tool); and the narrow cross-tenant function
-- the worker uses to find website sources whose next sync is due, or whose last run stopped
-- before it finished.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
-- The application role only ever holds SELECT, INSERT, UPDATE and DELETE (the default privileges
-- in the foundations migration), so DELETE is the right taken back here.
REVOKE DELETE ON http_tool_sources, http_tool_endpoints FROM hamnivo_app;
--> statement-breakpoint
-- ── Worker: website sources that are due ────────────────────────────────────────────────────
GRANT SELECT (tenant_id, id, schedule, state, next_run_at, lease_until)
  ON knowledge_web_sources TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.due_web_syncs(p_limit integer, p_now timestamptz)
  RETURNS TABLE (tenant_id uuid, id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT w.tenant_id, w.id
    FROM public.knowledge_web_sources AS w
    WHERE (w.state = 'idle' AND w.schedule <> 'manual'
           AND w.next_run_at <= coalesce(p_now, now()))
       OR (w.state IN ('queued', 'running')
           AND w.lease_until IS NOT NULL AND w.lease_until <= coalesce(p_now, now()))
    ORDER BY coalesce(w.next_run_at, w.lease_until)
    LIMIT least(greatest(p_limit, 1), 100)
  $$;
--> statement-breakpoint
DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOREACH fn IN ARRAY ARRAY['app.due_web_syncs(integer, timestamptz)']::regprocedure[] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO hamnivo_resolver', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hamnivo_app', fn);
  END LOOP;
END
$$;
