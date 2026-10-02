-- Commerce: forced RLS on the new tables; operation receipts are append-only; financial records
-- are never deleted by the application; a quote keeps its priced content once created; and the
-- narrow cross-tenant functions that the webhook intake and the commerce worker need.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON operation_receipts FROM hamnivo_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON operations, merchant_connections, quotes, purchase_intents, payments,
  orders, fulfillments, refunds, finance_exceptions, commerce_events FROM hamnivo_app;
--> statement-breakpoint
-- What a customer approves cannot change under them: only a quote's status moves.
CREATE FUNCTION app.quotes_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.document IS DISTINCT FROM OLD.document
    OR NEW.hash IS DISTINCT FROM OLD.hash
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
    OR NEW.discount_minor IS DISTINCT FROM OLD.discount_minor
    OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
    OR NEW.shipping_minor IS DISTINCT FROM OLD.shipping_minor
    OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.cart_id IS DISTINCT FROM OLD.cart_id
    OR NEW.cart_revision IS DISTINCT FROM OLD.cart_revision
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.merchant_connection_id IS DISTINCT FROM OLD.merchant_connection_id
    OR NEW.approver IS DISTINCT FROM OLD.approver THEN
    RAISE EXCEPTION 'quotes are immutable; create a new quote instead' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER quotes_guard BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION app.quotes_guard();
--> statement-breakpoint
-- ── Webhook intake: which tenant a merchant connection belongs to ────────────────────────────
GRANT SELECT (id, tenant_id, provider, status) ON merchant_connections TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.resolve_merchant_connection(p_connection_id uuid)
  RETURNS TABLE (tenant_id uuid, provider text, status text, tenant_status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT m.tenant_id, m.provider, m.status, t.status
    FROM public.merchant_connections AS m
    JOIN public.tenants AS t ON t.id = m.tenant_id
    WHERE m.id = p_connection_id
  $$;
--> statement-breakpoint
-- ── Worker: verified provider events, leased across tenants ─────────────────────────────────
GRANT SELECT (tenant_id, id, merchant_connection_id, processed_at, available_at, attempts),
  UPDATE (available_at, attempts)
  ON commerce_events TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.claim_commerce_events(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (tenant_id uuid, id uuid, merchant_connection_id uuid, attempts integer)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    WITH picked AS (
      SELECT e.tenant_id, e.id
      FROM public.commerce_events AS e
      WHERE e.processed_at IS NULL AND e.available_at <= now()
      ORDER BY e.available_at, e.id
      LIMIT least(greatest(p_limit, 1), 500)
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.commerce_events AS e
    SET available_at = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
        attempts = e.attempts + 1
    FROM picked
    WHERE e.tenant_id = picked.tenant_id AND e.id = picked.id
    RETURNING e.tenant_id, e.id, e.merchant_connection_id, e.attempts
  $$;
--> statement-breakpoint
-- ── Worker: outcomes still owed by a provider ───────────────────────────────────────────────
-- Operations whose answer was lost (dispatched too long, or unknown), payments and refunds that
-- have no final state yet. Leasing moves the next attempt forward, so a worker that dies
-- mid-call is retried later rather than blocking the row. Suspended tenants still reconcile:
-- money in flight is never left untracked.
GRANT SELECT (tenant_id, id, state, next_reconcile_at), UPDATE (next_reconcile_at)
  ON operations TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, next_sync_at), UPDATE (next_sync_at) ON payments TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, next_sync_at), UPDATE (next_sync_at) ON refunds TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.claim_commerce_work(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (tenant_id uuid, subject text, id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    WITH due_operations AS (
      SELECT o.tenant_id, o.id
      FROM public.operations AS o
      WHERE o.state IN ('dispatched', 'unknown') AND o.next_reconcile_at <= now()
      ORDER BY o.next_reconcile_at
      LIMIT least(greatest(p_limit, 1), 200)
      FOR UPDATE SKIP LOCKED
    ), leased_operations AS (
      UPDATE public.operations AS o
      SET next_reconcile_at = now() + make_interval(secs => greatest(p_lease_seconds, 1))
      FROM due_operations AS d
      WHERE o.tenant_id = d.tenant_id AND o.id = d.id
      RETURNING o.tenant_id, o.id
    ), due_payments AS (
      SELECT p.tenant_id, p.id
      FROM public.payments AS p
      WHERE p.next_sync_at <= now()
      ORDER BY p.next_sync_at
      LIMIT least(greatest(p_limit, 1), 200)
      FOR UPDATE SKIP LOCKED
    ), leased_payments AS (
      UPDATE public.payments AS p
      SET next_sync_at = now() + make_interval(secs => greatest(p_lease_seconds, 1))
      FROM due_payments AS d
      WHERE p.tenant_id = d.tenant_id AND p.id = d.id
      RETURNING p.tenant_id, p.id
    ), due_refunds AS (
      SELECT r.tenant_id, r.id
      FROM public.refunds AS r
      WHERE r.next_sync_at <= now()
      ORDER BY r.next_sync_at
      LIMIT least(greatest(p_limit, 1), 200)
      FOR UPDATE SKIP LOCKED
    ), leased_refunds AS (
      UPDATE public.refunds AS r
      SET next_sync_at = now() + make_interval(secs => greatest(p_lease_seconds, 1))
      FROM due_refunds AS d
      WHERE r.tenant_id = d.tenant_id AND r.id = d.id
      RETURNING r.tenant_id, r.id
    )
    SELECT l.tenant_id, 'operation'::text, l.id FROM leased_operations AS l
    UNION ALL
    SELECT l.tenant_id, 'payment'::text, l.id FROM leased_payments AS l
    UNION ALL
    SELECT l.tenant_id, 'refund'::text, l.id FROM leased_refunds AS l
  $$;
--> statement-breakpoint
DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.resolve_merchant_connection(uuid)',
    'app.claim_commerce_events(integer, integer)',
    'app.claim_commerce_work(integer, integer)'
  ]::regprocedure[] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO hamnivo_resolver', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hamnivo_app', fn);
  END LOOP;
END
$$;
