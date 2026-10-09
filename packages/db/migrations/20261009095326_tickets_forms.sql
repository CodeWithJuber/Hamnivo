CREATE TABLE "chat_consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"notice_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_consents_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "chat_consents_version_ck" CHECK ("chat_consents"."notice_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "chat_consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ticket_followups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"confirm_token_hash" "bytea" NOT NULL,
	"confirmation_sent_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_followups_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "ticket_followups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenant_counters" (
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "tenant_counters_pkey" PRIMARY KEY("tenant_id","name"),
	CONSTRAINT "tenant_counters_value_ck" CHECK ("tenant_counters"."value" >= 0),
	CONSTRAINT "tenant_counters_name_ck" CHECK ("tenant_counters"."name" ~ '^[a-z][a-z_]{0,39}$')
);
--> statement-breakpoint
ALTER TABLE "tenant_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "brand_widget_settings" ADD COLUMN "forms" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_widget_settings" ADD COLUMN "consent" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_widget_settings" ADD COLUMN "consent_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_widget_settings" ADD COLUMN "direct_link" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_widget_settings" ADD COLUMN "forms_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brand_widget_settings" ADD COLUMN "consent_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brand_widget_settings" ADD COLUMN "direct_link_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD COLUMN "priority" text;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD COLUMN "ticket_number" integer;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD COLUMN "ticket_source" text;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD COLUMN "ticket_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_consents" ADD CONSTRAINT "chat_consents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_consents" ADD CONSTRAINT "chat_consents_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_consents" ADD CONSTRAINT "chat_consents_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."customer_principals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_followups" ADD CONSTRAINT "ticket_followups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_followups" ADD CONSTRAINT "ticket_followups_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_followups" ADD CONSTRAINT "ticket_followups_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_followups" ADD CONSTRAINT "ticket_followups_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."customer_principals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_counters" ADD CONSTRAINT "tenant_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_consents_principal_idx" ON "chat_consents" USING btree ("tenant_id","principal_id","notice_version");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_followups_conversation_key" ON "ticket_followups" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_followups_token_key" ON "ticket_followups" USING btree ("confirm_token_hash");--> statement-breakpoint
CREATE INDEX "ticket_followups_email_idx" ON "ticket_followups" USING btree ("tenant_id","brand_id","email","confirmation_sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_inbox_state_ticket_key" ON "conversation_inbox_state" USING btree ("tenant_id","ticket_number") WHERE "conversation_inbox_state"."ticket_number" is not null;--> statement-breakpoint
ALTER TABLE "brand_widget_settings" ADD CONSTRAINT "brand_widget_settings_consent_version_ck" CHECK ("brand_widget_settings"."consent_version" >= 0);--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD CONSTRAINT "conversation_inbox_state_priority_ck" CHECK ("conversation_inbox_state"."priority" is null or "conversation_inbox_state"."priority" in ('urgent', 'high', 'medium', 'low'));--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD CONSTRAINT "conversation_inbox_state_ticket_ck" CHECK (("conversation_inbox_state"."ticket_number" is null and "conversation_inbox_state"."ticket_source" is null and "conversation_inbox_state"."ticket_opened_at" is null) or ("conversation_inbox_state"."ticket_number" > 0 and "conversation_inbox_state"."ticket_source" in ('offline_form', 'staff', 'automation') and "conversation_inbox_state"."ticket_opened_at" is not null));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "chat_consents" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ticket_followups" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_counters" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));