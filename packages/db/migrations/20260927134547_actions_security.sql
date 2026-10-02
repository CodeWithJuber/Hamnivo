-- AI actions: forced RLS on the new tables; decided approvals and handoff packets are
-- append-only; actions, tool definitions, MCP servers and action settings are never deleted by the
-- application; an action keeps exactly what was proposed (and approved); every policy change of a
-- tool raises its revision (which approvals are bound to); and the narrow cross-tenant function the
-- worker uses to expire approvals nobody decided.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON action_approvals, handoff_packets FROM hamnivo_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON actions, tool_definitions, mcp_servers, action_settings FROM hamnivo_app;
--> statement-breakpoint
-- What an approver sees cannot change under them: only an action's state, decision time,
-- operation, completion time and reason move.
CREATE FUNCTION app.actions_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.arguments IS DISTINCT FROM OLD.arguments
    OR NEW.arguments_hash IS DISTINCT FROM OLD.arguments_hash
    OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.tool_id IS DISTINCT FROM OLD.tool_id
    OR NEW.tool_revision IS DISTINCT FROM OLD.tool_revision
    OR NEW.risk IS DISTINCT FROM OLD.risk
    OR NEW.approver IS DISTINCT FROM OLD.approver
    OR NEW.required_permission IS DISTINCT FROM OLD.required_permission
    OR NEW.step_up IS DISTINCT FROM OLD.step_up
    OR NEW.basis IS DISTINCT FROM OLD.basis
    OR NEW.summary IS DISTINCT FROM OLD.summary
    OR NEW.effects IS DISTINCT FROM OLD.effects
    OR NEW.changes IS DISTINCT FROM OLD.changes
    OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
    OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
    OR NEW.resource_revision IS DISTINCT FROM OLD.resource_revision
    OR NEW.owner_epoch IS DISTINCT FROM OLD.owner_epoch
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.code IS DISTINCT FROM OLD.code
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'actions keep what was proposed; propose a new action instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER actions_guard BEFORE UPDATE ON actions
  FOR EACH ROW EXECUTE FUNCTION app.actions_guard();
--> statement-breakpoint
-- A tool keeps where it came from, and any change to what it does or who approves it raises its
-- revision, so approvals given for the earlier revision stop being valid.
CREATE FUNCTION app.tool_definitions_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.source IS DISTINCT FROM OLD.source
    OR NEW.builtin IS DISTINCT FROM OLD.builtin
    OR NEW.mcp_server_id IS DISTINCT FROM OLD.mcp_server_id
    OR NEW.remote_name IS DISTINCT FROM OLD.remote_name
    OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.name IS DISTINCT FROM OLD.name THEN
    RAISE EXCEPTION 'a tool keeps its source, brand and name' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.title IS DISTINCT FROM OLD.title
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.input_schema IS DISTINCT FROM OLD.input_schema
    OR NEW.output_schema IS DISTINCT FROM OLD.output_schema
    OR NEW.risk IS DISTINCT FROM OLD.risk
    OR NEW.approver IS DISTINCT FROM OLD.approver
    OR NEW.required_permission IS DISTINCT FROM OLD.required_permission
    OR NEW.autopilot IS DISTINCT FROM OLD.autopilot
    OR NEW.customer_step_up IS DISTINCT FROM OLD.customer_step_up
    OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
    OR NEW.timeout_ms IS DISTINCT FROM OLD.timeout_ms
    OR NEW.max_output_bytes IS DISTINCT FROM OLD.max_output_bytes
    OR NEW.egress_hosts IS DISTINCT FROM OLD.egress_hosts
    OR NEW.amount_argument IS DISTINCT FROM OLD.amount_argument
    OR NEW.currency_argument IS DISTINCT FROM OLD.currency_argument
    OR NEW.approval_minutes IS DISTINCT FROM OLD.approval_minutes
    OR NEW.status IS DISTINCT FROM OLD.status)
    AND NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'a tool policy change must raise the revision' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tool_definitions_guard BEFORE UPDATE ON tool_definitions
  FOR EACH ROW EXECUTE FUNCTION app.tool_definitions_guard();
--> statement-breakpoint
-- ── Worker: approvals nobody decided in time ────────────────────────────────────────────────
GRANT SELECT (tenant_id, id, state, expires_at) ON actions TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.expired_actions(p_limit integer)
  RETURNS TABLE (tenant_id uuid, id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT a.tenant_id, a.id
    FROM public.actions AS a
    WHERE a.state = 'awaiting_approval' AND a.expires_at <= now()
    ORDER BY a.expires_at
    LIMIT least(greatest(p_limit, 1), 500)
  $$;
--> statement-breakpoint
DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOREACH fn IN ARRAY ARRAY['app.expired_actions(integer)']::regprocedure[] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO hamnivo_resolver', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hamnivo_app', fn);
  END LOOP;
END
$$;
