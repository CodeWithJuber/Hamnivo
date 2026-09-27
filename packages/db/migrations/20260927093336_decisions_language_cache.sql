CREATE TABLE "cache_dependency_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"dependency" text NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cache_dependency_versions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "cache_dependency_versions_dependency_key" UNIQUE("tenant_id","dependency")
);
--> statement-breakpoint
ALTER TABLE "cache_dependency_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cache_entry_index" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"fingerprint" text NOT NULL,
	"lookup" text NOT NULL,
	"dependencies" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"language" text,
	"audience" text NOT NULL,
	"model" text,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	CONSTRAINT "cache_entry_index_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "cache_entry_index_fingerprint_key" UNIQUE("tenant_id","tier","fingerprint")
);
--> statement-breakpoint
ALTER TABLE "cache_entry_index" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cache_metrics_daily" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"day" date NOT NULL,
	"tier" text NOT NULL,
	"language" text DEFAULT '' NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"misses" integer DEFAULT 0 NOT NULL,
	"bypasses" integer DEFAULT 0 NOT NULL,
	"stores" integer DEFAULT 0 NOT NULL,
	"stale" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"saved_input_tokens" bigint DEFAULT 0 NOT NULL,
	"saved_output_tokens" bigint DEFAULT 0 NOT NULL,
	"saved_ms" bigint DEFAULT 0 NOT NULL,
	"lookup_ms" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cache_metrics_daily_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "cache_metrics_daily_key" UNIQUE("tenant_id","brand_id","day","tier","language")
);
--> statement-breakpoint
ALTER TABLE "cache_metrics_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cache_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"tiers" jsonb NOT NULL,
	"excluded_classes" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cache_policies_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "cache_policies_brand_key" UNIQUE("tenant_id","brand_id")
);
--> statement-breakpoint
ALTER TABLE "cache_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversation_routes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"decision_id" uuid,
	"source" text NOT NULL,
	"sync_state" text DEFAULT 'pending' NOT NULL,
	"routed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone,
	CONSTRAINT "conversation_routes_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "conversation_routes_conversation_key" UNIQUE("tenant_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_routes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "decision_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"conversation_id" uuid,
	"task" text NOT NULL,
	"trigger" text NOT NULL,
	"trigger_ref" text NOT NULL,
	"rubric_id" uuid,
	"rubric_version" integer,
	"mode" text NOT NULL,
	"provider" text NOT NULL,
	"model_version" text,
	"status" text NOT NULL,
	"reason" text,
	"retryable" boolean,
	"provider_intent" text,
	"confidence" real,
	"probabilities" jsonb,
	"baseline_intent" text NOT NULL,
	"baseline_matches" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"final_intent" text NOT NULL,
	"final_source" text NOT NULL,
	"fallback" text,
	"team_id" uuid,
	"team_basis" text NOT NULL,
	"language_match" text NOT NULL,
	"language" text,
	"explicit_request" boolean DEFAULT false NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	"applied_at" timestamp with time zone,
	"latency_ms" integer,
	"total_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"request_id" text,
	"policy_version" text,
	"state_hash" "bytea",
	"offered" text[] DEFAULT '{}'::text[] NOT NULL,
	"reviewed_intent" text,
	"review_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"training_consent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_records_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "decision_records_confidence_ck" CHECK ("decision_records"."confidence" is null or ("decision_records"."confidence" >= 0 and "decision_records"."confidence" <= 1))
);
--> statement-breakpoint
ALTER TABLE "decision_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "decision_rubrics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"task" text NOT NULL,
	"version" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"definition" jsonb NOT NULL,
	"provider" text DEFAULT 'none' NOT NULL,
	"model_version" text,
	"deadline_ms" integer DEFAULT 1500 NOT NULL,
	"config_hash" "bytea",
	"created_by" uuid,
	"published_by" uuid,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_rubrics_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "decision_rubrics_version_ck" CHECK ("decision_rubrics"."version" > 0),
	CONSTRAINT "decision_rubrics_deadline_ck" CHECK ("decision_rubrics"."deadline_ms" between 100 and 10000),
	CONSTRAINT "decision_rubrics_published_ck" CHECK ("decision_rubrics"."state" = 'draft' or ("decision_rubrics"."config_hash" is not null and "decision_rubrics"."published_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "decision_rubrics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "decision_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"task" text NOT NULL,
	"mode" text DEFAULT 'shadow' NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_tasks_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "decision_tasks_task_key" UNIQUE("tenant_id","brand_id","task")
);
--> statement-breakpoint
ALTER TABLE "decision_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "routing_teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" text NOT NULL,
	"intents" text[] DEFAULT '{}'::text[] NOT NULL,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"translation_languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"external_team_id" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"accepting" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_teams_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "routing_teams_name_key" UNIQUE("tenant_id","brand_id","name")
);
--> statement-breakpoint
ALTER TABLE "routing_teams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "language_preferences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"ui_locale" text,
	"explicit_language" text,
	"last_language" text,
	"last_source" text,
	"last_detected" text[] DEFAULT '{}'::text[] NOT NULL,
	"prompted_at" timestamp with time zone,
	"script_preference" text,
	"dialect" text,
	"formality" text,
	"style_verbosity" text,
	"style_tone" text,
	"timezone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "language_preferences_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "language_preferences_principal_key" UNIQUE("tenant_id","principal_id")
);
--> statement-breakpoint
ALTER TABLE "language_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cache_dependency_versions" ADD CONSTRAINT "cache_dependency_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache_entry_index" ADD CONSTRAINT "cache_entry_index_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache_entry_index" ADD CONSTRAINT "cache_entry_index_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache_metrics_daily" ADD CONSTRAINT "cache_metrics_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache_metrics_daily" ADD CONSTRAINT "cache_metrics_daily_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache_policies" ADD CONSTRAINT "cache_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache_policies" ADD CONSTRAINT "cache_policies_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache_policies" ADD CONSTRAINT "cache_policies_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_routes" ADD CONSTRAINT "conversation_routes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_routes" ADD CONSTRAINT "conversation_routes_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_routes" ADD CONSTRAINT "conversation_routes_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_routes" ADD CONSTRAINT "conversation_routes_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "public"."routing_teams"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_routes" ADD CONSTRAINT "conversation_routes_decision_fk" FOREIGN KEY ("tenant_id","decision_id") REFERENCES "public"."decision_records"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_rubric_fk" FOREIGN KEY ("tenant_id","rubric_id") REFERENCES "public"."decision_rubrics"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "public"."routing_teams"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_reviewed_by_fk" FOREIGN KEY ("tenant_id","reviewed_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rubrics" ADD CONSTRAINT "decision_rubrics_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rubrics" ADD CONSTRAINT "decision_rubrics_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rubrics" ADD CONSTRAINT "decision_rubrics_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rubrics" ADD CONSTRAINT "decision_rubrics_published_by_fk" FOREIGN KEY ("tenant_id","published_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_tasks" ADD CONSTRAINT "decision_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_tasks" ADD CONSTRAINT "decision_tasks_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_tasks" ADD CONSTRAINT "decision_tasks_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_teams" ADD CONSTRAINT "routing_teams_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_teams" ADD CONSTRAINT "routing_teams_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_teams" ADD CONSTRAINT "routing_teams_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "language_preferences" ADD CONSTRAINT "language_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "language_preferences" ADD CONSTRAINT "language_preferences_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."customer_principals"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cache_entry_index_brand_idx" ON "cache_entry_index" USING btree ("tenant_id","brand_id","created_at");--> statement-breakpoint
CREATE INDEX "cache_entry_index_lookup_idx" ON "cache_entry_index" USING btree ("tenant_id","tier","lookup");--> statement-breakpoint
CREATE INDEX "cache_entry_index_dependencies_idx" ON "cache_entry_index" USING gin ("dependencies");--> statement-breakpoint
CREATE INDEX "conversation_routes_team_idx" ON "conversation_routes" USING btree ("tenant_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_records_trigger_key" ON "decision_records" USING btree ("tenant_id","conversation_id","task","trigger_ref") WHERE "decision_records"."conversation_id" is not null;--> statement-breakpoint
CREATE INDEX "decision_records_brand_idx" ON "decision_records" USING btree ("tenant_id","brand_id","task","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_rubrics_version_key" ON "decision_rubrics" USING btree ("tenant_id","brand_id","task","version");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_rubrics_one_draft_key" ON "decision_rubrics" USING btree ("tenant_id","brand_id","task") WHERE "decision_rubrics"."state" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "decision_rubrics_one_published_key" ON "decision_rubrics" USING btree ("tenant_id","brand_id","task") WHERE "decision_rubrics"."state" = 'published';--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "cache_dependency_versions" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "cache_entry_index" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "cache_metrics_daily" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "cache_policies" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversation_routes" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "decision_records" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "decision_rubrics" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "decision_tasks" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "routing_teams" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "language_preferences" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));