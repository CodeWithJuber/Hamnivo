-- Authority runtime. The worker leases verified webhook events across tenants and then processes
-- each one inside withTenant(). Maintenance also purges processed events after seven days. The
-- journal key now includes the lane, so the purge matches on it.
GRANT SELECT (tenant_id, id, connection_id, processed_at, available_at, attempts),
  UPDATE (available_at, attempts), DELETE
  ON integration_inbox TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.claim_integration_inbox(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (tenant_id uuid, id uuid, connection_id uuid, attempts integer)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    WITH picked AS (
      SELECT i.tenant_id, i.id
      FROM public.integration_inbox AS i
      WHERE i.processed_at IS NULL AND i.available_at <= now()
      ORDER BY i.available_at, i.id
      LIMIT least(greatest(p_limit, 1), 500)
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.integration_inbox AS i
    SET available_at = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
        attempts = i.attempts + 1
    FROM picked
    WHERE i.tenant_id = picked.tenant_id AND i.id = picked.id
    RETURNING i.tenant_id, i.id, i.connection_id, i.attempts
  $$;
--> statement-breakpoint
ALTER FUNCTION app.claim_integration_inbox(integer, integer) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_integration_inbox(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.claim_integration_inbox(integer, integer) TO hamnivo_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.purge_expired(p_batch integer DEFAULT 5000)
  RETURNS TABLE (relation text, deleted bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  lim integer := least(greatest(p_batch, 1), 50000);
  n bigint;
BEGIN
  DELETE FROM public.conversation_journal AS j
  USING (
    SELECT x.tenant_id, x.conversation_id, x.lane, x.seq FROM public.conversation_journal AS x
    WHERE x.expires_at < now() ORDER BY x.expires_at LIMIT lim
  ) AS d
  WHERE j.tenant_id = d.tenant_id AND j.conversation_id = d.conversation_id
    AND j.lane = d.lane AND j.seq = d.seq;
  GET DIAGNOSTICS n = ROW_COUNT;
  relation := 'conversation_journal'; deleted := n; RETURN NEXT;

  DELETE FROM public.identity_nonces AS j
  USING (
    SELECT x.tenant_id, x.brand_id, x.jti FROM public.identity_nonces AS x
    WHERE x.expires_at < now() ORDER BY x.expires_at LIMIT lim
  ) AS d
  WHERE j.tenant_id = d.tenant_id AND j.brand_id = d.brand_id AND j.jti = d.jti;
  GET DIAGNOSTICS n = ROW_COUNT;
  relation := 'identity_nonces'; deleted := n; RETURN NEXT;

  DELETE FROM public.idempotency_keys AS j
  USING (
    SELECT x.tenant_id, x.scope, x.key FROM public.idempotency_keys AS x
    WHERE x.expires_at < now() ORDER BY x.expires_at LIMIT lim
  ) AS d
  WHERE j.tenant_id = d.tenant_id AND j.scope = d.scope AND j.key = d.key;
  GET DIAGNOSTICS n = ROW_COUNT;
  relation := 'idempotency_keys'; deleted := n; RETURN NEXT;

  DELETE FROM public.integration_inbox AS j
  USING (
    SELECT x.tenant_id, x.id FROM public.integration_inbox AS x
    WHERE x.processed_at < now() - interval '7 days' ORDER BY x.processed_at LIMIT lim
  ) AS d
  WHERE j.tenant_id = d.tenant_id AND j.id = d.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  relation := 'integration_inbox'; deleted := n; RETURN NEXT;
END
$$;
