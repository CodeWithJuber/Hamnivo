-- Channel inboxes (ADR 0013): Hamnivo adopts the conversations Chatwoot creates on email, WhatsApp
-- and Telegram inboxes. Webhooks can be lost, so the worker also lists each channel inbox's recent
-- conversations; those inbox cursors are leased here across tenants, like conversation cursors.
-- Every Chatwoot account is checked for channel inboxes (scope_ref 'all') a minute after this
-- migration and every few minutes after. The owner is bound by forced row-level security, so the
-- tables are released for this statement and forced again below.
ALTER TABLE reconcile_cursors NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE authority_connections NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO reconcile_cursors (tenant_id, connection_id, scope, scope_ref, interval_seconds, next_poll_at)
SELECT a.tenant_id, a.id, 'inbox', 'all', 300, now() + interval '1 minute'
FROM authority_connections AS a
WHERE a.status <> 'disabled'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
SELECT app.harden_tenant_tables();
--> statement-breakpoint
CREATE FUNCTION app.claim_reconcile_inbox_cursors(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (
    tenant_id uuid,
    connection_id uuid,
    scope_ref text,
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
      WHERE r.scope = 'inbox' AND r.next_poll_at <= now()
      ORDER BY r.next_poll_at
      LIMIT least(greatest(p_limit, 1), 200)
      FOR UPDATE OF r SKIP LOCKED
    )
    UPDATE public.reconcile_cursors AS r
    SET next_poll_at = now() + make_interval(secs => greatest(p_lease_seconds, 1))
    FROM picked
    WHERE r.tenant_id = picked.tenant_id AND r.connection_id = picked.connection_id
      AND r.scope = picked.scope AND r.scope_ref = picked.scope_ref
    RETURNING r.tenant_id, r.connection_id, r.scope_ref, r.interval_seconds
  $$;
--> statement-breakpoint
ALTER FUNCTION app.claim_reconcile_inbox_cursors(integer, integer) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_reconcile_inbox_cursors(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.claim_reconcile_inbox_cursors(integer, integer) TO hamnivo_app;
