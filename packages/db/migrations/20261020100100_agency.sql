-- Agency directory links are tenant-owned metadata. A link never grants access to client data.
CREATE TABLE agency_configs (
  tenant_id uuid PRIMARY KEY CONSTRAINT agency_configs_tenant_id_tenants_id_fk REFERENCES tenants(id),
  enabled boolean NOT NULL DEFAULT false,
  branding jsonb NOT NULL DEFAULT '{"displayName":null,"accentColor":null}'::jsonb,
  client_limit integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agency_configs_client_limit_ck CHECK (client_limit IS NULL OR client_limit BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON agency_configs TO hamnivo_app
  USING (tenant_id = (SELECT app.current_tenant()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant()));
--> statement-breakpoint
ALTER TABLE agency_configs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE agency_clients (
  tenant_id uuid NOT NULL CONSTRAINT agency_clients_tenant_id_tenants_id_fk REFERENCES tenants(id),
  client_tenant_id uuid NOT NULL CONSTRAINT agency_clients_client_tenant_id_tenants_id_fk REFERENCES tenants(id),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agency_clients_pkey PRIMARY KEY (tenant_id, client_tenant_id),
  CONSTRAINT agency_clients_creator_fk FOREIGN KEY (tenant_id, created_by)
    REFERENCES staff_members(tenant_id, id),
  CONSTRAINT agency_clients_not_self_ck CHECK (tenant_id <> client_tenant_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX agency_clients_one_parent_key ON agency_clients(client_tenant_id);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON agency_clients TO hamnivo_app
  USING (tenant_id = (SELECT app.current_tenant()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant()));
--> statement-breakpoint
ALTER TABLE agency_clients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Only the create-client path assigns payer ownership. It survives unlinking the directory row.
CREATE TABLE agency_client_funding (
  tenant_id uuid PRIMARY KEY CONSTRAINT agency_client_funding_tenant_id_tenants_id_fk REFERENCES tenants(id),
  payer_tenant_id uuid NOT NULL CONSTRAINT agency_client_funding_payer_tenant_id_tenants_id_fk REFERENCES tenants(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agency_client_funding_not_self_ck CHECK (tenant_id <> payer_tenant_id)
);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON agency_client_funding TO hamnivo_app
  USING (tenant_id = (SELECT app.current_tenant()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant()));
--> statement-breakpoint
ALTER TABLE agency_client_funding ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
SELECT app.harden_tenant_tables();
--> statement-breakpoint
-- A link's endpoints are immutable; unlink removes the row without affecting either tenant.
REVOKE UPDATE ON agency_clients FROM hamnivo_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON agency_client_funding FROM hamnivo_app;
--> statement-breakpoint
-- The resolver sees only the columns required to enforce graph rules and return directory metadata.
GRANT SELECT (tenant_id, enabled, client_limit) ON agency_configs TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, client_tenant_id, created_at) ON agency_clients TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, payer_tenant_id), INSERT ON agency_client_funding TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.fund_agency_client(p_client_tenant_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  parent_id uuid := app.current_tenant();
BEGIN
  IF parent_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.agency_clients
    WHERE tenant_id = parent_id AND client_tenant_id = p_client_tenant_id
  ) THEN
    RAISE EXCEPTION 'Client is not linked to this agency' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.agency_client_funding (tenant_id, payer_tenant_id)
  VALUES (p_client_tenant_id, parent_id);
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.fund_agency_client(uuid) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.fund_agency_client(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.fund_agency_client(uuid) TO hamnivo_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_payer_tenant() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT coalesce((SELECT payer_tenant_id FROM public.agency_client_funding
                     WHERE tenant_id = app.current_tenant()), app.current_tenant())
  $$;
--> statement-breakpoint
ALTER FUNCTION app.ai_payer_tenant() OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_payer_tenant() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_payer_tenant() TO hamnivo_app;
--> statement-breakpoint
-- Serializes updates that could turn a child into an agency while another request links it.
CREATE FUNCTION app.agency_config_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0));
  IF NEW.enabled AND EXISTS (
    SELECT 1 FROM public.agency_clients WHERE client_tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'A client tenant cannot enable agency mode' USING ERRCODE = '23514';
  END IF;
  IF NEW.client_limit IS NOT NULL AND (
    SELECT count(*) FROM public.agency_clients WHERE tenant_id = NEW.tenant_id
  ) > NEW.client_limit THEN
    RAISE EXCEPTION 'Client limit is below the number of linked clients' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.agency_config_guard() OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.agency_config_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER agency_config_guard BEFORE INSERT OR UPDATE OF enabled, client_limit ON agency_configs
  FOR EACH ROW EXECUTE FUNCTION app.agency_config_guard();
--> statement-breakpoint
-- Locks both tenant IDs in a stable order. One client can have one parent, and an agency can
-- never itself be a child. The unique index closes the same-client race as a second line of defense.
CREATE FUNCTION app.agency_client_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  agency_enabled boolean;
  max_clients integer;
  parent_status text;
  client_status text;
  linked_count integer;
BEGIN
  IF NEW.tenant_id = NEW.client_tenant_id THEN
    RAISE EXCEPTION 'An agency cannot link itself' USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id::text < NEW.client_tenant_id::text THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.client_tenant_id::text, 0));
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.client_tenant_id::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0));
  END IF;

  SELECT enabled, client_limit INTO agency_enabled, max_clients FROM public.agency_configs
    WHERE tenant_id = NEW.tenant_id;
  SELECT status INTO parent_status FROM public.tenants WHERE id = NEW.tenant_id;
  SELECT status INTO client_status FROM public.tenants WHERE id = NEW.client_tenant_id;
  IF NOT FOUND OR parent_status IS DISTINCT FROM 'active' OR client_status IS DISTINCT FROM 'active'
     OR agency_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Agency and client must be active, and agency mode enabled' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.agency_clients WHERE client_tenant_id = NEW.tenant_id)
     OR EXISTS (SELECT 1 FROM public.agency_configs WHERE tenant_id = NEW.client_tenant_id AND enabled)
     OR EXISTS (SELECT 1 FROM public.agency_clients WHERE tenant_id = NEW.client_tenant_id) THEN
    RAISE EXCEPTION 'Nested agencies are not allowed' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.agency_client_funding
    WHERE tenant_id = NEW.client_tenant_id AND payer_tenant_id <> NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Funded client cannot move to another agency' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO linked_count FROM public.agency_clients WHERE tenant_id = NEW.tenant_id;
  IF max_clients IS NOT NULL AND linked_count >= max_clients THEN
    RAISE EXCEPTION 'Agency client limit reached' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.agency_client_guard() OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.agency_client_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER agency_client_guard BEFORE INSERT ON agency_clients
  FOR EACH ROW EXECUTE FUNCTION app.agency_client_guard();
--> statement-breakpoint
-- Cross-tenant reads expose only metadata of clients already linked to the current agency.
CREATE FUNCTION app.agency_client_metadata()
  RETURNS TABLE (client_tenant_id uuid, slug text, name text, status text, linked_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT l.client_tenant_id, t.slug::text, t.name, t.status, l.created_at
    FROM public.agency_clients AS l
    JOIN public.tenants AS t ON t.id = l.client_tenant_id
    WHERE l.tenant_id = app.current_tenant()
    ORDER BY t.name, l.client_tenant_id
  $$;
--> statement-breakpoint
ALTER FUNCTION app.agency_client_metadata() OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.agency_client_metadata() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.agency_client_metadata() TO hamnivo_app;
