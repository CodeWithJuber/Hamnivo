-- Agent runtime: forced RLS on the new tables, immutable published agent versions, and kill
-- switches that are cleared, never deleted, so the audit trail of who stopped the AI survives.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
CREATE FUNCTION app.agent_versions_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' THEN
      RAISE EXCEPTION 'published agent versions cannot be deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.state <> 'draft' AND (
       NEW.config IS DISTINCT FROM OLD.config
    OR NEW.config_hash IS DISTINCT FROM OLD.config_hash
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
    OR NEW.published_by IS DISTINCT FROM OLD.published_by
    OR NEW.state = 'draft') THEN
    RAISE EXCEPTION 'published agent versions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER agent_versions_guard BEFORE UPDATE OR DELETE ON agent_versions
  FOR EACH ROW EXECUTE FUNCTION app.agent_versions_guard();
--> statement-breakpoint
REVOKE DELETE ON kill_switches FROM hamnivo_app;
