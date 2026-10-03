-- Custom SQL migration file, put your code below! --
-- Visitors, and the staff inbox's alert settings and read markers: forced RLS on the new tables,
-- like every tenant table, and one audited cross-tenant function that removes visitor data 30 days
-- after the visitor was last seen.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
GRANT SELECT (tenant_id, id, viewed_at), DELETE ON visitor_page_views TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, last_seen_at), DELETE ON visitor_sessions TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, last_seen_at), DELETE ON visitors TO hamnivo_resolver;
--> statement-breakpoint
-- Page views, visits and visitors not seen for 30 days are removed (per-table batch). Returns how
-- many of each were removed. Run by the worker's maintenance schedule.
CREATE FUNCTION app.purge_visitors(p_batch integer DEFAULT 5000)
  RETURNS TABLE (page_views_removed bigint, sessions_removed bigint, visitors_removed bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  lim integer := least(greatest(p_batch, 1), 50000);
BEGIN
  DELETE FROM public.visitor_page_views AS v
  USING (
    SELECT x.tenant_id, x.id FROM public.visitor_page_views AS x
    WHERE x.viewed_at < now() - interval '30 days' ORDER BY x.viewed_at LIMIT lim
  ) AS d
  WHERE v.tenant_id = d.tenant_id AND v.id = d.id;
  GET DIAGNOSTICS page_views_removed = ROW_COUNT;

  DELETE FROM public.visitor_sessions AS s
  USING (
    SELECT x.tenant_id, x.id FROM public.visitor_sessions AS x
    WHERE x.last_seen_at < now() - interval '30 days' ORDER BY x.last_seen_at LIMIT lim
  ) AS d
  WHERE s.tenant_id = d.tenant_id AND s.id = d.id;
  GET DIAGNOSTICS sessions_removed = ROW_COUNT;

  DELETE FROM public.visitors AS v
  USING (
    SELECT x.tenant_id, x.id FROM public.visitors AS x
    WHERE x.last_seen_at < now() - interval '30 days' ORDER BY x.last_seen_at LIMIT lim
  ) AS d
  WHERE v.tenant_id = d.tenant_id AND v.id = d.id;
  GET DIAGNOSTICS visitors_removed = ROW_COUNT;
  RETURN NEXT;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.purge_visitors(integer) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.purge_visitors(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.purge_visitors(integer) TO hamnivo_app;
