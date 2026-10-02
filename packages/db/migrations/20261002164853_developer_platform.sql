CREATE TABLE "conversation_metrics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid,
	"inbox_id" uuid,
	"channel" text,
	"started_with" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"first_customer_message_at" timestamp with time zone,
	"first_response_at" timestamp with time zone,
	"first_response_by" text,
	"first_human_response_at" timestamp with time zone,
	"handed_off_at" timestamp with time zone,
	"handoff_reason" text,
	"human_involved" boolean DEFAULT false NOT NULL,
	"last_resolved_at" timestamp with time zone,
	"first_resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_count" integer DEFAULT 0 NOT NULL,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_metrics_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "conversation_metrics_counts_ck" CHECK ("conversation_metrics"."resolution_count" >= 0 and "conversation_metrics"."reopen_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "conversation_metrics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"period_key" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"plan_key" text NOT NULL,
	"plan_name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"lines" jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"issued_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"payment_method" text DEFAULT 'manual' NOT NULL,
	"payment_state" text DEFAULT 'none' NOT NULL,
	"payment_reference" text,
	"payment_failed_at" timestamp with time zone,
	"next_payment_retry_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoices_amounts_ck" CHECK ("invoices"."subtotal_minor" >= 0 and "invoices"."total_minor" >= 0),
	CONSTRAINT "invoices_lifecycle_ck" CHECK (("invoices"."status" in ('issued', 'paid')) <= ("invoices"."issued_at" is not null and "invoices"."due_at" is not null)
        and ("invoices"."status" = 'paid') = ("invoices"."paid_at" is not null)
        and ("invoices"."status" = 'void') = ("invoices"."voided_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" "citext" NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"price_minor" bigint NOT NULL,
	"limits" jsonb NOT NULL,
	"metered" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_price_ck" CHECK ("plans"."price_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenant_entitlements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_key" text,
	"plan_name" text,
	"currency" text,
	"price_minor" bigint,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metered" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assigned_at" timestamp with time zone,
	"assigned_by" text,
	"ai_token_budget" bigint,
	"alert_thresholds" integer[] DEFAULT '{80,100}'::integer[] NOT NULL,
	"budget_updated_at" timestamp with time zone,
	"budget_updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_entitlements_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_entitlements_plan_ck" CHECK (("tenant_entitlements"."plan_key" is null) = ("tenant_entitlements"."plan_name" is null)
        and ("tenant_entitlements"."plan_key" is null) = ("tenant_entitlements"."currency" is null)
        and ("tenant_entitlements"."plan_key" is null) = ("tenant_entitlements"."price_minor" is null)),
	CONSTRAINT "tenant_entitlements_budget_ck" CHECK ("tenant_entitlements"."ai_token_budget" is null or "tenant_entitlements"."ai_token_budget" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "usage_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"limit_key" text NOT NULL,
	"source" text NOT NULL,
	"threshold" integer NOT NULL,
	"period_key" text NOT NULL,
	"used" bigint NOT NULL,
	"max" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_alerts_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "usage_alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "egress_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"hosts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "egress_policies_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "egress_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"status_code" integer,
	"outcome" text NOT NULL,
	"error" text,
	"response_excerpt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_attempts_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "webhook_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_status_code" integer,
	"last_outcome" text,
	"succeeded_at" timestamp with time zone,
	"replay_of" uuid,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "webhook_deliveries_due_ck" CHECK (("webhook_deliveries"."status" = 'pending') = ("webhook_deliveries"."next_attempt_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"event_types" text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"disabled_reason" text,
	"disabled_at" timestamp with time zone,
	"secret_id" uuid NOT NULL,
	"previous_secret_id" uuid,
	"previous_secret_expires_at" timestamp with time zone,
	"secret_rotated_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"failing_since" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "webhook_endpoints_disabled_ck" CHECK (("webhook_endpoints"."status" = 'disabled') = ("webhook_endpoints"."disabled_reason" is not null)),
	CONSTRAINT "webhook_endpoints_events_ck" CHECK (cardinality("webhook_endpoints"."event_types") > 0)
);
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"source_key" text NOT NULL,
	"body" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "hash_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "scope_type" text DEFAULT 'tenant' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "scope_id" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "revoked_by" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "replaced_by" uuid;--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD CONSTRAINT "conversation_metrics_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD CONSTRAINT "conversation_metrics_conversation_fk" FOREIGN KEY ("tenant_id","id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD CONSTRAINT "tenant_entitlements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD CONSTRAINT "tenant_entitlements_budget_updated_by_fk" FOREIGN KEY ("tenant_id","budget_updated_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_alerts" ADD CONSTRAINT "usage_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_policies" ADD CONSTRAINT "egress_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_policies" ADD CONSTRAINT "egress_policies_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_delivery_fk" FOREIGN KEY ("tenant_id","delivery_id") REFERENCES "public"."webhook_deliveries"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_fk" FOREIGN KEY ("tenant_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_fk" FOREIGN KEY ("tenant_id","event_id") REFERENCES "public"."webhook_events"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_replay_fk" FOREIGN KEY ("tenant_id","replay_of") REFERENCES "public"."webhook_deliveries"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_secret_fk" FOREIGN KEY ("tenant_id","secret_id") REFERENCES "public"."secrets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_previous_secret_fk" FOREIGN KEY ("tenant_id","previous_secret_id") REFERENCES "public"."secrets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_metrics_created_idx" ON "conversation_metrics" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_period_key" ON "invoices" USING btree ("tenant_id","period_key") WHERE "invoices"."status" <> 'void';--> statement-breakpoint
CREATE INDEX "invoices_tenant_idx" ON "invoices" USING btree ("tenant_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_key_key" ON "plans" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_entitlements_tenant_key" ON "tenant_entitlements" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_alerts_once_key" ON "usage_alerts" USING btree ("tenant_id","limit_key","source","period_key","threshold");--> statement-breakpoint
CREATE UNIQUE INDEX "egress_policies_tenant_key" ON "egress_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_attempts_attempt_key" ON "webhook_attempts" USING btree ("tenant_id","delivery_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_first_key" ON "webhook_deliveries" USING btree ("tenant_id","endpoint_id","event_id") WHERE "webhook_deliveries"."replay_of" is null;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE "webhook_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_idx" ON "webhook_deliveries" USING btree ("tenant_id","endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_event_idx" ON "webhook_deliveries" USING btree ("tenant_id","event_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_active_idx" ON "webhook_endpoints" USING btree ("tenant_id") WHERE "webhook_endpoints"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_source_key" ON "webhook_events" USING btree ("tenant_id","source_key");--> statement-breakpoint
CREATE INDEX "webhook_events_created_idx" ON "webhook_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_events_expires_idx" ON "webhook_events" USING btree ("expires_at") WHERE "webhook_events"."body" is not null;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_replaced_by_fk" FOREIGN KEY ("tenant_id","replaced_by") REFERENCES "public"."api_keys"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revoked_by_fk" FOREIGN KEY ("tenant_id","revoked_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_scope_ck" CHECK (("api_keys"."scope_type" = 'tenant') = ("api_keys"."scope_id" is null));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversation_metrics" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "platform_manage" ON "invoices" AS PERMISSIVE FOR ALL TO "hamnivo_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "platform_manage" ON "plans" AS PERMISSIVE FOR ALL TO "hamnivo_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_entitlements" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "platform_read" ON "tenant_entitlements" AS PERMISSIVE FOR SELECT TO "hamnivo_platform" USING (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "usage_alerts" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "egress_policies" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_attempts" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_deliveries" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_endpoints" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_events" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));