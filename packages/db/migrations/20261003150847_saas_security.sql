-- Running Hamnivo as a SaaS: forced RLS on the new tables, the two global platform tables kept
-- from the application role, append-only billing events, the default free plan, and the audited
-- functions that work before a tenant is known: plans for assignment, the workspace behind a
-- billing reference, trials and grace periods that ended, and invitations at sign-up.
SELECT app.harden_tenant_tables();
--> statement-breakpoint
-- ── Global platform tables ──────────────────────────────────────────────────────────────────
-- Platform settings (the sign-up switch) and operator API keys are the platform operator's. The
-- application role has no access; the platform role manages them. Keys are revoked, not deleted.
REVOKE ALL ON platform_settings, operator_api_keys FROM hamnivo_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform_settings, operator_api_keys TO hamnivo_platform;
--> statement-breakpoint
-- The platform console reads billing state and Chatwoot set-up progress (platform_read).
GRANT SELECT ON billing_accounts, chatwoot_provisioning TO hamnivo_platform;
--> statement-breakpoint
-- ── Append-only and never-deleted tenant tables ─────────────────────────────────────────────
-- A billing event is a record of what a provider said and what billing did with it. A billing
-- account changes state but is never deleted: it links the workspace to the provider's records.
REVOKE UPDATE, DELETE, TRUNCATE ON billing_events FROM hamnivo_app;
--> statement-breakpoint
REVOKE DELETE ON billing_accounts FROM hamnivo_app;
--> statement-breakpoint
-- ── The default plan ────────────────────────────────────────────────────────────────────────
-- New workspaces start on `free` (HAMNIVO_DEFAULT_PLAN). The operator may change its limits with
-- `billing plan:set`; an existing plan with this key is left as it is.
INSERT INTO plans (id, key, name, currency, price_minor, limits, metered, trial_days)
VALUES (
  gen_random_uuid(), 'free', 'Free', 'USD', 0,
  '{"conversations": 100, "aiReplies": 200, "aiTokens": 500000, "knowledgeStorageBytes": 26214400, "seats": 2, "webhookEndpoints": 1}'::jsonb,
  '[]'::jsonb, 0)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- ── Plans for assignment ────────────────────────────────────────────────────────────────────
-- A workspace gets a copy of a plan when it is created, when a trial or grace period ends and
-- when a provider reports a subscription; those writes run in the workspace as hamnivo_app.
GRANT SELECT (key, name, currency, price_minor, limits, metered, status, trial_days, stripe_price_id)
  ON plans TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.active_plans()
  RETURNS TABLE (
    key text, name text, currency text, price_minor bigint, limits jsonb, metered jsonb,
    trial_days integer, stripe_price_id text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT p.key::text, p.name, p.currency, p.price_minor, p.limits, p.metered, p.trial_days,
           p.stripe_price_id
    FROM public.plans AS p
    WHERE p.status = 'active'
    ORDER BY p.price_minor, p.key
  $$;
--> statement-breakpoint
-- ── The workspace behind a billing reference ────────────────────────────────────────────────
-- A provider's webhook names its customer or subscription, not the workspace. The subscription
-- wins over the customer when both are given.
GRANT SELECT (tenant_id, provider, customer_ref, subscription_ref, grace_ends_at)
  ON billing_accounts TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.billing_account_tenant(
  p_provider text, p_customer_ref text, p_subscription_ref text)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT a.tenant_id
    FROM public.billing_accounts AS a
    WHERE a.provider = p_provider
      AND ((p_subscription_ref IS NOT NULL AND a.subscription_ref = p_subscription_ref)
        OR (p_customer_ref IS NOT NULL AND a.customer_ref = p_customer_ref))
    ORDER BY (a.subscription_ref IS NOT DISTINCT FROM p_subscription_ref) DESC
    LIMIT 1
  $$;
--> statement-breakpoint
-- ── Trials and grace periods that ended ─────────────────────────────────────────────────────
-- The worker moves these workspaces to the free plan, each inside its own tenant.
GRANT SELECT (tenant_id, trial_ends_at) ON tenant_entitlements TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.lapsed_billing(p_now timestamptz, p_limit integer)
  RETURNS TABLE (tenant_id uuid, reason text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    (SELECT e.tenant_id, 'trial_ended'::text
     FROM public.tenant_entitlements AS e
     WHERE e.trial_ends_at IS NOT NULL AND e.trial_ends_at <= p_now
     ORDER BY e.trial_ends_at
     LIMIT least(greatest(p_limit, 1), 500))
    UNION ALL
    (SELECT a.tenant_id, 'grace_ended'::text
     FROM public.billing_accounts AS a
     WHERE a.grace_ends_at IS NOT NULL AND a.grace_ends_at <= p_now
     ORDER BY a.grace_ends_at
     LIMIT least(greatest(p_limit, 1), 500))
  $$;
--> statement-breakpoint
-- ── Sign-up while public sign-up is off ─────────────────────────────────────────────────────
-- Someone invited to a workspace may still create their account; the first account and the
-- first workspace of a new server are always allowed.
GRANT SELECT (email) ON invitations TO hamnivo_resolver;
--> statement-breakpoint
CREATE FUNCTION app.invitation_pending_for(p_email text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.invitations AS i
      WHERE i.email = p_email::citext AND i.status = 'pending' AND i.expires_at > now()
    )
  $$;
--> statement-breakpoint
CREATE FUNCTION app.tenants_exist() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$ SELECT EXISTS (SELECT 1 FROM public.tenants AS t WHERE t.id IS NOT NULL) $$;
--> statement-breakpoint
DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.active_plans()',
    'app.billing_account_tenant(text, text, text)',
    'app.lapsed_billing(timestamptz, integer)',
    'app.invitation_pending_for(text)',
    'app.tenants_exist()'
  ]::regprocedure[] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO hamnivo_resolver', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hamnivo_app', fn);
  END LOOP;
END
$$;
--> statement-breakpoint
SELECT app.harden_tenant_tables();
