-- Customer surface (W02, W05, W06, W09, W17, W19, W23, W25): forced RLS on the new tables; the
-- record of emails sent to customers is append-only; and one audited cross-tenant function that
-- clears quarantined upload bytes once they expire.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON customer_notifications FROM hamnivo_app;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, status, content, expires_at, created_at), UPDATE (status, content), DELETE
  ON widget_uploads TO hamnivo_resolver;
--> statement-breakpoint
-- Files never sent within their time in quarantine lose their bytes; rows of files that were sent,
-- refused or expired are removed after 30 days. Returns how many uploads expired and were removed.
CREATE FUNCTION app.purge_widget_uploads(p_batch integer DEFAULT 1000)
  RETURNS TABLE (expired bigint, removed bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  lim integer := least(greatest(p_batch, 1), 10000);
BEGIN
  UPDATE public.widget_uploads AS u
  SET status = 'expired', content = NULL
  FROM (
    SELECT x.tenant_id, x.id FROM public.widget_uploads AS x
    WHERE x.content IS NOT NULL AND x.expires_at < now()
    ORDER BY x.expires_at LIMIT lim
  ) AS d
  WHERE u.tenant_id = d.tenant_id AND u.id = d.id;
  GET DIAGNOSTICS expired = ROW_COUNT;

  DELETE FROM public.widget_uploads AS u
  USING (
    SELECT x.tenant_id, x.id FROM public.widget_uploads AS x
    WHERE x.content IS NULL AND x.created_at < now() - interval '30 days'
    ORDER BY x.created_at LIMIT lim
  ) AS d
  WHERE u.tenant_id = d.tenant_id AND u.id = d.id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN NEXT;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.purge_widget_uploads(integer) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.purge_widget_uploads(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.purge_widget_uploads(integer) TO hamnivo_app;
