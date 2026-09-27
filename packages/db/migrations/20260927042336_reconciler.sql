-- Reconciler (M10). Chatwoot does not retry most webhooks, so they only reduce latency: the worker
-- polls Chatwoot for each conversation Hamnivo follows and applies whatever the webhooks missed.
-- Cursors are claimed across tenants here, then processed inside withTenant().
GRANT SELECT (tenant_id, connection_id, scope, scope_ref, last_external_id, interval_seconds, next_poll_at),
  INSERT (tenant_id, connection_id, scope, scope_ref, last_external_id, interval_seconds, next_poll_at),
  UPDATE (next_poll_at)
  ON reconcile_cursors TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, connection_id, external_conversation_id, authority_status)
  ON conversation_controls TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, status) ON authority_connections TO hamnivo_resolver;
--> statement-breakpoint
-- Follows open conversations that have no cursor yet (those from before the reconciler existed).
-- Polling starts after the newest message already journaled; without one, the reconciler takes a
-- baseline instead of replaying history.
CREATE FUNCTION app.ensure_reconcile_cursors()
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO public.reconcile_cursors AS r
    (tenant_id, connection_id, scope, scope_ref, last_external_id, interval_seconds, next_poll_at)
  SELECT c.tenant_id, c.connection_id, 'conversation', c.external_conversation_id::text,
    (SELECT max(j.authority_id) FROM public.conversation_journal AS j
      WHERE j.tenant_id = c.tenant_id AND j.conversation_id = c.id),
    30, now()
  FROM public.conversation_controls AS c
  WHERE c.authority_status <> 'resolved'
    AND NOT EXISTS (
      SELECT 1 FROM public.reconcile_cursors AS x
      WHERE x.tenant_id = c.tenant_id AND x.connection_id = c.connection_id
        AND x.scope = 'conversation' AND x.scope_ref = c.external_conversation_id::text
    )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.ensure_reconcile_cursors() OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ensure_reconcile_cursors() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ensure_reconcile_cursors() TO hamnivo_app;
--> statement-breakpoint
-- Leases due conversation cursors of active tenants and connections. The lease moves the next poll
-- forward, so a worker that dies mid-poll is retried later instead of blocking the cursor.
CREATE FUNCTION app.claim_reconcile_cursors(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (
    tenant_id uuid,
    connection_id uuid,
    scope_ref text,
    last_external_id bigint,
    interval_seconds integer
  )
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    WITH picked AS (
      SELECT r.tenant_id, r.connection_id, r.scope, r.scope_ref
      FROM public.reconcile_cursors AS r
      JOIN public.authority_connections AS a
        ON a.tenant_id = r.tenant_id AND a.id = r.connection_id AND a.status IN ('active', 'degraded')
      JOIN public.tenants AS t ON t.id = r.tenant_id AND t.status = 'active'
      WHERE r.scope = 'conversation' AND r.next_poll_at <= now()
      ORDER BY r.next_poll_at
      LIMIT least(greatest(p_limit, 1), 200)
      FOR UPDATE OF r SKIP LOCKED
    )
    UPDATE public.reconcile_cursors AS r
    SET next_poll_at = now() + make_interval(secs => greatest(p_lease_seconds, 1))
    FROM picked
    WHERE r.tenant_id = picked.tenant_id AND r.connection_id = picked.connection_id
      AND r.scope = picked.scope AND r.scope_ref = picked.scope_ref
    RETURNING r.tenant_id, r.connection_id, r.scope_ref, r.last_external_id, r.interval_seconds
  $$;
--> statement-breakpoint
ALTER FUNCTION app.claim_reconcile_cursors(integer, integer) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_reconcile_cursors(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.claim_reconcile_cursors(integer, integer) TO hamnivo_app;
--> statement-breakpoint
SELECT app.ensure_reconcile_cursors();
