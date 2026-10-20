-- Provider attempts are tenant-owned. A reservation is held before a managed call and
-- settled with the provider's measured tokens. BYOK attempts are visible but do not
-- consume the platform-managed token budget.
CREATE TABLE ai_credit_rates (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  model_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  input_milli_credits integer NOT NULL CHECK (input_milli_credits >= 0),
  output_milli_credits integer NOT NULL CHECK (output_milli_credits >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_credit_rates_provider_model_version_key UNIQUE (provider, model_id, version)
);
--> statement-breakpoint
CREATE UNIQUE INDEX ai_credit_rates_active_key ON ai_credit_rates(provider, model_id) WHERE active;
--> statement-breakpoint
CREATE POLICY platform_manage ON ai_credit_rates TO hamnivo_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY app_read ON ai_credit_rates FOR SELECT TO hamnivo_app USING (true);
--> statement-breakpoint
ALTER TABLE ai_credit_rates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_credit_rates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON ai_credit_rates TO hamnivo_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_credit_rates TO hamnivo_platform;
--> statement-breakpoint
-- A neutral default expresses 1 token = 1 credit; operators can replace it with
-- provider/model-specific versions. No currency or provider price is implied.
INSERT INTO ai_credit_rates (id, provider, model_id, version, input_milli_credits, output_milli_credits)
VALUES ('8aca037d-22b1-448f-a115-d788461df747', '*', '*', 1, 1000, 1000);
--> statement-breakpoint
CREATE TABLE ai_credit_attempts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL CONSTRAINT ai_credit_attempts_tenant_id_tenants_id_fk REFERENCES tenants(id),
  payer_tenant_id uuid NOT NULL CONSTRAINT ai_credit_attempts_payer_tenant_id_tenants_id_fk REFERENCES tenants(id),
  attempt_key text NOT NULL,
  source text NOT NULL CHECK (source IN ('managed', 'byok')),
  status text NOT NULL CHECK (status IN ('reserved', 'settled', 'released', 'expired')),
  provider text NOT NULL,
  model_id text NOT NULL,
  connection_id uuid,
  period_key text NOT NULL,
  rate_id uuid CONSTRAINT ai_credit_attempts_rate_id_ai_credit_rates_id_fk REFERENCES ai_credit_rates(id),
  rate_version integer,
  reserved_tokens bigint NOT NULL DEFAULT 0 CONSTRAINT ai_credit_attempts_reserved_ck CHECK (reserved_tokens >= 0),
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  credits_milli bigint NOT NULL DEFAULT 0 CHECK (credits_milli >= 0),
  attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  lease_token uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (tenant_id, id),
  CONSTRAINT ai_credit_attempts_connection_fk FOREIGN KEY (tenant_id, connection_id) REFERENCES model_connections(tenant_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX ai_credit_attempts_tenant_attempt_key ON ai_credit_attempts(tenant_id, attempt_key);
--> statement-breakpoint
CREATE INDEX ai_credit_attempts_period_idx ON ai_credit_attempts(tenant_id, period_key, source, status);
--> statement-breakpoint
CREATE INDEX ai_credit_attempts_expiry_idx ON ai_credit_attempts(tenant_id, expires_at) WHERE status = 'reserved';
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ai_credit_attempts TO hamnivo_app
  USING (tenant_id = (SELECT app.current_tenant()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant()));
--> statement-breakpoint
CREATE POLICY platform_read ON ai_credit_attempts FOR SELECT TO hamnivo_platform USING (true);
--> statement-breakpoint
ALTER TABLE ai_credit_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_credit_attempts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_credit_attempts TO hamnivo_app;
--> statement-breakpoint
GRANT SELECT ON ai_credit_attempts TO hamnivo_platform;
--> statement-breakpoint
CREATE INDEX ai_credit_attempts_payer_period_idx ON ai_credit_attempts(payer_tenant_id, period_key, status);
--> statement-breakpoint
GRANT SELECT ON ai_credit_attempts, usage_entries, tenant_entitlements TO hamnivo_resolver;
--> statement-breakpoint
GRANT SELECT (id), UPDATE (id) ON tenants TO hamnivo_resolver;
--> statement-breakpoint
-- All callers sharing a funded agency serialize on the same payer row. This function
-- accepts no tenant ID, exposes no balances and cannot be used to lock arbitrary tenants.
CREATE FUNCTION app.lock_ai_payer() RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE payer uuid;
BEGIN
  IF app.current_tenant() IS NULL THEN RAISE EXCEPTION 'Tenant context required'; END IF;
  payer := app.ai_payer_tenant();
  PERFORM id FROM public.tenants WHERE id = payer FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI payer not found'; END IF;
  RETURN payer;
END $$;
--> statement-breakpoint
ALTER FUNCTION app.lock_ai_payer() OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lock_ai_payer() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lock_ai_payer() TO hamnivo_app;
--> statement-breakpoint
-- Only an allow/deny decision leaves the payer's RLS boundary. Existing usage of the
-- payer and measured child usage share the same allowance. Unknown/expired calls keep
-- their reservations: lease expiry is not proof that a provider did not bill the call.
CREATE FUNCTION app.ai_payer_allows(requested bigint, period_start timestamptz, period_end timestamptz, period_key text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE payer uuid; plan_limit numeric; budget numeric; consumed numeric; held numeric;
BEGIN
  IF requested < 0 OR requested IS NULL OR period_start IS NULL OR period_end IS NULL OR period_key IS NULL THEN
    RAISE EXCEPTION 'Invalid AI allowance request';
  END IF;
  payer := app.lock_ai_payer();
  SELECT CASE WHEN plan_key IS NOT NULL AND jsonb_typeof(limits->'aiTokens') = 'number'
      AND (limits->>'aiTokens')::numeric >= 0 THEN (limits->>'aiTokens')::numeric ELSE NULL END,
    ai_token_budget INTO plan_limit, budget FROM public.tenant_entitlements WHERE tenant_id = payer;
  SELECT coalesce(sum(quantity), 0) INTO consumed FROM public.usage_entries
    WHERE tenant_id = payer AND meter IN ('ai.tokens.input','ai.tokens.output')
      AND occurred_at >= period_start AND occurred_at < period_end;
  SELECT consumed + coalesce(sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)),0)
    INTO consumed FROM public.ai_credit_attempts a
    WHERE a.payer_tenant_id = payer AND a.tenant_id <> payer AND a.source = 'managed'
      AND a.period_key = ai_payer_allows.period_key;
  SELECT coalesce(sum(reserved_tokens),0) INTO held FROM public.ai_credit_attempts a
    WHERE a.payer_tenant_id = payer AND a.source = 'managed'
      AND a.status IN ('reserved','expired') AND a.period_key = ai_payer_allows.period_key;
  RETURN (plan_limit IS NULL OR consumed + held + requested <= plan_limit)
     AND (budget IS NULL OR consumed + held + requested <= budget);
END $$;
--> statement-breakpoint
ALTER FUNCTION app.ai_payer_allows(bigint, timestamptz, timestamptz, text) OWNER TO hamnivo_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_payer_allows(bigint, timestamptz, timestamptz, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_payer_allows(bigint, timestamptz, timestamptz, text) TO hamnivo_app;
--> statement-breakpoint
-- A settled receipt always uses the pricing version selected before the call. Operators
-- publish a new version to change units; they may only toggle active on an existing rate.
CREATE FUNCTION app.ai_credit_rate_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.id, NEW.provider, NEW.model_id, NEW.version, NEW.input_milli_credits, NEW.output_milli_credits)
    IS DISTINCT FROM (OLD.id, OLD.provider, OLD.model_id, OLD.version, OLD.input_milli_credits, OLD.output_milli_credits) THEN
    RAISE EXCEPTION 'AI credit rate versions are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_credit_rate_immutable() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER ai_credit_rate_immutable BEFORE UPDATE ON ai_credit_rates
FOR EACH ROW EXECUTE FUNCTION app.ai_credit_rate_immutable();
