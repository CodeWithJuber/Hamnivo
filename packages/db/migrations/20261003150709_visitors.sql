CREATE TABLE "staff_conversation_reads" (
	"tenant_id" uuid NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"read_seq" bigint DEFAULT 0 NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_conversation_reads_pkey" PRIMARY KEY("tenant_id","staff_member_id","conversation_id"),
	CONSTRAINT "staff_conversation_reads_seq_ck" CHECK ("staff_conversation_reads"."read_seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "staff_conversation_reads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_inbox_preferences" (
	"tenant_id" uuid NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"sound_muted" boolean DEFAULT false NOT NULL,
	"sound_volume" smallint DEFAULT 60 NOT NULL,
	"sound_new_chat" text DEFAULT 'chime' NOT NULL,
	"sound_customer_message" text DEFAULT 'pop' NOT NULL,
	"sound_assigned" text DEFAULT 'bell' NOT NULL,
	"desktop_enabled" boolean DEFAULT true NOT NULL,
	"desktop_preview" boolean DEFAULT true NOT NULL,
	"availability" text DEFAULT 'online' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_inbox_preferences_pkey" PRIMARY KEY("tenant_id","staff_member_id"),
	CONSTRAINT "staff_inbox_preferences_volume_ck" CHECK ("staff_inbox_preferences"."sound_volume" between 0 and 100),
	CONSTRAINT "staff_inbox_preferences_availability_ck" CHECK ("staff_inbox_preferences"."availability" in ('online', 'away', 'offline'))
);
--> statement-breakpoint
ALTER TABLE "staff_inbox_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "brand_visitor_settings" (
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"tracking" boolean DEFAULT true NOT NULL,
	"keep_query_strings" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_visitor_settings_pkey" PRIMARY KEY("tenant_id","brand_id")
);
--> statement-breakpoint
ALTER TABLE "brand_visitor_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "visitor_page_views" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"visitor_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"referrer" text,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visitor_page_views_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "visitor_page_views" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "visitor_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"visitor_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"country" text,
	"browser" text,
	"browser_version" text,
	"os" text,
	"os_version" text,
	"device_type" text DEFAULT 'other' NOT NULL,
	"language" text,
	"referrer" text,
	"entry_url" text NOT NULL,
	"current_url" text NOT NULL,
	"current_title" text,
	"page_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "visitor_sessions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "visitor_sessions_country_ck" CHECK ("visitor_sessions"."country" is null or "visitor_sessions"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "visitor_sessions_device_ck" CHECK ("visitor_sessions"."device_type" in ('desktop', 'mobile', 'tablet', 'other'))
);
--> statement-breakpoint
ALTER TABLE "visitor_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "visitors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"key_hash" "bytea" NOT NULL,
	"principal_id" uuid,
	"visit_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visitors_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "visitors_count_ck" CHECK ("visitors"."visit_count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "visitors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "staff_conversation_reads" ADD CONSTRAINT "staff_conversation_reads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_conversation_reads" ADD CONSTRAINT "staff_conversation_reads_staff_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_conversation_reads" ADD CONSTRAINT "staff_conversation_reads_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_inbox_preferences" ADD CONSTRAINT "staff_inbox_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_inbox_preferences" ADD CONSTRAINT "staff_inbox_preferences_staff_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_visitor_settings" ADD CONSTRAINT "brand_visitor_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_visitor_settings" ADD CONSTRAINT "brand_visitor_settings_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_visitor_settings" ADD CONSTRAINT "brand_visitor_settings_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_page_views" ADD CONSTRAINT "visitor_page_views_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_page_views" ADD CONSTRAINT "visitor_page_views_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_page_views" ADD CONSTRAINT "visitor_page_views_visitor_fk" FOREIGN KEY ("tenant_id","visitor_id") REFERENCES "public"."visitors"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_page_views" ADD CONSTRAINT "visitor_page_views_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."visitor_sessions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_visitor_fk" FOREIGN KEY ("tenant_id","visitor_id") REFERENCES "public"."visitors"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."customer_principals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_conversation_reads_conversation_idx" ON "staff_conversation_reads" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
CREATE INDEX "visitor_page_views_session_idx" ON "visitor_page_views" USING btree ("tenant_id","session_id","viewed_at");--> statement-breakpoint
CREATE INDEX "visitor_page_views_expiry_idx" ON "visitor_page_views" USING btree ("viewed_at");--> statement-breakpoint
CREATE INDEX "visitor_sessions_live_idx" ON "visitor_sessions" USING btree ("tenant_id","brand_id","last_seen_at") WHERE "visitor_sessions"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "visitor_sessions_visitor_idx" ON "visitor_sessions" USING btree ("tenant_id","visitor_id","started_at");--> statement-breakpoint
CREATE INDEX "visitor_sessions_expiry_idx" ON "visitor_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "visitors_key_key" ON "visitors" USING btree ("tenant_id","brand_id","key_hash");--> statement-breakpoint
CREATE INDEX "visitors_seen_idx" ON "visitors" USING btree ("tenant_id","brand_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "visitors_expiry_idx" ON "visitors" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "visitors_principal_idx" ON "visitors" USING btree ("tenant_id","principal_id") WHERE "visitors"."principal_id" is not null;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "staff_conversation_reads" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "staff_inbox_preferences" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "brand_visitor_settings" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "visitor_page_views" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "visitor_sessions" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "visitors" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));