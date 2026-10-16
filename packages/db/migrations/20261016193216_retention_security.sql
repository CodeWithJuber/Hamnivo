-- Retention (A10): forced RLS like every tenant table. A workspace's policy is changed, never
-- deleted. Old resolved conversations are deleted by the worker's sweep through the functions
-- below, owned by hamnivo_resolver: the application cannot delete from the append-only tables a
-- conversation leaves behind, and must not be able to delete a conversation's records any other
-- way. What reports read stays in conversation_metrics, without anything about the customer.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON retention_policies FROM hamnivo_app;
--> statement-breakpoint
GRANT SELECT (tenant_id, conversation_days, pending_days, pending_from),
  UPDATE (conversation_days, pending_days, pending_from, updated_at)
  ON retention_policies TO hamnivo_resolver;
--> statement-breakpoint
-- UPDATE of one column only so the functions can lock the row they check (SELECT ... FOR UPDATE).
GRANT SELECT (tenant_id, id, connection_id, external_conversation_id, principal_id,
  authority_status, last_activity_at), UPDATE (updated_at), DELETE ON conversation_controls
  TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, id), DELETE,
  UPDATE (retired_at, team_id, priority, ticket_number, ticket_source, ticket_opened_at,
    rating_count, rating_sum, updated_at)
  ON conversation_metrics TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, conversation_id, team_id, priority, ticket_number, ticket_source,
  ticket_opened_at), DELETE ON conversation_inbox_state TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, conversation_id, rating), DELETE ON conversation_feedback
  TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, conversation_id), DELETE ON actions TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, action_id), DELETE ON action_approvals TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (conversation_id) ON ai_drafts TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, conversation_id) ON runs TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, run_id), DELETE ON run_steps TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, conversation_id, linked_conversation_id), DELETE ON conversation_links
  TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, connection_id, scope, scope_ref), DELETE ON reconcile_cursors
  TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, conversation_id), DELETE ON handoff_packets, decision_checks,
  decision_records, automation_runs, conversation_journal, message_ledger, publications,
  staff_drafts, staff_conversation_reads, conversation_reviews, widget_uploads,
  conversation_read_state, customer_notifications, ticket_followups, test_conversations
  TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, brand_id, created_at, last_seen_at), UPDATE (last_seen_at), DELETE
  ON customer_principals TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, principal_id) ON carts, quotes, purchase_intents, orders
  TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, subject_id) ON memory_records TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, principal_id, expires_at, revoked_at) ON widget_sessions
  TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, principal_id), DELETE ON authority_contacts, widget_sessions,
  language_preferences, customer_notification_preferences TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, principal_id) ON customer_notifications, widget_uploads,
  conversation_read_state, ticket_followups TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, principal_id), UPDATE (principal_id) ON visitors TO hamnivo_resolver;
--> statement-breakpoint
GRANT DELETE ON outbox_events TO hamnivo_resolver;
--> statement-breakpoint
-- Old resolved conversations of every workspace whose retention is on, oldest first and a fair
-- share per workspace. Changes that waited out their grace take effect first.
CREATE FUNCTION app.retention_due(p_limit integer DEFAULT 100, p_per_tenant integer DEFAULT 25)
  RETURNS TABLE (
    tenant_id uuid,
    conversation_id uuid,
    connection_id uuid,
    external_conversation_id integer,
    last_activity_at timestamptz,
    cutoff timestamptz
  )
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  lim integer := least(greatest(p_limit, 1), 1000);
  per integer := least(greatest(p_per_tenant, 1), 1000);
BEGIN
  UPDATE public.retention_policies AS p
  SET conversation_days = p.pending_days, pending_days = NULL, pending_from = NULL,
      updated_at = now()
  WHERE p.pending_from <= now();
  RETURN QUERY
  SELECT p.tenant_id, c.id, c.connection_id, c.external_conversation_id, c.last_activity_at,
         now() - make_interval(days => p.conversation_days)
  FROM public.retention_policies AS p
  CROSS JOIN LATERAL (
    SELECT x.id, x.connection_id, x.external_conversation_id, x.last_activity_at
    FROM public.conversation_controls AS x
    WHERE x.tenant_id = p.tenant_id AND x.authority_status = 'resolved'
      AND x.last_activity_at < now() - make_interval(days => p.conversation_days)
    ORDER BY x.last_activity_at
    LIMIT per
  ) AS c
  WHERE p.conversation_days IS NOT NULL
  ORDER BY c.last_activity_at
  LIMIT lim;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.retention_due(integer, integer) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.retention_due(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.retention_due(integer, integer) TO hamnivo_app;
--> statement-breakpoint
-- Workspaces whose retention is on, with their cutoff, for the sweep's work that does not start
-- from a conversation Hamnivo knows (customers left with nothing, history only the chat engine has).
CREATE FUNCTION app.retention_tenants()
  RETURNS TABLE (tenant_id uuid, cutoff timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT p.tenant_id, now() - make_interval(days => p.conversation_days)
  FROM public.retention_policies AS p
  WHERE p.conversation_days IS NOT NULL
  ORDER BY p.tenant_id
$$;
--> statement-breakpoint
ALTER FUNCTION app.retention_tenants() OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.retention_tenants() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.retention_tenants() TO hamnivo_app;
--> statement-breakpoint
-- Deletes one conversation's records in a tenant, keeping the anonymous report row. Called only by
-- the definer functions below, which decide whether the conversation may go, and so runs with
-- their rights; the application cannot call it.
CREATE FUNCTION app.remove_conversation(p_tenant uuid, p_conversation uuid)
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
ALTER FUNCTION app.remove_conversation(uuid, uuid) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.remove_conversation(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- Retention deletes a conversation of the current tenant only while it is still resolved and older
-- than the policy, checked here at the database's clock under the row's lock. True when it went.
CREATE FUNCTION app.retire_conversation(p_conversation uuid)
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
  PERFORM 1 FROM public.conversation_controls AS c
  WHERE c.tenant_id = t AND c.id = p_conversation AND c.authority_status = 'resolved'
    AND c.last_activity_at < now() - make_interval(days => days)
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM app.remove_conversation(t, p_conversation);
  RETURN true;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.retire_conversation(uuid) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.retire_conversation(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.retire_conversation(uuid) TO hamnivo_app;
--> statement-breakpoint
-- Whether a customer still has something retention keeps: a conversation, anything bought (orders
-- are business records and keep their customer) or a live widget session. Called only by the
-- definer functions below.
CREATE FUNCTION app.customer_retained(p_tenant uuid, p_principal uuid)
  RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
  AS $$
  SELECT EXISTS (SELECT 1 FROM public.conversation_controls AS x
                 WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal)
      OR EXISTS (SELECT 1 FROM public.orders AS x
                 WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal)
      OR EXISTS (SELECT 1 FROM public.purchase_intents AS x
                 WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal)
      OR EXISTS (SELECT 1 FROM public.quotes AS x
                 WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal)
      OR EXISTS (SELECT 1 FROM public.carts AS x
                 WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal)
      OR EXISTS (SELECT 1 FROM public.widget_sessions AS x
                 WHERE x.tenant_id = p_tenant AND x.principal_id = p_principal
                   AND x.revoked_at IS NULL AND x.expires_at > now())
$$;
--> statement-breakpoint
ALTER FUNCTION app.customer_retained(uuid, uuid) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.customer_retained(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- Customers of the current tenant that retention removes, oldest first: not seen since the cutoff
-- and with nothing retention keeps. Their memory goes first, through the memory deletion path.
CREATE FUNCTION app.retention_orphans(p_limit integer DEFAULT 100)
  RETURNS TABLE (principal_id uuid, brand_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
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
    RETURN;
  END IF;
  RETURN QUERY
  SELECT cp.id, cp.brand_id FROM public.customer_principals AS cp
  WHERE cp.tenant_id = t
    AND coalesce(cp.last_seen_at, cp.created_at) < now() - make_interval(days => days)
    AND NOT app.customer_retained(t, cp.id)
  ORDER BY coalesce(cp.last_seen_at, cp.created_at)
  LIMIT least(greatest(p_limit, 1), 1000);
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.retention_orphans(integer) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.retention_orphans(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.retention_orphans(integer) TO hamnivo_app;
--> statement-breakpoint
-- Removes one customer of the current tenant whom retention may remove (see retention_orphans),
-- once their memory is gone, checked again here under the row's lock. Consent records stay: they
-- prove what was agreed and hold no more than the customer's id. True when the customer went.
CREATE FUNCTION app.retire_customer(p_principal uuid)
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
  DELETE FROM public.customer_principals AS x WHERE x.tenant_id = t AND x.id = p_principal;
  RETURN true;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.retire_customer(uuid) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.retire_customer(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.retire_customer(uuid) TO hamnivo_app;
--> statement-breakpoint
-- Handled outbox events keep their payloads, some with message text, only for 30 days.
CREATE FUNCTION app.purge_outbox_events(p_batch integer DEFAULT 5000)
  RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  lim integer := least(greatest(p_batch, 1), 50000);
  removed bigint;
BEGIN
  DELETE FROM public.outbox_events AS o
  USING (
    SELECT x.tenant_id, x.id FROM public.outbox_events AS x
    WHERE x.processed_at < now() - interval '30 days'
    ORDER BY x.processed_at LIMIT lim
  ) AS d
  WHERE o.tenant_id = d.tenant_id AND o.id = d.id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.purge_outbox_events(integer) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.purge_outbox_events(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.purge_outbox_events(integer) TO hamnivo_app;
