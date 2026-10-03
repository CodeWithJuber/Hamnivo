CREATE TABLE "billing_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text DEFAULT 'free' NOT NULL,
	"customer_ref" text,
	"subscription_ref" text,
	"subscription_status" text DEFAULT 'none' NOT NULL,
	"plan_key" text,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"payment_failed_at" timestamp with time zone,
	"grace_ends_at" timestamp with time zone,
	"provider_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_accounts_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "billing_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_events" (
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_events_pkey" PRIMARY KEY("tenant_id","provider","event_id")
);
--> statement-breakpoint
ALTER TABLE "billing_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "chatwoot_provisioning" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"step" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trigger" text NOT NULL,
	"locked_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chatwoot_provisioning_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "chatwoot_provisioning_attempts_ck" CHECK ("chatwoot_provisioning"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "chatwoot_provisioning" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "operator_api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" "bytea" NOT NULL,
	"hash_version" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid
);
--> statement-breakpoint
ALTER TABLE "operator_api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_email_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sender_name" text NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_email_settings_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "workspace_email_settings_sender_ck" CHECK (char_length("workspace_email_settings"."sender_name") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "workspace_email_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "trial_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "stripe_price_id" text;--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatwoot_provisioning" ADD CONSTRAINT "chatwoot_provisioning_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatwoot_provisioning" ADD CONSTRAINT "chatwoot_provisioning_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_api_keys" ADD CONSTRAINT "operator_api_keys_created_by_platform_operators_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."platform_operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_api_keys" ADD CONSTRAINT "operator_api_keys_revoked_by_platform_operators_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."platform_operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_platform_operators_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."platform_operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_email_settings" ADD CONSTRAINT "workspace_email_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_email_settings" ADD CONSTRAINT "workspace_email_settings_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_tenant_key" ON "billing_accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_stripe_customer_key" ON "billing_accounts" USING btree ("customer_ref") WHERE "billing_accounts"."provider" = 'stripe' and "billing_accounts"."customer_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_subscription_key" ON "billing_accounts" USING btree ("provider","subscription_ref") WHERE "billing_accounts"."subscription_ref" is not null;--> statement-breakpoint
CREATE INDEX "billing_accounts_grace_idx" ON "billing_accounts" USING btree ("grace_ends_at") WHERE "billing_accounts"."grace_ends_at" is not null;--> statement-breakpoint
CREATE INDEX "billing_events_received_idx" ON "billing_events" USING btree ("tenant_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chatwoot_provisioning_brand_key" ON "chatwoot_provisioning" USING btree ("tenant_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_api_keys_prefix_key" ON "operator_api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_email_settings_tenant_key" ON "workspace_email_settings" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_stripe_price_key" ON "plans" USING btree ("stripe_price_id") WHERE "plans"."stripe_price_id" is not null;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_trial_ck" CHECK ("plans"."trial_days" between 0 and 365);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_accounts" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "platform_read" ON "billing_accounts" AS PERMISSIVE FOR SELECT TO "hamnivo_platform" USING (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_events" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "chatwoot_provisioning" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "platform_read" ON "chatwoot_provisioning" AS PERMISSIVE FOR SELECT TO "hamnivo_platform" USING (true);--> statement-breakpoint
CREATE POLICY "platform_manage" ON "operator_api_keys" AS PERMISSIVE FOR ALL TO "hamnivo_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "platform_manage" ON "platform_settings" AS PERMISSIVE FOR ALL TO "hamnivo_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "workspace_email_settings" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));