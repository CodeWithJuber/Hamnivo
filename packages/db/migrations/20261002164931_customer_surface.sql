CREATE TABLE "brand_widget_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"proactive" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings_updated_at" timestamp with time zone,
	"proactive_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_widget_settings_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "brand_widget_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversation_read_state" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"customer_read_seq" integer DEFAULT 0 NOT NULL,
	"customer_read_at" timestamp with time zone,
	"customer_seen_synced_at" timestamp with time zone,
	"agent_seen_at" timestamp with time zone,
	"agent_read_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_read_state_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "conversation_read_state_seq_ck" CHECK ("conversation_read_state"."customer_read_seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "conversation_read_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "customer_notification_preferences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"transcript" boolean DEFAULT false NOT NULL,
	"reply_waiting" boolean DEFAULT false NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_notification_preferences_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "customer_notification_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "customer_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text NOT NULL,
	"skip_reason" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_notifications_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_notifications_kind_ck" CHECK ("customer_notifications"."kind" in ('transcript', 'reply_waiting')),
	CONSTRAINT "customer_notifications_status_ck" CHECK ("customer_notifications"."status" in ('sent', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "widget_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" "bytea" NOT NULL,
	"status" text NOT NULL,
	"rejection_reason" text,
	"scan_engine" text,
	"scanned_at" timestamp with time zone,
	"content" "bytea",
	"client_message_id" uuid,
	"authority_message_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "widget_uploads_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "widget_uploads_status_ck" CHECK ("widget_uploads"."status" in ('available', 'rejected', 'sent', 'expired')),
	CONSTRAINT "widget_uploads_size_ck" CHECK ("widget_uploads"."size_bytes" between 1 and 10485760),
	CONSTRAINT "widget_uploads_quarantine_ck" CHECK ("widget_uploads"."content" is null or "widget_uploads"."status" = 'available')
);
--> statement-breakpoint
ALTER TABLE "widget_uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "brand_widget_settings" ADD CONSTRAINT "brand_widget_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_widget_settings" ADD CONSTRAINT "brand_widget_settings_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_read_state" ADD CONSTRAINT "conversation_read_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_read_state" ADD CONSTRAINT "conversation_read_state_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_read_state" ADD CONSTRAINT "conversation_read_state_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."customer_principals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notification_preferences" ADD CONSTRAINT "customer_notification_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notification_preferences" ADD CONSTRAINT "customer_notification_preferences_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notification_preferences" ADD CONSTRAINT "customer_notification_preferences_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."customer_principals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."customer_principals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_uploads" ADD CONSTRAINT "widget_uploads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_uploads" ADD CONSTRAINT "widget_uploads_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_uploads" ADD CONSTRAINT "widget_uploads_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_uploads" ADD CONSTRAINT "widget_uploads_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."customer_principals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_widget_settings_brand_key" ON "brand_widget_settings" USING btree ("tenant_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_read_state_conversation_key" ON "conversation_read_state" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_notification_preferences_principal_key" ON "customer_notification_preferences" USING btree ("tenant_id","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_notifications_dedupe_key" ON "customer_notifications" USING btree ("tenant_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "customer_notifications_conversation_idx" ON "customer_notifications" USING btree ("tenant_id","conversation_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "widget_uploads_conversation_idx" ON "widget_uploads" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
CREATE INDEX "widget_uploads_expires_idx" ON "widget_uploads" USING btree ("expires_at") WHERE "widget_uploads"."content" is not null;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "brand_widget_settings" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversation_read_state" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_notification_preferences" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_notifications" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "widget_uploads" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));