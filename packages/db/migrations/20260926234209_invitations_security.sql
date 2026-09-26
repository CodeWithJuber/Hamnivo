-- Invitations: forced RLS like every tenant table, plus a pre-tenant resolver so a person who is
-- not yet a member can accept an invitation (the gateway then verifies the token in the tenant).
SELECT app.harden_tenant_tables();
--> statement-breakpoint
GRANT SELECT (id, tenant_id, status, expires_at) ON invitations TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.resolve_invitation(p_invitation_id uuid)
  RETURNS TABLE (tenant_id uuid, status text, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT i.tenant_id, i.status, i.expires_at FROM public.invitations AS i WHERE i.id = p_invitation_id
  $$;
--> statement-breakpoint
ALTER FUNCTION app.resolve_invitation(uuid) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.resolve_invitation(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_invitation(uuid) TO hamnivo_app;
