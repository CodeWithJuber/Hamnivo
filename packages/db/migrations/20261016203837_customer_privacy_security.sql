-- Exporting and erasing one customer (A10): forced RLS like every tenant table. Requests are
-- receipts and are never deleted; an export's file loses its bytes after 24 hours; erasure
-- tombstones are append-only. A customer is erased through the functions below, owned by
-- hamnivo_resolver, which reuse retention's removal of a conversation.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON privacy_requests, privacy_files FROM hamnivo_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON erasure_tombstones FROM hamnivo_app;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, kind, state, brand_id, principal_id) ON privacy_requests
  TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, purge_after, raw), UPDATE (raw) ON privacy_files TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, request_id, principal_id) ON erasure_tombstones TO hamnivo_resolver;
--> statement-breakpoint
GRANT INSERT ON outbox_events TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (erased_at), UPDATE (kind, external_subject, display_name, email, email_verified_at,
  locale, channel_kind, channel_handle, erased_at) ON customer_principals TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (id), UPDATE (delivery_summary) ON orders TO hamnivo_resolver;
--> statement-breakpoint
GRANT UPDATE (checkout_url, approval_evidence) ON purchase_intents TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, order_id), UPDATE (note, carrier_ref) ON fulfillments TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, order_id), UPDATE (evidence) ON finance_exceptions TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, principal_id), DELETE ON conversation_feedback TO hamnivo_resolver;
--> statement-breakpoint
-- Erases one customer of a tenant: their conversations and every record about them. A customer
-- who bought something stays as an anonymous stub (orders are accounting records), with what
-- identified them and the delivery details cleared; anyone else is deleted. Their memory must be
-- gone first, through the memory deletion path with its receipt: while some is left, nothing
-- happens and `memory_left` says so. Called only by the definer functions below.
CREATE FUNCTION app.erase_principal(p_tenant uuid, p_principal uuid)
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
ALTER FUNCTION app.erase_principal(uuid, uuid) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.erase_principal(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- Erases the customer of an erase request of the current tenant while it runs. Returns how many
-- conversations went and what became of the customer (`deleted`, `anonymised`, `missing`, or
-- `memory_left` while their memory is still being deleted).
CREATE FUNCTION app.erase_customer(p_request uuid)
  RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  t uuid := app.current_tenant();
  who uuid;
  n integer;
  outcome text;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'erasing needs a tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT r.principal_id INTO who FROM public.privacy_requests AS r
  WHERE r.tenant_id = t AND r.id = p_request AND r.kind = 'erase' AND r.state = 'running';
  IF who IS NULL THEN
    RAISE EXCEPTION 'not an erase request that is running' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*)::integer INTO n FROM public.conversation_controls AS x
  WHERE x.tenant_id = t AND x.principal_id = who;
  outcome := app.erase_principal(t, who);
  RETURN jsonb_build_object(
    'conversations', CASE WHEN outcome = 'memory_left' THEN 0 ELSE n END,
    'customer', outcome);
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.erase_customer(uuid) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.erase_customer(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.erase_customer(uuid) TO hamnivo_app;
--> statement-breakpoint
-- After a restore (and daily, as a safety net): erases again every customer an erasure removed
-- whom a backup brought back, and asks the worker to check the chat engine for them too
-- (privacy.replay). Run after app.apply_memory_tombstones(), which removes their memory.
CREATE FUNCTION app.apply_erasure_tombstones()
  RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  e record;
  erased bigint := 0;
BEGIN
  FOR e IN
    SELECT t.tenant_id, t.id, t.principal_id
    FROM public.erasure_tombstones AS t
    -- Only finished erasures: a tombstone is written before Chatwoot is asked, and an erasure
    -- Chatwoot refused (blocked) or one still running must not be finished here behind its back.
    JOIN public.privacy_requests AS q
      ON q.tenant_id = t.tenant_id AND q.id = t.request_id AND q.state = 'completed'
    JOIN public.customer_principals AS cp
      ON cp.tenant_id = t.tenant_id AND cp.id = t.principal_id
    WHERE cp.erased_at IS NULL
  LOOP
    IF app.erase_principal(e.tenant_id, e.principal_id) IN ('deleted', 'anonymised') THEN
      erased := erased + 1;
      INSERT INTO public.outbox_events (id, tenant_id, topic, aggregate_type, aggregate_id, payload)
      VALUES (gen_random_uuid(), e.tenant_id, 'privacy.replay', 'erasure_tombstone', e.id::text,
              jsonb_build_object('tombstoneId', e.id));
    END IF;
  END LOOP;
  RETURN erased;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.apply_erasure_tombstones() OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.apply_erasure_tombstones() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.apply_erasure_tombstones() TO hamnivo_app;
--> statement-breakpoint
-- Export files keep their bytes 24 hours.
CREATE FUNCTION app.purge_privacy_files(p_batch integer DEFAULT 100)
  RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  lim integer := least(greatest(p_batch, 1), 1000);
  cleared bigint;
BEGIN
  UPDATE public.privacy_files AS f SET raw = NULL
  FROM (
    SELECT x.tenant_id, x.id FROM public.privacy_files AS x
    WHERE x.purge_after < now() AND x.raw IS NOT NULL
    ORDER BY x.purge_after LIMIT lim
  ) AS d
  WHERE f.tenant_id = d.tenant_id AND f.id = d.id;
  GET DIAGNOSTICS cleared = ROW_COUNT;
  RETURN cleared;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.purge_privacy_files(integer) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.purge_privacy_files(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.purge_privacy_files(integer) TO hamnivo_app;
