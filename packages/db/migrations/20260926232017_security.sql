-- Security hardening for the spine: forced RLS, append-only audit, platform read grants,
-- monthly audit partitions, and the few audited functions that work before a tenant is known.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
-- The audit log is append-only for the application.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM hamnivo_app;
--> statement-breakpoint
-- The platform console reads tenant metadata only (row access via the platform_read policies).
GRANT SELECT ON tenants, workspaces, brands, support_grants, authority_connections, usage_entries
  TO hamnivo_platform;
--> statement-breakpoint
-- The resolver role must own functions in `app` (ALTER FUNCTION ... OWNER needs CREATE there).
GRANT CREATE ON SCHEMA app TO hamnivo_resolver;
--> statement-breakpoint
CREATE TABLE audit_events_default PARTITION OF audit_events DEFAULT;
--> statement-breakpoint
-- Creates this month's and the next p_months_ahead monthly audit partitions (UTC). Rows that
-- reached the default partition before their month's partition existed are moved into it.
-- The worker calls this daily; it is idempotent.
CREATE FUNCTION app.ensure_audit_partitions(p_months_ahead integer DEFAULT 2) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  created integer := 0;
  month_start timestamp;
  from_ts timestamptz;
  to_ts timestamptz;
  part text;
BEGIN
  IF p_months_ahead < 0 OR p_months_ahead > 24 THEN
    RAISE EXCEPTION 'p_months_ahead must be between 0 and 24, got %', p_months_ahead;
  END IF;
  FOR i IN 0..p_months_ahead LOOP
    month_start := date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i);
    from_ts := month_start AT TIME ZONE 'UTC';
    to_ts := (month_start + interval '1 month') AT TIME ZONE 'UTC';
    part := 'audit_events_y' || to_char(month_start, 'YYYY') || 'm' || to_char(month_start, 'MM');
    CONTINUE WHEN to_regclass('public.' || part) IS NOT NULL;

    IF EXISTS (
      SELECT FROM public.audit_events_default WHERE occurred_at >= from_ts AND occurred_at < to_ts
    ) THEN
      ALTER TABLE public.audit_events DETACH PARTITION public.audit_events_default;
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.audit_events FOR VALUES FROM (%L) TO (%L)',
        part, from_ts, to_ts);
      EXECUTE format(
        'INSERT INTO public.%I SELECT * FROM public.audit_events_default WHERE occurred_at >= %L AND occurred_at < %L',
        part, from_ts, to_ts);
      DELETE FROM public.audit_events_default WHERE occurred_at >= from_ts AND occurred_at < to_ts;
      ALTER TABLE public.audit_events ATTACH PARTITION public.audit_events_default DEFAULT;
    ELSE
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.audit_events FOR VALUES FROM (%L) TO (%L)',
        part, from_ts, to_ts);
    END IF;
    EXECUTE format('REVOKE ALL ON public.%I FROM hamnivo_app, hamnivo_platform, hamnivo_resolver', part);
    created := created + 1;
  END LOOP;
  RETURN created;
END
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ensure_audit_partitions(integer) TO hamnivo_app;
--> statement-breakpoint
SELECT app.ensure_audit_partitions(2);
--> statement-breakpoint
-- ── Pre-tenant resolvers ────────────────────────────────────────────────────────────────────
-- Each returns the tenant plus the minimum needed to continue inside withTenant(). They run as
-- hamnivo_resolver (NOLOGIN, BYPASSRLS) with column-level grants only.
GRANT SELECT (id, slug, name, status) ON tenants TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, workspace_id, widget_public_id, allowed_origins, status, config_version)
  ON brands TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (id, tenant_id) ON widget_sessions TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, service_account_id, prefix, secret_hash, scopes, expires_at, revoked_at)
  ON api_keys TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, kind, status, base_url, account_id) ON authority_connections
  TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, auth_user_id, status) ON staff_members TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.resolve_widget(p_public_id text)
  RETURNS TABLE (
    tenant_id uuid, workspace_id uuid, brand_id uuid, allowed_origins text[],
    brand_status text, tenant_status text, config_version integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT b.tenant_id, b.workspace_id, b.id, b.allowed_origins, b.status, t.status, b.config_version
    FROM public.brands AS b
    JOIN public.tenants AS t ON t.id = b.tenant_id
    WHERE b.widget_public_id = p_public_id
  $$;
--> statement-breakpoint
CREATE FUNCTION app.resolve_widget_session(p_session_id uuid)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$ SELECT s.tenant_id FROM public.widget_sessions AS s WHERE s.id = p_session_id $$;
--> statement-breakpoint
CREATE FUNCTION app.resolve_api_key(p_prefix text)
  RETURNS TABLE (
    tenant_id uuid, key_id uuid, service_account_id uuid, secret_hash bytea, scopes text[],
    expires_at timestamptz, revoked_at timestamptz, tenant_status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT k.tenant_id, k.id, k.service_account_id, k.secret_hash, k.scopes, k.expires_at,
           k.revoked_at, t.status
    FROM public.api_keys AS k
    JOIN public.tenants AS t ON t.id = k.tenant_id
    WHERE k.prefix = p_prefix
  $$;
--> statement-breakpoint
CREATE FUNCTION app.resolve_authority_connection(p_connection_id uuid)
  RETURNS TABLE (tenant_id uuid, kind text, status text, base_url text, account_id integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT c.tenant_id, c.kind, c.status, c.base_url, c.account_id
    FROM public.authority_connections AS c
    WHERE c.id = p_connection_id
  $$;
--> statement-breakpoint
CREATE FUNCTION app.resolve_staff_memberships(p_auth_user_id text)
  RETURNS TABLE (
    tenant_id uuid, staff_member_id uuid, staff_status text, tenant_slug text, tenant_name text,
    tenant_status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT s.tenant_id, s.id, s.status, t.slug::text, t.name, t.status
    FROM public.staff_members AS s
    JOIN public.tenants AS t ON t.id = s.tenant_id
    WHERE s.auth_user_id = p_auth_user_id AND s.status <> 'removed'
    ORDER BY t.name
  $$;
--> statement-breakpoint
CREATE FUNCTION app.resolve_tenant_slug(p_slug text)
  RETURNS TABLE (tenant_id uuid, tenant_status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$ SELECT t.id, t.status FROM public.tenants AS t WHERE t.slug = p_slug::citext $$;
--> statement-breakpoint
-- ── Cross-tenant maintenance for the worker ─────────────────────────────────────────────────
GRANT SELECT, UPDATE ON outbox_events TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT, DELETE ON conversation_journal, identity_nonces, idempotency_keys TO hamnivo_resolver;
--> statement-breakpoint
-- Leases up to p_limit due outbox events across tenants. The relay acknowledges each event
-- inside withTenant(), so acknowledgement stays tenant-scoped.
CREATE FUNCTION app.claim_outbox(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (
    tenant_id uuid, id uuid, topic text, aggregate_type text, aggregate_id text, payload jsonb,
    headers jsonb, attempts integer, created_at timestamptz)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    WITH picked AS (
      SELECT o.tenant_id, o.id
      FROM public.outbox_events AS o
      WHERE o.processed_at IS NULL
        AND o.available_at <= now()
        AND (o.locked_until IS NULL OR o.locked_until < now())
      ORDER BY o.available_at, o.id
      LIMIT least(greatest(p_limit, 1), 500)
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.outbox_events AS o
    SET locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
        attempts = o.attempts + 1
    FROM picked
    WHERE o.tenant_id = picked.tenant_id AND o.id = picked.id
    RETURNING o.tenant_id, o.id, o.topic, o.aggregate_type, o.aggregate_id, o.payload, o.headers,
              o.attempts, o.created_at
  $$;
--> statement-breakpoint
-- Deletes up to p_batch expired rows per table (journal, identity nonces, idempotency keys).
CREATE FUNCTION app.purge_expired(p_batch integer DEFAULT 5000)
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
    SELECT x.tenant_id, x.conversation_id, x.seq FROM public.conversation_journal AS x
    WHERE x.expires_at < now() ORDER BY x.expires_at LIMIT lim
  ) AS d
  WHERE j.tenant_id = d.tenant_id AND j.conversation_id = d.conversation_id AND j.seq = d.seq;
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
END
$$;
--> statement-breakpoint
DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.resolve_widget(text)', 'app.resolve_widget_session(uuid)', 'app.resolve_api_key(text)',
    'app.resolve_authority_connection(uuid)', 'app.resolve_staff_memberships(text)',
    'app.resolve_tenant_slug(text)', 'app.claim_outbox(integer, integer)',
    'app.purge_expired(integer)'
  ]::regprocedure[] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO hamnivo_resolver', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hamnivo_app', fn);
  END LOOP;
END
$$;
--> statement-breakpoint
SELECT app.harden_tenant_tables();
