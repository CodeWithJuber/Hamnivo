-- Custom SQL migration file, put your code below! --
-- Automations (G21) take over the proactive prompts (W19). Each brand's prompts become website
-- rules, published as version 1 by Hamnivo, on or off as the prompts were; the brand keeps only
-- its prompt limits. Custom roles that could edit prompts (widget.proactive) can now read and
-- manage automations instead.
--
-- The owner is bound by forced row-level security like the application, so the two tables read
-- here are released for this transaction and forced again at the end.
ALTER TABLE brand_widget_settings NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE role_definitions NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TEMPORARY TABLE hv_moved_prompts ON COMMIT DROP AS
WITH prompts AS (
  SELECT s.tenant_id, s.brand_id, t.value AS trig, t.n,
         coalesce((s.proactive ->> 'enabled')::boolean, false) AS enabled,
         coalesce((s.proactive ->> 'onlyWhenAvailable')::boolean, false) AS only_open
  FROM brand_widget_settings AS s
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(s.proactive -> 'triggers') = 'array'
      THEN s.proactive -> 'triggers' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS t(value, n)
  WHERE jsonb_typeof(t.value -> 'message') = 'object'
)
SELECT gen_random_uuid() AS automation_id,
       gen_random_uuid() AS version_id,
       tenant_id, brand_id, enabled,
       left('Website prompt: ' || coalesce(nullif(trig ->> 'id', ''), n::text), 80) AS name,
       jsonb_build_object(
         'event', jsonb_build_object(
           'type', 'page_view',
           'seconds', least(600, greatest(0, coalesce((trig ->> 'seconds')::int, 5)))),
         'match', 'all',
         'conditions',
           CASE WHEN nullif(trig ->> 'path', '') IS NOT NULL
             THEN jsonb_build_array(jsonb_build_object(
               'field', 'page_url', 'op', 'starts_with', 'value', trig ->> 'path'))
             ELSE '[]'::jsonb END
           || CASE WHEN trig ->> 'kind' = 'returning_visitor'
             THEN jsonb_build_array(jsonb_build_object(
               'field', 'visit_count', 'op', 'at_least',
               'value', coalesce((trig ->> 'visits')::int, 2)))
             ELSE '[]'::jsonb END
           || CASE WHEN only_open
             THEN jsonb_build_array(jsonb_build_object(
               'field', 'hours_open', 'op', 'is', 'value', true))
             ELSE '[]'::jsonb END,
         'actions', jsonb_build_array(jsonb_build_object(
           'type', 'show_prompt', 'message', trig -> 'message'))
       ) AS definition
FROM prompts;
--> statement-breakpoint
INSERT INTO automations (id, tenant_id, brand_id, name, kind, enabled, draft, revision,
                         published_version_id)
SELECT automation_id, tenant_id, brand_id, name, 'visitor', enabled, definition, 1, version_id
FROM hv_moved_prompts;
--> statement-breakpoint
INSERT INTO automation_versions (id, tenant_id, automation_id, version, name, definition)
SELECT version_id, tenant_id, automation_id, 1, name, definition
FROM hv_moved_prompts;
--> statement-breakpoint
UPDATE brand_widget_settings
SET proactive = jsonb_build_object(
      'maxPerDay', least(3, greatest(1, coalesce((proactive ->> 'maxPerDay')::int, 1))),
      'dismissHours', least(168, greatest(1, coalesce((proactive ->> 'dismissHours')::int, 24)))),
    updated_at = now()
WHERE proactive <> '{}'::jsonb;
--> statement-breakpoint
UPDATE role_definitions
SET permissions = array_remove(permissions, 'widget.proactive')
                  || ARRAY['automations.read', 'automations.manage'],
    version = version + 1,
    updated_at = now()
WHERE 'widget.proactive' = ANY (permissions);
--> statement-breakpoint
SELECT app.harden_tenant_tables();
