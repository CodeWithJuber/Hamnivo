-- AI drafts awaiting review (HNV-09-05): forced RLS like every tenant table. A decision is
-- append-only; a draft is never deleted by the application and keeps what it says, cites and
-- answers, and its state moves once, away from pending. Ended drafts and their decisions are
-- removed 90 days later by the worker's maintenance schedule.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON ai_draft_decisions FROM hamnivo_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON ai_drafts FROM hamnivo_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_drafts_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  -- tenant_id is left to row-level security, which refuses moving a row to another tenant.
  mutable constant text[] := ARRAY[
    'tenant_id', 'state', 'superseded_reason', 'decided_by', 'decided_at', 'updated_at'
  ];
BEGIN
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'an AI draft keeps what it says and answers; write a new draft instead'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state <> 'pending'
    AND (NEW.state, NEW.superseded_reason, NEW.decided_by, NEW.decided_at)
      IS DISTINCT FROM (OLD.state, OLD.superseded_reason, OLD.decided_by, OLD.decided_at) THEN
    RAISE EXCEPTION 'an AI draft is decided once'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER ai_drafts_guard BEFORE UPDATE ON ai_drafts
  FOR EACH ROW EXECUTE FUNCTION app.ai_drafts_guard();
--> statement-breakpoint
GRANT SELECT (tenant_id, id, decided_at), DELETE ON ai_drafts TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, draft_id), DELETE ON ai_draft_decisions TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.purge_ai_drafts(p_batch integer DEFAULT 5000)
  RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  lim integer := least(greatest(p_batch, 1), 50000);
  removed bigint;
BEGIN
  WITH ended AS (
    SELECT x.tenant_id, x.id FROM public.ai_drafts AS x
    WHERE x.decided_at < now() - interval '90 days'
    ORDER BY x.decided_at LIMIT lim
  ), decisions AS (
    DELETE FROM public.ai_draft_decisions AS d
    USING ended AS e
    WHERE d.tenant_id = e.tenant_id AND d.draft_id = e.id
  )
  DELETE FROM public.ai_drafts AS a
  USING ended AS e
  WHERE a.tenant_id = e.tenant_id AND a.id = e.id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.purge_ai_drafts(integer) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.purge_ai_drafts(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.purge_ai_drafts(integer) TO hamnivo_app;
