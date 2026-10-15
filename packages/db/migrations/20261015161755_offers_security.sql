-- Hand-off offers (HNV-10-03, HNV-10-06): forced RLS like every tenant table. An offer is never
-- deleted by the application, so who was offered what and how it ended stays on record; offers that
-- ended more than 90 days ago are removed by the worker's maintenance schedule.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON conversation_offers FROM hamnivo_app;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, decided_at), DELETE ON conversation_offers TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.purge_conversation_offers(p_batch integer DEFAULT 5000)
  RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  lim integer := least(greatest(p_batch, 1), 50000);
  removed bigint;
BEGIN
  DELETE FROM public.conversation_offers AS o
  USING (
    SELECT x.tenant_id, x.id FROM public.conversation_offers AS x
    WHERE x.decided_at < now() - interval '90 days'
    ORDER BY x.decided_at LIMIT lim
  ) AS d
  WHERE o.tenant_id = d.tenant_id AND o.id = d.id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.purge_conversation_offers(integer) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.purge_conversation_offers(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.purge_conversation_offers(integer) TO hamnivo_app;
