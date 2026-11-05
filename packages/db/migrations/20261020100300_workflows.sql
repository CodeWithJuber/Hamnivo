-- Readable durable workflows and private A2A specialist connections. Legacy automations stay intact.
CREATE TABLE workflows (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL CONSTRAINT workflows_tenant_id_tenants_id_fk REFERENCES tenants(id), brand_id uuid NOT NULL,
 name text NOT NULL CONSTRAINT workflows_name_ck CHECK(char_length(name) BETWEEN 1 AND 80), enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CONSTRAINT workflows_revision_ck CHECK(revision>0), draft jsonb NOT NULL, published_version_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), CONSTRAINT workflows_brand_id_id_key UNIQUE(tenant_id,brand_id,id), CONSTRAINT workflows_brand_fk FOREIGN KEY(tenant_id,brand_id) REFERENCES brands(tenant_id,id)
);
CREATE TABLE workflow_versions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL CONSTRAINT workflow_versions_tenant_id_tenants_id_fk REFERENCES tenants(id), workflow_id uuid NOT NULL,
 version integer NOT NULL CONSTRAINT workflow_versions_number_ck CHECK(version>0), name text NOT NULL, definition jsonb NOT NULL,
 published_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), CONSTRAINT workflow_versions_workflow_id_id_key UNIQUE(tenant_id,workflow_id,id),
 CONSTRAINT workflow_versions_workflow_fk FOREIGN KEY(tenant_id,workflow_id) REFERENCES workflows(tenant_id,id)
);
ALTER TABLE workflows ADD CONSTRAINT workflows_published_version_fk FOREIGN KEY(tenant_id,id,published_version_id) REFERENCES workflow_versions(tenant_id,workflow_id,id);
CREATE UNIQUE INDEX workflow_versions_number_key ON workflow_versions(tenant_id,workflow_id,version);
CREATE TABLE a2a_connections (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL CONSTRAINT a2a_connections_tenant_id_tenants_id_fk REFERENCES tenants(id), brand_id uuid NOT NULL, name text NOT NULL,
 endpoint text NOT NULL, credential_secret_id uuid, enabled boolean NOT NULL DEFAULT true,
 timeout_seconds integer NOT NULL DEFAULT 15 CONSTRAINT a2a_connections_timeout_ck CHECK(timeout_seconds BETWEEN 1 AND 30), protocol_version text NOT NULL DEFAULT '1.0' CONSTRAINT a2a_connections_protocol_ck CHECK(protocol_version='1.0'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), CONSTRAINT a2a_connections_brand_fk FOREIGN KEY(tenant_id,brand_id) REFERENCES brands(tenant_id,id),
 CONSTRAINT a2a_connections_secret_fk FOREIGN KEY(tenant_id,credential_secret_id) REFERENCES secrets(tenant_id,id)
);
CREATE TABLE workflow_runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL CONSTRAINT workflow_runs_tenant_id_tenants_id_fk REFERENCES tenants(id), brand_id uuid NOT NULL, workflow_id uuid NOT NULL,
 version_id uuid NOT NULL, conversation_id uuid NOT NULL, runtime_run_id uuid NOT NULL, agent_id uuid NOT NULL, agent_version_id uuid NOT NULL,
 event_key text NOT NULL, epoch bigint NOT NULL,
 state text NOT NULL DEFAULT 'queued' CONSTRAINT workflow_runs_state_ck CHECK(state IN ('queued','running','waiting','awaiting_approval','completed','cancelled','handed_off','failed')),
 current_step_id text, reason text, facts jsonb NOT NULL DEFAULT '{}',
 steps_used integer NOT NULL DEFAULT 0, delegations_used integer NOT NULL DEFAULT 0,
 CONSTRAINT workflow_runs_counters_ck CHECK(steps_used BETWEEN 0 AND 100 AND delegations_used BETWEEN 0 AND 8),
 untrusted_context boolean NOT NULL DEFAULT false, wake_at timestamptz, deadline timestamptz NOT NULL,
 lease_token uuid, lease_until timestamptz, cancel_requested_at timestamptz,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(tenant_id,id),
 CONSTRAINT workflow_runs_workflow_fk FOREIGN KEY(tenant_id,brand_id,workflow_id) REFERENCES workflows(tenant_id,brand_id,id),
 CONSTRAINT workflow_runs_version_fk FOREIGN KEY(tenant_id,workflow_id,version_id) REFERENCES workflow_versions(tenant_id,workflow_id,id),
 CONSTRAINT workflow_runs_conversation_fk FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversation_controls(tenant_id,id),
 CONSTRAINT workflow_runs_runtime_fk FOREIGN KEY(tenant_id,runtime_run_id) REFERENCES runs(tenant_id,id),
 CONSTRAINT workflow_runs_agent_fk FOREIGN KEY(tenant_id,agent_id) REFERENCES agent_profiles(tenant_id,id),
 CONSTRAINT workflow_runs_agent_version_fk FOREIGN KEY(tenant_id,agent_version_id) REFERENCES agent_versions(tenant_id,id)
);
CREATE UNIQUE INDEX workflow_runs_event_key ON workflow_runs(tenant_id,workflow_id,conversation_id,event_key);
CREATE INDEX workflow_runs_due_idx ON workflow_runs(tenant_id,state,wake_at);
CREATE TABLE workflow_run_steps (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL CONSTRAINT workflow_run_steps_tenant_id_tenants_id_fk REFERENCES tenants(id), run_id uuid NOT NULL, step_id text NOT NULL, type text NOT NULL,
 state text NOT NULL CONSTRAINT workflow_run_steps_state_ck CHECK(state IN ('running','waiting','awaiting_approval','completed','failed','unknown')),
 action_id uuid, summary text, result jsonb, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 CONSTRAINT workflow_run_steps_run_fk FOREIGN KEY(tenant_id,run_id) REFERENCES workflow_runs(tenant_id,id),
 CONSTRAINT workflow_run_steps_action_fk FOREIGN KEY(tenant_id,action_id) REFERENCES actions(tenant_id,id)
);
CREATE UNIQUE INDEX workflow_run_steps_once_key ON workflow_run_steps(tenant_id,run_id,step_id);
-- Published definitions are immutable even to application code using an accidental UPDATE.
CREATE FUNCTION app.immutable_workflow_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published workflow versions are immutable'; END $$;
CREATE TRIGGER workflow_versions_immutable BEFORE UPDATE OR DELETE ON workflow_versions FOR EACH ROW EXECUTE FUNCTION app.immutable_workflow_version();
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['workflows','workflow_versions','a2a_connections','workflow_runs','workflow_run_steps'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I TO hamnivo_app USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()))',tab);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hamnivo_app',tab);
 END LOOP;
END $$;
