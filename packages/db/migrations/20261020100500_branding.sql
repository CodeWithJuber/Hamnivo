CREATE TABLE tenant_branding (
  tenant_id uuid PRIMARY KEY CONSTRAINT tenant_branding_tenant_id_tenants_id_fk REFERENCES tenants(id), portal jsonb NOT NULL, email jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_branding TO hamnivo_app
  USING (tenant_id = (SELECT app.current_tenant())) WITH CHECK (tenant_id = (SELECT app.current_tenant()));
--> statement-breakpoint
ALTER TABLE tenant_branding ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE branding_domains (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL CONSTRAINT branding_domains_tenant_id_tenants_id_fk REFERENCES tenants(id),
  hostname text NOT NULL CHECK (hostname = lower(hostname)), verification_token text NOT NULL,
  verified_at timestamptz, disabled_at timestamptz, last_checked_at timestamptz,
  last_check_result text CHECK (last_check_result IN ('verified', 'not_found', 'lookup_failed')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX branding_domains_hostname_key ON branding_domains(tenant_id, hostname);
--> statement-breakpoint
-- Pending challenges cannot squat another tenant's hostname. Only proven ownership is global.
CREATE UNIQUE INDEX branding_domains_verified_key ON branding_domains(hostname)
  WHERE verified_at IS NOT NULL AND disabled_at IS NULL;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON branding_domains TO hamnivo_app
  USING (tenant_id = (SELECT app.current_tenant())) WITH CHECK (tenant_id = (SELECT app.current_tenant()));
--> statement-breakpoint
ALTER TABLE branding_domains ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
SELECT app.harden_tenant_tables();
--> statement-breakpoint
-- Public resolution exposes appearance only: never tenant IDs, email settings or DNS tokens.
GRANT SELECT (tenant_id, hostname, verified_at, disabled_at) ON branding_domains TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, portal) ON tenant_branding TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.resolve_portal_branding(p_hostname text) RETURNS TABLE (portal jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT b.portal FROM public.branding_domains d
    JOIN public.tenants t ON t.id = d.tenant_id AND t.status = 'active'
    LEFT JOIN public.tenant_branding b ON b.tenant_id = d.tenant_id
    WHERE d.hostname = p_hostname AND d.verified_at IS NOT NULL AND d.disabled_at IS NULL
  $$;
--> statement-breakpoint
ALTER FUNCTION app.resolve_portal_branding(text) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.resolve_portal_branding(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_portal_branding(text) TO hamnivo_app;
