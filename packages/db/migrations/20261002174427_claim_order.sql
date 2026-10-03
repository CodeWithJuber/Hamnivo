-- Leased events come back in the order they were picked: oldest due first, then by id (UUIDv7, so
-- the order they were recorded in). UPDATE ... RETURNING alone promises no order: with a hash
-- join it returns rows in their physical order, and the worker would then handle, say, a
-- conversation's routing before the customer message that came first. Same signatures, owners
-- and grants; only the result order changes.
CREATE OR REPLACE FUNCTION app.claim_outbox(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (
    tenant_id uuid, id uuid, topic text, aggregate_type text, aggregate_id text, payload jsonb,
    headers jsonb, attempts integer, created_at timestamptz)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    WITH picked AS (
      SELECT o.tenant_id, o.id, o.available_at
      FROM public.outbox_events AS o
      WHERE o.processed_at IS NULL
        AND o.available_at <= now()
        AND (o.locked_until IS NULL OR o.locked_until < now())
      ORDER BY o.available_at, o.id
      LIMIT least(greatest(p_limit, 1), 500)
      FOR UPDATE SKIP LOCKED
    ), leased AS (
      UPDATE public.outbox_events AS o
      SET locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
          attempts = o.attempts + 1
      FROM picked
      WHERE o.tenant_id = picked.tenant_id AND o.id = picked.id
      RETURNING o.tenant_id, o.id, o.topic, o.aggregate_type, o.aggregate_id, o.payload, o.headers,
                o.attempts, o.created_at, picked.available_at AS picked_at
    )
    SELECT l.tenant_id, l.id, l.topic, l.aggregate_type, l.aggregate_id, l.payload, l.headers,
           l.attempts, l.created_at
    FROM leased AS l
    ORDER BY l.picked_at, l.id
  $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.claim_integration_inbox(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (tenant_id uuid, id uuid, connection_id uuid, attempts integer)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    WITH picked AS (
      SELECT i.tenant_id, i.id, i.available_at
      FROM public.integration_inbox AS i
      WHERE i.processed_at IS NULL AND i.available_at <= now()
      ORDER BY i.available_at, i.id
      LIMIT least(greatest(p_limit, 1), 500)
      FOR UPDATE SKIP LOCKED
    ), leased AS (
      UPDATE public.integration_inbox AS i
      SET available_at = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
          attempts = i.attempts + 1
      FROM picked
      WHERE i.tenant_id = picked.tenant_id AND i.id = picked.id
      RETURNING i.tenant_id, i.id, i.connection_id, i.attempts, picked.available_at AS picked_at
    )
    SELECT l.tenant_id, l.id, l.connection_id, l.attempts
    FROM leased AS l
    ORDER BY l.picked_at, l.id
  $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.claim_commerce_events(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (tenant_id uuid, id uuid, merchant_connection_id uuid, attempts integer)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    WITH picked AS (
      SELECT e.tenant_id, e.id, e.available_at
      FROM public.commerce_events AS e
      WHERE e.processed_at IS NULL AND e.available_at <= now()
      ORDER BY e.available_at, e.id
      LIMIT least(greatest(p_limit, 1), 500)
      FOR UPDATE SKIP LOCKED
    ), leased AS (
      UPDATE public.commerce_events AS e
      SET available_at = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
          attempts = e.attempts + 1
      FROM picked
      WHERE e.tenant_id = picked.tenant_id AND e.id = picked.id
      RETURNING e.tenant_id, e.id, e.merchant_connection_id, e.attempts,
                picked.available_at AS picked_at
    )
    SELECT l.tenant_id, l.id, l.merchant_connection_id, l.attempts
    FROM leased AS l
    ORDER BY l.picked_at, l.id
  $$;
