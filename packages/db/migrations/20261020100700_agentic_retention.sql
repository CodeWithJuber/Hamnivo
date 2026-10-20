-- Extend the existing authorized retention/erasure paths to agentic execution records.
-- These functions retain their owners, ACLs and tenant/eligibility checks. No caller gains
-- a new cross-tenant entry point or permission to delete append-only business records.
ALTER TABLE public.connector_dispatches ALTER COLUMN principal_id DROP NOT NULL;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, conversation_id), DELETE ON workflow_runs TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, run_id), DELETE ON workflow_run_steps TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, principal_id, conversation_id), DELETE ON connector_quotes TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, principal_id), DELETE ON connector_identity_bindings TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, principal_id), UPDATE (principal_id) ON connector_dispatches TO hamnivo_resolver;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.remove_conversation(p_tenant uuid, p_conversation uuid)
  RETURNS void
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  ctl record;
  st record;
  rated record;
BEGIN
  SELECT c.connection_id, c.external_conversation_id INTO ctl
  FROM public.conversation_controls AS c
  WHERE c.tenant_id = p_tenant AND c.id = p_conversation;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.test_conversations AS x
    WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation
  ) THEN
    -- A chat an owner opened to try the widget is in no report.
    DELETE FROM public.conversation_metrics AS m
    WHERE m.tenant_id = p_tenant AND m.id = p_conversation;
  ELSE
    SELECT s.team_id, s.priority, s.ticket_number, s.ticket_source, s.ticket_opened_at INTO st
    FROM public.conversation_inbox_state AS s
    WHERE s.tenant_id = p_tenant AND s.conversation_id = p_conversation;
    SELECT count(*)::integer AS n, coalesce(sum(f.rating), 0)::integer AS total INTO rated
    FROM public.conversation_feedback AS f
    WHERE f.tenant_id = p_tenant AND f.conversation_id = p_conversation;
    UPDATE public.conversation_metrics AS m SET
      retired_at = now(), team_id = st.team_id, priority = st.priority,
      ticket_number = st.ticket_number, ticket_source = st.ticket_source,
      ticket_opened_at = st.ticket_opened_at, rating_count = rated.n, rating_sum = rated.total,
      updated_at = now()
    WHERE m.tenant_id = p_tenant AND m.id = p_conversation;
  END IF;

  -- Execution facts, delegated results and summaries contain customer content. Remove the
  -- entire workflow execution before actions; steps can still reference those actions.
  DELETE FROM public.workflow_run_steps AS s
  USING public.workflow_runs AS r
  WHERE s.tenant_id = p_tenant AND r.tenant_id = p_tenant AND s.run_id = r.id
    AND r.conversation_id = p_conversation;
  DELETE FROM public.workflow_runs AS r
  WHERE r.tenant_id = p_tenant AND r.conversation_id = p_conversation;
  DELETE FROM public.connector_quotes AS q
  WHERE q.tenant_id = p_tenant AND q.conversation_id = p_conversation;

  DELETE FROM public.action_approvals AS a
  USING public.actions AS x
  WHERE a.tenant_id = p_tenant AND x.tenant_id = p_tenant AND a.action_id = x.id
    AND x.conversation_id = p_conversation;
  DELETE FROM public.actions AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.ai_draft_decisions AS d
  USING public.ai_drafts AS x
  WHERE d.tenant_id = p_tenant AND x.tenant_id = p_tenant AND d.draft_id = x.id
    AND x.conversation_id = p_conversation;
  DELETE FROM public.ai_drafts AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.run_steps AS s
  USING public.runs AS r
  WHERE s.tenant_id = p_tenant AND r.tenant_id = p_tenant AND s.run_id = r.id
    AND r.conversation_id = p_conversation;
  DELETE FROM public.handoff_packets AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.decision_checks AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.decision_records AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.automation_runs AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.conversation_journal AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.publications AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.message_ledger AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.conversation_feedback AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.conversation_inbox_state AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.staff_drafts AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.staff_conversation_reads AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.conversation_links AS x
  WHERE x.tenant_id = p_tenant
    AND (x.conversation_id = p_conversation OR x.linked_conversation_id = p_conversation);
  DELETE FROM public.conversation_reviews AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.widget_uploads AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.conversation_read_state AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.customer_notifications AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.ticket_followups AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.test_conversations AS x
  WHERE x.tenant_id = p_tenant AND x.conversation_id = p_conversation;
  DELETE FROM public.reconcile_cursors AS x
  WHERE x.tenant_id = p_tenant AND x.connection_id = ctl.connection_id
    AND x.scope = 'conversation' AND x.scope_ref = ctl.external_conversation_id::text;
  DELETE FROM public.conversation_controls AS x
  WHERE x.tenant_id = p_tenant AND x.id = p_conversation;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.erase_principal(p_tenant uuid, p_principal uuid)
  RETURNS text
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  c record;
BEGIN
  PERFORM 1 FROM public.customer_principals AS cp
  WHERE cp.tenant_id = p_tenant AND cp.id = p_principal FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.memory_records AS x
             WHERE x.tenant_id = p_tenant AND x.subject_id = p_principal) THEN
    RETURN 'memory_left';
  END IF;
  FOR c IN
    SELECT x.id FROM public.conversation_controls AS x
    WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal
  LOOP
    PERFORM app.remove_conversation(p_tenant, c.id);
  END LOOP;
  DELETE FROM public.conversation_feedback AS x
  WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal;
  DELETE FROM public.customer_notifications AS x
  WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal;
  DELETE FROM public.widget_uploads AS x
  WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal;
  DELETE FROM public.conversation_read_state AS x
  WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal;
  DELETE FROM public.ticket_followups AS x
  WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal;
  DELETE FROM public.customer_notification_preferences AS x
  WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal;
  DELETE FROM public.language_preferences AS x
  WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal;
  DELETE FROM public.widget_sessions AS x
  WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal;
  DELETE FROM public.authority_contacts AS x
  WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal;
  UPDATE public.visitors AS x SET principal_id = NULL
  WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal;

  DELETE FROM public.connector_identity_bindings AS x
  WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal;
  DELETE FROM public.connector_quotes AS x
  WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal;
  -- Keep the content-free dispatch fence even after erasure. A returning remote account
  -- must not repeat an uncertain write. Remove the local customer link, not the fence.
  UPDATE public.connector_dispatches AS x SET principal_id = NULL
  WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal;

  -- What a purchase said about the person: where it went, and how it was approved and paid.
  UPDATE public.orders AS o SET delivery_summary = NULL
  WHERE o.tenant_id = p_tenant AND o.principal_id = p_principal;
  UPDATE public.fulfillments AS f SET note = NULL, carrier_ref = NULL
  FROM public.orders AS o
  WHERE f.tenant_id = p_tenant AND o.tenant_id = p_tenant AND f.order_id = o.id
    AND o.principal_id = p_principal;
  UPDATE public.finance_exceptions AS e SET evidence = '{}'::jsonb
  FROM public.orders AS o
  WHERE e.tenant_id = p_tenant AND o.tenant_id = p_tenant AND e.order_id = o.id
    AND o.principal_id = p_principal;
  UPDATE public.purchase_intents AS i SET checkout_url = NULL, approval_evidence = '{}'::jsonb
  WHERE i.tenant_id = p_tenant AND i.principal_id = p_principal;

  IF app.customer_retained(p_tenant, p_principal) THEN
    UPDATE public.customer_principals AS cp SET
      kind = 'anonymous', external_subject = NULL, display_name = NULL, email = NULL,
      email_verified_at = NULL, locale = NULL, channel_kind = NULL, channel_handle = NULL,
      erased_at = coalesce(cp.erased_at, now())
    WHERE cp.tenant_id = p_tenant AND cp.id = p_principal;
    RETURN 'anonymised';
  END IF;
  DELETE FROM public.customer_principals AS cp
  WHERE cp.tenant_id = p_tenant AND cp.id = p_principal;
  RETURN 'deleted';
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.retire_customer(p_principal uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  t uuid := app.current_tenant();
  days integer;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'retention needs a tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p.conversation_days INTO days FROM public.retention_policies AS p
  WHERE p.tenant_id = t;
  IF days IS NULL THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM public.customer_principals AS cp
  WHERE cp.tenant_id = t AND cp.id = p_principal
    AND coalesce(cp.last_seen_at, cp.created_at) < now() - make_interval(days => days)
  FOR UPDATE;
  IF NOT FOUND OR app.customer_retained(t, p_principal)
    OR EXISTS (SELECT 1 FROM public.memory_records AS x
               WHERE x.tenant_id = t AND x.subject_id = p_principal) THEN
    RETURN false;
  END IF;
  DELETE FROM public.customer_notifications AS x
  WHERE x.tenant_id = t AND x.principal_id = p_principal;
  DELETE FROM public.widget_uploads AS x WHERE x.tenant_id = t AND x.principal_id = p_principal;
  DELETE FROM public.conversation_read_state AS x
  WHERE x.tenant_id = t AND x.principal_id = p_principal;
  DELETE FROM public.ticket_followups AS x WHERE x.tenant_id = t AND x.principal_id = p_principal;
  DELETE FROM public.customer_notification_preferences AS x
  WHERE x.tenant_id = t AND x.principal_id = p_principal;
  DELETE FROM public.language_preferences AS x
  WHERE x.tenant_id = t AND x.principal_id = p_principal;
  DELETE FROM public.widget_sessions AS x WHERE x.tenant_id = t AND x.principal_id = p_principal;
  DELETE FROM public.authority_contacts AS x WHERE x.tenant_id = t AND x.principal_id = p_principal;
  UPDATE public.visitors AS x SET principal_id = NULL
  WHERE x.tenant_id = t AND x.principal_id = p_principal;
  DELETE FROM public.connector_identity_bindings AS x
  WHERE x.tenant_id = t AND x.principal_id = p_principal;
  DELETE FROM public.connector_quotes AS x
  WHERE x.tenant_id = t AND x.principal_id = p_principal;
  -- Keep the content-free dispatch fence even after erasure. A returning remote account
  -- must not repeat an uncertain write. Remove the local customer link, not the fence.
  UPDATE public.connector_dispatches AS x SET principal_id = NULL
  WHERE x.tenant_id = t AND x.principal_id = p_principal;
  DELETE FROM public.customer_principals AS x WHERE x.tenant_id = t AND x.id = p_principal;
  RETURN true;
END
$$;
