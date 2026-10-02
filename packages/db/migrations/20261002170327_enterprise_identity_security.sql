-- Enterprise sign-in (A13), support access (A18) and platform operations (A17): forced RLS on
-- the new tables, what the platform role may read or write, and two pre-tenant SSO resolvers.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
-- Platform tables are global operations data, not tenant data. The application role has no
-- access to them; the platform console uses hamnivo_platform, and only the database owner (the
-- server administrator) names platform operators.
REVOKE ALL ON platform_operators, platform_audit_events, platform_audit_head, platform_incidents
  FROM hamnivo_app;
--> statement-breakpoint
GRANT SELECT ON platform_operators TO hamnivo_platform;
--> statement-breakpoint
-- The platform audit log is append-only, like the tenant one.
GRANT SELECT, INSERT ON platform_audit_events TO hamnivo_platform;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform_audit_head, platform_incidents TO hamnivo_platform;
--> statement-breakpoint
-- Support access: an operator asks (a pending request, see the platform_request policy) and may
-- end an approved session early. Approving, declining and revoking stay with the tenant.
GRANT INSERT ON support_grants TO hamnivo_platform;
--> statement-breakpoint
GRANT UPDATE (ended_at) ON support_grants TO hamnivo_platform;
--> statement-breakpoint
-- Metadata the platform console reads. Column grants leave out what tenants typed or stored:
-- stop reasons, connection labels, keys, event payloads and headers.
GRANT SELECT (id, tenant_id, scope, brand_id, agent_id, created_at, cleared_at)
  ON kill_switches TO hamnivo_platform;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, provider, status, created_at, updated_at)
  ON model_connections TO hamnivo_platform;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, created_at, available_at, processed_at, attempts)
  ON outbox_events TO hamnivo_platform;
--> statement-breakpoint
-- ── Pre-tenant SSO resolvers ────────────────────────────────────────────────────────────────
-- Sign-in happens before a tenant is known: which workspace proved this email domain, and which
-- one owns this SSO callback? Only verified domains are returned.
GRANT SELECT (id, tenant_id, domain, verified_at) ON sso_domains TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, domain_id, provider_id, status, sso_only) ON sso_connections
  TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.resolve_sso_domain(p_domain text)
  RETURNS TABLE (
    tenant_id uuid, connection_id uuid, provider_id text, connection_status text,
    sso_only boolean, tenant_status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT c.tenant_id, c.id, c.provider_id, c.status, c.sso_only, t.status
    FROM public.sso_domains AS d
    JOIN public.sso_connections AS c ON c.tenant_id = d.tenant_id AND c.domain_id = d.id
    JOIN public.tenants AS t ON t.id = d.tenant_id
    WHERE d.domain = p_domain::citext AND d.verified_at IS NOT NULL
  $$;
--> statement-breakpoint
CREATE FUNCTION app.resolve_sso_provider(p_provider_id text)
  RETURNS TABLE (
    tenant_id uuid, connection_id uuid, domain text, connection_status text, sso_only boolean,
    tenant_status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT c.tenant_id, c.id, d.domain::text, c.status, c.sso_only, t.status
    FROM public.sso_connections AS c
    JOIN public.sso_domains AS d ON d.tenant_id = c.tenant_id AND d.id = c.domain_id
    JOIN public.tenants AS t ON t.id = c.tenant_id
    WHERE c.provider_id = p_provider_id AND d.verified_at IS NOT NULL
  $$;
--> statement-breakpoint
DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOREACH fn IN ARRAY ARRAY['app.resolve_sso_domain(text)', 'app.resolve_sso_provider(text)']::regprocedure[] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO hamnivo_resolver', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hamnivo_app', fn);
  END LOOP;
END
$$;
