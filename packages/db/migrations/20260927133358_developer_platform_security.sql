-- Developer platform (D06, X05, A08, A15, A16, O04): forced RLS on the new tables, the global
-- plan and invoice tables kept from the application role, append-only logs, audited
-- cross-tenant functions for the delivery worker and retention, and the triggers that feed the
-- outbox (webhook sources), the analytics projection, the usage ledger and the plan guards.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
-- ── Global platform tables ──────────────────────────────────────────────────────────────────
-- Plans and invoices are the platform operator's records. The application role has no access;
-- the platform role manages them; a tenant reads its own invoices through app.tenant_invoices().
REVOKE ALL ON plans, invoices FROM hamnivo_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON plans, invoices TO hamnivo_platform;
--> statement-breakpoint
-- Invoice generation reads each tenant's assigned plan (platform_read policy).
GRANT SELECT ON tenant_entitlements TO hamnivo_platform;
--> statement-breakpoint
-- ── Append-only and never-deleted tenant tables ─────────────────────────────────────────────
-- Delivery attempts, events and usage alerts are records of what happened. Deliveries, the
-- analytics projection, entitlements and the egress policy change state but are never deleted
-- by the application (deleting an endpoint or an expired event cascades as the table owner).
REVOKE UPDATE, DELETE ON webhook_attempts, webhook_events, usage_alerts FROM hamnivo_app;
--> statement-breakpoint
REVOKE DELETE ON webhook_deliveries, conversation_metrics, tenant_entitlements, egress_policies
  FROM hamnivo_app;
--> statement-breakpoint
-- ── API keys: the pre-tenant resolver returns scope, hash version and account status ───────
GRANT SELECT (hash_version, scope_type, scope_id) ON api_keys TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, status) ON service_accounts TO hamnivo_resolver;
--> statement-breakpoint
DROP FUNCTION app.resolve_api_key(text);
--> statement-breakpoint
CREATE FUNCTION app.resolve_api_key(p_prefix text)
  RETURNS TABLE (
    tenant_id uuid, key_id uuid, service_account_id uuid, secret_hash bytea, hash_version integer,
    scopes text[], scope_type text, scope_id uuid, expires_at timestamptz, revoked_at timestamptz,
    tenant_status text, service_account_status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT k.tenant_id, k.id, k.service_account_id, k.secret_hash, k.hash_version, k.scopes,
           k.scope_type, k.scope_id, k.expires_at, k.revoked_at, t.status, s.status
    FROM public.api_keys AS k
    JOIN public.tenants AS t ON t.id = k.tenant_id
    JOIN public.service_accounts AS s ON s.tenant_id = k.tenant_id AND s.id = k.service_account_id
    WHERE k.prefix = p_prefix
  $$;
--> statement-breakpoint
-- ── Webhook delivery worker: due deliveries leased across tenants ───────────────────────────
-- A lease moves the next attempt forward, so a worker that dies mid-request is retried later
-- rather than blocking the delivery. Suspended tenants are skipped.
GRANT SELECT (tenant_id, id, status, next_attempt_at, attempts), UPDATE (next_attempt_at)
  ON webhook_deliveries TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.claim_webhook_deliveries(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (tenant_id uuid, id uuid, attempts integer)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    WITH picked AS (
      SELECT d.tenant_id, d.id
      FROM public.webhook_deliveries AS d
      JOIN public.tenants AS t ON t.id = d.tenant_id AND t.status = 'active'
      WHERE d.status = 'pending' AND d.next_attempt_at <= now()
      ORDER BY d.next_attempt_at, d.id
      LIMIT least(greatest(p_limit, 1), 200)
      FOR UPDATE OF d SKIP LOCKED
    )
    UPDATE public.webhook_deliveries AS d
    SET next_attempt_at = now() + make_interval(secs => greatest(p_lease_seconds, 1))
    FROM picked
    WHERE d.tenant_id = picked.tenant_id AND d.id = picked.id
    RETURNING d.tenant_id, d.id, d.attempts
  $$;
--> statement-breakpoint
-- ── Webhook event retention ─────────────────────────────────────────────────────────────────
-- Past `expires_at` an event body is removed (it can no longer be replayed); after p_keep_days
-- the event goes with its deliveries and attempts.
GRANT SELECT (tenant_id, id, body, expires_at, created_at), UPDATE (body), DELETE
  ON webhook_events TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.purge_webhook_events(p_batch integer, p_keep_days integer)
  RETURNS TABLE (cleared bigint, deleted bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  lim integer := least(greatest(p_batch, 1), 50000);
BEGIN
  IF p_keep_days < 1 THEN
    RAISE EXCEPTION 'p_keep_days must be at least 1, got %', p_keep_days;
  END IF;
  UPDATE public.webhook_events AS e SET body = NULL
  FROM (
    SELECT x.tenant_id, x.id FROM public.webhook_events AS x
    WHERE x.body IS NOT NULL AND x.expires_at < now() ORDER BY x.expires_at LIMIT lim
  ) AS d
  WHERE e.tenant_id = d.tenant_id AND e.id = d.id;
  GET DIAGNOSTICS cleared = ROW_COUNT;
  DELETE FROM public.webhook_events AS e
  USING (
    SELECT x.tenant_id, x.id FROM public.webhook_events AS x
    WHERE x.created_at < now() - make_interval(days => p_keep_days)
    ORDER BY x.created_at LIMIT lim
  ) AS d
  WHERE e.tenant_id = d.tenant_id AND e.id = d.id;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;
END
$$;
--> statement-breakpoint
-- ── A tenant's own invoices ─────────────────────────────────────────────────────────────────
-- Bound to the tenant of the current transaction (withTenant); drafts are the operator's until
-- they are issued.
GRANT SELECT ON invoices TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.tenant_invoices(p_invoice_id uuid DEFAULT NULL)
  RETURNS TABLE (
    id uuid, number text, period_key text, period_start timestamptz, period_end timestamptz,
    plan_name text, status text, currency text, subtotal_minor bigint, total_minor bigint,
    lines jsonb, usage jsonb, issued_at timestamptz, due_at timestamptz, paid_at timestamptz,
    voided_at timestamptz, payment_method text, payment_state text,
    payment_failed_at timestamptz, next_payment_retry_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT i.id, i.number, i.period_key, i.period_start, i.period_end, i.plan_name, i.status,
           i.currency, i.subtotal_minor, i.total_minor, i.lines, i.usage, i.issued_at, i.due_at,
           i.paid_at, i.voided_at, i.payment_method, i.payment_state, i.payment_failed_at,
           i.next_payment_retry_at
    FROM public.invoices AS i
    WHERE i.tenant_id = app.current_tenant()
      AND i.status <> 'draft'
      AND (p_invoice_id IS NULL OR i.id = p_invoice_id)
    ORDER BY i.period_start DESC, i.created_at DESC
  $$;
--> statement-breakpoint
DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.resolve_api_key(text)',
    'app.claim_webhook_deliveries(integer, integer)',
    'app.purge_webhook_events(integer, integer)',
    'app.tenant_invoices(uuid)'
  ]::regprocedure[] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO hamnivo_resolver', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hamnivo_app', fn);
  END LOOP;
END
$$;
--> statement-breakpoint
-- ── Webhook sources: state changes become outbox events in the same transaction ─────────────
-- Only while the tenant has an active endpoint; the worker turns each into one signed event
-- per subscribed endpoint. The payload names what changed; the worker reads the rest.
CREATE FUNCTION app.enqueue_webhook_source(
  p_tenant uuid, p_aggregate_type text, p_aggregate_id text, p_payload jsonb) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF EXISTS (
    SELECT FROM public.webhook_endpoints AS e WHERE e.tenant_id = p_tenant AND e.status = 'active'
  ) THEN
    INSERT INTO public.outbox_events (id, tenant_id, topic, aggregate_type, aggregate_id, payload)
    VALUES (gen_random_uuid(), p_tenant, 'webhooks.source', p_aggregate_type, p_aggregate_id,
            p_payload);
  END IF;
END
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.enqueue_webhook_source(uuid, text, text, jsonb) TO hamnivo_app;
--> statement-breakpoint
-- Conversations: the analytics row, one `conversations` usage entry, and conversation.created;
-- then every change of who holds the conversation (handoffs).
CREATE FUNCTION app.conversation_controls_projections() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.conversation_metrics (
      id, tenant_id, brand_id, inbox_id, channel, started_with, created_at, human_involved)
    VALUES (
      NEW.id, NEW.tenant_id, NEW.brand_id, NEW.inbox_id,
      (SELECT i.channel_type FROM public.authority_inboxes AS i
       WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.inbox_id),
      CASE WHEN NEW.owner_mode = 'AI_ACTIVE' THEN 'ai' ELSE 'people' END,
      NEW.created_at, NEW.owner_mode = 'HUMAN_ACTIVE')
    ON CONFLICT DO NOTHING;
    INSERT INTO public.usage_entries (
      id, tenant_id, meter, quantity, unit, occurred_at, dedupe_key, source_ref)
    VALUES (gen_random_uuid(), NEW.tenant_id, 'conversations', 1, 'conversation', NEW.created_at,
            'conversation:' || NEW.id, NULL)
    ON CONFLICT (tenant_id, dedupe_key) DO NOTHING;
    PERFORM app.enqueue_webhook_source(NEW.tenant_id, 'conversation', NEW.id::text,
      jsonb_build_object('kind', 'conversation_created', 'conversationId', NEW.id));
    RETURN NULL;
  END IF;
  IF NEW.owner_mode IS NOT DISTINCT FROM OLD.owner_mode THEN
    RETURN NULL;
  END IF;
  UPDATE public.conversation_metrics AS m SET
    handed_off_at = CASE
      WHEN m.handed_off_at IS NULL AND OLD.owner_mode = 'AI_ACTIVE' THEN now()
      ELSE m.handed_off_at END,
    handoff_reason = CASE
      WHEN m.handed_off_at IS NULL AND OLD.owner_mode = 'AI_ACTIVE' THEN NEW.owner_reason
      ELSE m.handoff_reason END,
    human_involved = m.human_involved OR NEW.owner_mode = 'HUMAN_ACTIVE',
    updated_at = now()
  WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.id;
  PERFORM app.enqueue_webhook_source(NEW.tenant_id, 'conversation', NEW.id::text,
    jsonb_build_object(
      'kind', 'ownership', 'conversationId', NEW.id, 'from', OLD.owner_mode,
      'to', NEW.owner_mode, 'reason', NEW.owner_reason, 'staffId', NEW.owner_staff_id,
      'epoch', NEW.ownership_epoch, 'at', now()));
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER conversation_controls_projections
  AFTER INSERT OR UPDATE OF owner_mode ON conversation_controls
  FOR EACH ROW EXECUTE FUNCTION app.conversation_controls_projections();
--> statement-breakpoint
-- The customer lane of the journal: first message, first response, resolutions and reopens for
-- analytics, and the customer-visible events for webhooks. Staff and agent lanes never reach
-- webhooks, so internal notes cannot leave through them.
CREATE FUNCTION app.conversation_journal_projections() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_at timestamptz := CASE
    WHEN NEW.event->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}'
    THEN (NEW.event->>'occurredAt')::timestamptz ELSE now() END;
  v_sender text := NEW.event->'data'->'message'->'sender'->>'kind';
BEGIN
  IF NEW.lane <> 'customer' THEN
    RETURN NULL;
  END IF;
  IF NEW.event_type = 'message.created' AND v_sender = 'customer' THEN
    UPDATE public.conversation_metrics AS m
    SET first_customer_message_at = v_at, updated_at = now()
    WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.conversation_id
      AND m.first_customer_message_at IS NULL;
  ELSIF NEW.event_type = 'message.created'
    AND v_sender IN ('ai_agent', 'ai_specialist', 'external_agent', 'human_agent') THEN
    UPDATE public.conversation_metrics AS m SET
      first_response_at = coalesce(m.first_response_at, v_at),
      first_response_by = coalesce(m.first_response_by,
        CASE WHEN v_sender = 'human_agent' THEN 'person' ELSE 'ai' END),
      updated_at = now()
    WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.conversation_id
      AND m.first_customer_message_at IS NOT NULL AND m.first_response_at IS NULL;
    IF v_sender = 'human_agent' THEN
      UPDATE public.conversation_metrics AS m SET
        first_human_response_at = coalesce(m.first_human_response_at, v_at),
        human_involved = true,
        updated_at = now()
      WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.conversation_id;
    END IF;
  ELSIF NEW.event_type = 'conversation.resolved' THEN
    UPDATE public.conversation_metrics AS m SET
      first_resolved_at = coalesce(m.first_resolved_at, v_at),
      last_resolved_at = v_at,
      resolved_by = CASE WHEN m.human_involved THEN 'person' ELSE 'ai' END,
      resolution_count = m.resolution_count + 1,
      updated_at = now()
    WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.conversation_id;
  ELSIF NEW.event_type = 'conversation.reopened' THEN
    UPDATE public.conversation_metrics AS m
    SET reopen_count = m.reopen_count + 1, updated_at = now()
    WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.conversation_id;
  END IF;
  IF NEW.event_type IN (
    'message.created', 'conversation.updated', 'conversation.resolved', 'conversation.reopened'
  ) THEN
    PERFORM app.enqueue_webhook_source(NEW.tenant_id, 'conversation', NEW.conversation_id::text,
      jsonb_build_object(
        'kind', 'journal', 'conversationId', NEW.conversation_id, 'lane', NEW.lane,
        'seq', NEW.seq));
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER conversation_journal_projections
  AFTER INSERT ON conversation_journal
  FOR EACH ROW EXECUTE FUNCTION app.conversation_journal_projections();
--> statement-breakpoint
-- Orders, payments and refunds: every new row and every change of state.
CREATE FUNCTION app.commerce_webhook_source() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NULL;
  END IF;
  PERFORM app.enqueue_webhook_source(NEW.tenant_id, TG_TABLE_NAME, NEW.id::text,
    jsonb_build_object(
      'kind', TG_TABLE_NAME, 'id', NEW.id, 'op', lower(TG_OP), 'state', NEW.state,
      'previousState', CASE WHEN TG_OP = 'UPDATE' THEN OLD.state END, 'at', now()));
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER orders_webhook_source AFTER INSERT OR UPDATE OF state ON orders
  FOR EACH ROW EXECUTE FUNCTION app.commerce_webhook_source();
--> statement-breakpoint
CREATE TRIGGER payments_webhook_source AFTER UPDATE OF state ON payments
  FOR EACH ROW EXECUTE FUNCTION app.commerce_webhook_source();
--> statement-breakpoint
CREATE TRIGGER refunds_webhook_source AFTER INSERT OR UPDATE OF state ON refunds
  FOR EACH ROW EXECUTE FUNCTION app.commerce_webhook_source();
--> statement-breakpoint
-- A memory deletion is announced once it is complete (the receipt, never the content).
CREATE FUNCTION app.memory_deletion_webhook_source() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    PERFORM app.enqueue_webhook_source(NEW.tenant_id, 'memory_deletion', NEW.id::text,
      jsonb_build_object('kind', 'memory_deletion', 'id', NEW.id));
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER memory_deletions_webhook_source AFTER UPDATE OF status ON memory_deletions
  FOR EACH ROW EXECUTE FUNCTION app.memory_deletion_webhook_source();
--> statement-breakpoint
-- ── Plan limits enforced where the capacity is used ─────────────────────────────────────────
-- SQLSTATE HN402 (Hamnivo, HTTP 402): the gateway answers PLAN_LIMIT_REACHED with the limit
-- (DETAIL) and the numbers (HINT, JSON). The entitlement row is locked, so two requests cannot
-- both take the last seat. Without a plan nothing is limited.
CREATE FUNCTION app.plan_limit(p_tenant uuid, p_limit text) RETURNS bigint
  LANGUAGE sql
  SET search_path = pg_catalog, public
  AS $$
    SELECT CASE WHEN jsonb_typeof(e.limits -> p_limit) = 'number'
                THEN (e.limits ->> p_limit)::bigint END
    FROM public.tenant_entitlements AS e
    WHERE e.tenant_id = p_tenant
    FOR UPDATE
  $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.plan_limit(uuid, text) TO hamnivo_app;
--> statement-breakpoint
-- Seats: members who are active or invited, and pending invitations, count against the plan.
CREATE FUNCTION app.guard_seat_limit() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  cap bigint := app.plan_limit(NEW.tenant_id, 'seats');
  used bigint;
BEGIN
  IF cap IS NULL OR NEW.status <> 'pending' THEN
    RETURN NEW;
  END IF;
  SELECT (SELECT count(*) FROM public.staff_members AS s
          WHERE s.tenant_id = NEW.tenant_id AND s.status IN ('active', 'invited'))
       + (SELECT count(*) FROM public.invitations AS i
          WHERE i.tenant_id = NEW.tenant_id AND i.status = 'pending' AND i.expires_at > now())
  INTO used;
  IF used + 1 > cap THEN
    RAISE EXCEPTION 'plan limit reached: seats'
      USING ERRCODE = 'HN402', DETAIL = 'seats',
            HINT = json_build_object('max', cap, 'used', used)::text;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invitations_seat_limit BEFORE INSERT ON invitations
  FOR EACH ROW EXECUTE FUNCTION app.guard_seat_limit();
--> statement-breakpoint
-- Knowledge storage: every document version that is kept (not failed, rejected or superseded).
CREATE FUNCTION app.guard_knowledge_storage() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  cap bigint := app.plan_limit(NEW.tenant_id, 'knowledgeStorageBytes');
  used bigint;
BEGIN
  IF cap IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT coalesce(sum(v.byte_size), 0) INTO used FROM public.document_versions AS v
  WHERE v.tenant_id = NEW.tenant_id AND v.state IN ('queued', 'processing', 'ready');
  IF used + NEW.byte_size > cap THEN
    RAISE EXCEPTION 'plan limit reached: knowledge storage'
      USING ERRCODE = 'HN402', DETAIL = 'knowledgeStorageBytes',
            HINT = json_build_object('max', cap, 'used', used)::text;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER document_versions_storage_limit BEFORE INSERT ON document_versions
  FOR EACH ROW EXECUTE FUNCTION app.guard_knowledge_storage();
--> statement-breakpoint
SELECT app.harden_tenant_tables();
