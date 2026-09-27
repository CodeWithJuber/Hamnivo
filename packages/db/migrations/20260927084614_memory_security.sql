-- Customer memory: forced RLS on the new tables; consent decisions and tombstones are
-- append-only and deletion receipts are never deleted; memory content is never overwritten (a
-- correction supersedes it); a tombstoned record can never be written again; and two audited
-- cross-tenant functions for the worker and for restores.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON learning_consents, deletion_tombstones FROM hamnivo_app;
--> statement-breakpoint
REVOKE DELETE ON memory_deletions FROM hamnivo_app;
--> statement-breakpoint
-- Only lifecycle columns change: status, review, validity end, links to the next version and
-- confirmation times. A value under review may still be numbered and linked when confirmed.
-- The tenant is left to row-level security, which refuses moves between tenants.
CREATE FUNCTION app.memory_records_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
    OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
    OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.scope IS DISTINCT FROM OLD.scope
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.key IS DISTINCT FROM OLD.key
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.source_type IS DISTINCT FROM OLD.source_type
    OR NEW.source_event_ids IS DISTINCT FROM OLD.source_event_ids
    OR NEW.evidence_status IS DISTINCT FROM OLD.evidence_status
    OR NEW.written_by_type IS DISTINCT FROM OLD.written_by_type
    OR NEW.written_by_id IS DISTINCT FROM OLD.written_by_id
    OR NEW.write_reason IS DISTINCT FROM OLD.write_reason
    OR NEW.write_note IS DISTINCT FROM OLD.write_note
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.allowed_purposes IS DISTINCT FROM OLD.allowed_purposes
    OR NEW.allowed_roles IS DISTINCT FROM OLD.allowed_roles
    OR NEW.sensitivity IS DISTINCT FROM OLD.sensitivity
    OR NEW.retention_class IS DISTINCT FROM OLD.retention_class
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
    OR NEW.confidence IS DISTINCT FROM OLD.confidence
    OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
    OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
    OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
    OR (OLD.status <> 'pending' AND (
         NEW.version IS DISTINCT FROM OLD.version
      OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id)) THEN
    RAISE EXCEPTION 'memory records are never overwritten; write a correction that supersedes them'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('superseded', 'outdated') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a superseded or outdated memory cannot become current again'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'pending' THEN
    RAISE EXCEPTION 'a current memory cannot go back to review' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER memory_records_guard BEFORE UPDATE ON memory_records
  FOR EACH ROW EXECUTE FUNCTION app.memory_records_guard();
--> statement-breakpoint
-- Replays, retried jobs and re-imports cannot bring back a deleted record, nor anything observed
-- before a customer's memory was erased.
CREATE FUNCTION app.memory_records_tombstone_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF EXISTS (
    SELECT FROM public.deletion_tombstones AS t
    WHERE t.tenant_id = NEW.tenant_id
      AND ((t.target_type = 'memory_record' AND t.target_id = NEW.id)
        OR (t.target_type = 'memory_subject' AND t.target_id = NEW.subject_id
            AND t.observed_at >= NEW.observed_at))
  ) THEN
    RAISE EXCEPTION 'this memory was deleted and cannot be written again'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER memory_records_tombstone_guard BEFORE INSERT ON memory_records
  FOR EACH ROW EXECUTE FUNCTION app.memory_records_tombstone_guard();
--> statement-breakpoint
GRANT SELECT (tenant_id, id, subject_id, brand_id, observed_at, expires_at), DELETE
  ON memory_records TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (tenant_id, target_type, target_id, observed_at) ON deletion_tombstones
  TO hamnivo_resolver;
--> statement-breakpoint
-- Customers with memory past its retention, across tenants. The worker deletes it inside each
-- tenant with the normal deletion path (receipt, tombstones, purge).
CREATE FUNCTION app.expired_memory_subjects(p_limit integer)
  RETURNS TABLE (tenant_id uuid, subject_id uuid, brand_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT DISTINCT r.tenant_id, r.subject_id, r.brand_id
    FROM public.memory_records AS r
    WHERE r.expires_at IS NOT NULL AND r.expires_at <= now()
    LIMIT least(greatest(p_limit, 1), 1000)
  $$;
--> statement-breakpoint
ALTER FUNCTION app.expired_memory_subjects(integer) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.expired_memory_subjects(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.expired_memory_subjects(integer) TO hamnivo_app;
--> statement-breakpoint
-- Replays deletion tombstones: removes any memory record they cover, and its vectors (by
-- cascade). Run it after a restore, before the API serves requests; the worker also runs it
-- daily. Idempotent. Returns how many records it removed.
CREATE FUNCTION app.apply_memory_tombstones()
  RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM public.memory_records AS r
  USING public.deletion_tombstones AS t
  WHERE t.tenant_id = r.tenant_id
    AND ((t.target_type = 'memory_record' AND t.target_id = r.id)
      OR (t.target_type = 'memory_subject' AND t.target_id = r.subject_id
          AND r.observed_at <= t.observed_at));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app.apply_memory_tombstones() OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.apply_memory_tombstones() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.apply_memory_tombstones() TO hamnivo_app;
