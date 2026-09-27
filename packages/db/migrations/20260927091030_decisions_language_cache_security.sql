-- Decisions, language and cache: forced RLS on the new tables; published decision rubrics and
-- decision records keep their history; cache dependency versions rise with the data they depend
-- on, in the same transaction as the change (K07).
SELECT app.harden_tenant_tables();
--> statement-breakpoint
CREATE FUNCTION app.decision_rubrics_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' THEN
      RAISE EXCEPTION 'published decision rubrics cannot be deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  -- Moving a row to another tenant is left to row-level security.
  IF OLD.state <> 'draft' AND (
       NEW.definition IS DISTINCT FROM OLD.definition
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.model_version IS DISTINCT FROM OLD.model_version
    OR NEW.deadline_ms IS DISTINCT FROM OLD.deadline_ms
    OR NEW.config_hash IS DISTINCT FROM OLD.config_hash
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.task IS DISTINCT FROM OLD.task
    OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
    OR NEW.published_by IS DISTINCT FROM OLD.published_by
    OR NEW.state = 'draft') THEN
    RAISE EXCEPTION 'published decision rubrics are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER decision_rubrics_guard BEFORE UPDATE OR DELETE ON decision_rubrics
  FOR EACH ROW EXECUTE FUNCTION app.decision_rubrics_guard();
--> statement-breakpoint
-- A decision record is written once. Only applying it and reviewing it may change it later.
CREATE FUNCTION app.decision_records_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  mutable constant text[] := ARRAY['tenant_id', 'applied', 'applied_at', 'reviewed_intent',
    'review_reason', 'reviewed_by', 'reviewed_at', 'training_consent'];
BEGIN
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'decision records are append-only; only applying and reviewing may change them'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER decision_records_guard BEFORE UPDATE ON decision_records
  FOR EACH ROW EXECUTE FUNCTION app.decision_records_guard();
--> statement-breakpoint
REVOKE DELETE ON decision_records FROM hamnivo_app;
--> statement-breakpoint
-- Raises the version of one cache dependency of the current tenant (row-level security applies).
CREATE FUNCTION app.bump_cache_dependency(p_tenant uuid, p_dependency text) RETURNS void
  LANGUAGE sql
  SET search_path = pg_catalog, public
  AS $$
  INSERT INTO public.cache_dependency_versions AS d (id, tenant_id, dependency, version)
  VALUES (gen_random_uuid(), p_tenant, p_dependency, 1)
  ON CONFLICT (tenant_id, dependency)
  DO UPDATE SET version = d.version + 1, updated_at = now();
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bump_cache_dependency(uuid, text) TO hamnivo_app;
--> statement-breakpoint
CREATE FUNCTION app.cache_bump_row() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  target record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target := OLD;
  ELSE
    target := NEW;
  END IF;
  -- Each branch reads only the columns its table has.
  IF TG_TABLE_NAME = 'knowledge_documents' THEN
    PERFORM app.bump_cache_dependency(target.tenant_id, 'knowledge:source:' || target.source_id);
    -- A document moved to another source changes both.
    IF TG_OP = 'UPDATE' THEN
      IF OLD.source_id IS DISTINCT FROM NEW.source_id THEN
        PERFORM app.bump_cache_dependency(OLD.tenant_id, 'knowledge:source:' || OLD.source_id);
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'knowledge_sources' THEN
    PERFORM app.bump_cache_dependency(target.tenant_id, 'knowledge:source:' || target.id);
  ELSIF TG_TABLE_NAME = 'agent_profiles' THEN
    PERFORM app.bump_cache_dependency(target.tenant_id, 'agent:' || target.id);
  ELSIF TG_TABLE_NAME = 'brands' THEN
    PERFORM app.bump_cache_dependency(target.tenant_id, 'brand:' || target.id);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER knowledge_sources_cache
  AFTER UPDATE OF status, visibility, brand_id, review_every_days OR DELETE ON knowledge_sources
  FOR EACH ROW EXECUTE FUNCTION app.cache_bump_row();
--> statement-breakpoint
CREATE TRIGGER knowledge_documents_cache
  AFTER UPDATE OF current_version_id, status, source_id, title, url OR DELETE ON knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION app.cache_bump_row();
--> statement-breakpoint
CREATE TRIGGER agent_profiles_cache
  AFTER UPDATE OF published_version_id, status, is_default ON agent_profiles
  FOR EACH ROW EXECUTE FUNCTION app.cache_bump_row();
--> statement-breakpoint
CREATE TRIGGER brands_cache AFTER UPDATE OF name ON brands
  FOR EACH ROW EXECUTE FUNCTION app.cache_bump_row();
