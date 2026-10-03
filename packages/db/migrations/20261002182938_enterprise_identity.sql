CREATE TABLE "platform_audit_events" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"operator_id" uuid,
	"action" text NOT NULL,
	"tenant_id" uuid,
	"target_type" text,
	"target_id" text,
	"outcome" text NOT NULL,
	"reason" text,
	"request_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" "bytea" NOT NULL,
	"hash" "bytea" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "platform_audit_head" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"last_hash" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_audit_head_single_ck" CHECK ("platform_audit_head"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "platform_audit_head" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "platform_incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_by" uuid,
	"resolved_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_incidents_resolved_ck" CHECK (("platform_incidents"."status" = 'resolved') = ("platform_incidents"."resolved_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "platform_incidents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "platform_operators" (
	"id" uuid PRIMARY KEY NOT NULL,
	"auth_user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"email" "citext" NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_operators" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"protocol" text DEFAULT 'oidc' NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_id" uuid NOT NULL,
	"authorization_endpoint" text NOT NULL,
	"token_endpoint" text NOT NULL,
	"jwks_endpoint" text NOT NULL,
	"userinfo_endpoint" text,
	"token_endpoint_auth" text DEFAULT 'client_secret_basic' NOT NULL,
	"scopes" text[] DEFAULT '{openid,email,profile}'::text[] NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"sso_only" boolean DEFAULT false NOT NULL,
	"jit_role_id" uuid,
	"jit_granted_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_connections_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "sso_connections_jit_ck" CHECK (("sso_connections"."jit_role_id" is null) = ("sso_connections"."jit_granted_by" is null)),
	CONSTRAINT "sso_connections_sso_only_ck" CHECK (not "sso_connections"."sso_only" or "sso_connections"."status" = 'active')
);
--> statement-breakpoint
ALTER TABLE "sso_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_domains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"domain" "citext" NOT NULL,
	"verification_token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_check_result" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_domains_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "sso_domains_domain_ck" CHECK ("sso_domains"."domain"::text = lower("sso_domains"."domain"::text) and length("sso_domains"."domain"::text) between 3 and 253 and position('.' in "sso_domains"."domain"::text) > 1)
);
--> statement-breakpoint
ALTER TABLE "sso_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "role_definitions" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_grants" ADD COLUMN "operator_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_grants" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_grants" ADD COLUMN "declined_by" uuid;--> statement-breakpoint
ALTER TABLE "support_grants" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_grants" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "support_grants" ADD COLUMN "duration_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "support_grants" ADD COLUMN "requested_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "support_grants" ADD COLUMN "revoked_by" uuid;--> statement-breakpoint
ALTER TABLE "support_grants" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_operator_id_platform_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."platform_operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_incidents" ADD CONSTRAINT "platform_incidents_created_by_platform_operators_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."platform_operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_incidents" ADD CONSTRAINT "platform_incidents_resolved_by_platform_operators_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."platform_operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_domain_fk" FOREIGN KEY ("tenant_id","domain_id") REFERENCES "public"."sso_domains"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_secret_fk" FOREIGN KEY ("tenant_id","client_secret_id") REFERENCES "public"."secrets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_jit_role_fk" FOREIGN KEY ("tenant_id","jit_role_id") REFERENCES "public"."role_definitions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_jit_granted_by_fk" FOREIGN KEY ("tenant_id","jit_granted_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_domains" ADD CONSTRAINT "sso_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_domains" ADD CONSTRAINT "sso_domains_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_audit_events_time_idx" ON "platform_audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "platform_audit_events_tenant_idx" ON "platform_audit_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "platform_incidents_active_idx" ON "platform_incidents" USING btree ("started_at") WHERE "platform_incidents"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "platform_operators_auth_user_key" ON "platform_operators" USING btree ("auth_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_connections_provider_key" ON "sso_connections" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_connections_domain_key" ON "sso_connections" USING btree ("tenant_id","domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_domains_domain_key" ON "sso_domains" USING btree ("tenant_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_domains_verified_key" ON "sso_domains" USING btree ("domain") WHERE "sso_domains"."verified_at" is not null;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_declined_by_fk" FOREIGN KEY ("tenant_id","declined_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_revoked_by_fk" FOREIGN KEY ("tenant_id","revoked_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("tenant_id","actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("tenant_id","action");--> statement-breakpoint
CREATE INDEX "support_grants_active_idx" ON "support_grants" USING btree ("tenant_id","expires_at") WHERE "support_grants"."status" = 'approved' and "support_grants"."revoked_at" is null and "support_grants"."ended_at" is null;--> statement-breakpoint
ALTER TABLE "role_definitions" ADD CONSTRAINT "role_definitions_archive_ck" CHECK (not ("role_definitions"."is_preset" and "role_definitions"."archived_at" is not null));--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_decision_ck" CHECK (("support_grants"."status" = 'approved') = ("support_grants"."approved_by" is not null)
        and ("support_grants"."status" = 'declined') = ("support_grants"."declined_by" is not null)
        and ("support_grants"."status" = 'pending') = ("support_grants"."decided_at" is null));--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_duration_ck" CHECK ("support_grants"."duration_minutes" between 5 and 1440 and cardinality("support_grants"."scopes") > 0);--> statement-breakpoint
CREATE POLICY "platform_request" ON "support_grants" AS PERMISSIVE FOR INSERT TO "hamnivo_platform" WITH CHECK ("support_grants"."status" = 'pending' and "support_grants"."approved_by" is null and "support_grants"."declined_by" is null and "support_grants"."revoked_at" is null and "support_grants"."ended_at" is null);--> statement-breakpoint
CREATE POLICY "platform_end" ON "support_grants" AS PERMISSIVE FOR UPDATE TO "hamnivo_platform" USING ("support_grants"."status" = 'approved') WITH CHECK ("support_grants"."status" = 'approved');--> statement-breakpoint
CREATE POLICY "platform_read" ON "outbox_events" AS PERMISSIVE FOR SELECT TO "hamnivo_platform" USING (true);--> statement-breakpoint
CREATE POLICY "platform_read" ON "kill_switches" AS PERMISSIVE FOR SELECT TO "hamnivo_platform" USING (true);--> statement-breakpoint
CREATE POLICY "platform_read" ON "model_connections" AS PERMISSIVE FOR SELECT TO "hamnivo_platform" USING (true);--> statement-breakpoint
CREATE POLICY "platform_read" ON "platform_audit_events" AS PERMISSIVE FOR SELECT TO "hamnivo_platform" USING (true);--> statement-breakpoint
CREATE POLICY "platform_append" ON "platform_audit_events" AS PERMISSIVE FOR INSERT TO "hamnivo_platform" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "owner_read" ON "platform_audit_events" AS PERMISSIVE FOR SELECT TO "hamnivo_owner" USING (true);--> statement-breakpoint
CREATE POLICY "owner_append" ON "platform_audit_events" AS PERMISSIVE FOR INSERT TO "hamnivo_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "platform_chain" ON "platform_audit_head" AS PERMISSIVE FOR ALL TO "hamnivo_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "owner_chain" ON "platform_audit_head" AS PERMISSIVE FOR ALL TO "hamnivo_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "platform_manage" ON "platform_incidents" AS PERMISSIVE FOR ALL TO "hamnivo_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "platform_read" ON "platform_operators" AS PERMISSIVE FOR SELECT TO "hamnivo_platform" USING (true);--> statement-breakpoint
CREATE POLICY "owner_manage" ON "platform_operators" AS PERMISSIVE FOR ALL TO "hamnivo_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sso_connections" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sso_domains" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));