CREATE TABLE "agent_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"published_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profiles_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "agent_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"config" jsonb NOT NULL,
	"config_hash" "bytea",
	"created_by" uuid,
	"published_by" uuid,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_versions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "agent_versions_version_ck" CHECK ("agent_versions"."version" > 0),
	CONSTRAINT "agent_versions_published_ck" CHECK ("agent_versions"."state" = 'draft' or ("agent_versions"."config_hash" is not null and "agent_versions"."published_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "agent_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kill_switches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"brand_id" uuid,
	"agent_id" uuid,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by" uuid,
	CONSTRAINT "kill_switches_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "kill_switches_target_ck" CHECK (("kill_switches"."scope" = 'tenant' and "kill_switches"."brand_id" is null and "kill_switches"."agent_id" is null)
        or ("kill_switches"."scope" = 'brand' and "kill_switches"."brand_id" is not null and "kill_switches"."agent_id" is null)
        or ("kill_switches"."scope" = 'agent' and "kill_switches"."agent_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "kill_switches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "model_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text,
	"api_key_secret_id" uuid NOT NULL,
	"allowed_models" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_connections_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "model_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "run_steps" (
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"provider" text,
	"model_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"input_hash" "bytea",
	"output_hash" "bytea",
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_steps_pkey" PRIMARY KEY("tenant_id","run_id","seq")
);
--> statement-breakpoint
ALTER TABLE "run_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"brand_id" uuid,
	"agent_id" uuid,
	"agent_version_id" uuid,
	"trigger_ref" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"outcome" text,
	"epoch" bigint NOT NULL,
	"provider" text,
	"model_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"error_kind" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."workspaces"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_published_version_fk" FOREIGN KEY ("tenant_id","published_version_id") REFERENCES "public"."agent_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_profile_fk" FOREIGN KEY ("tenant_id","profile_id") REFERENCES "public"."agent_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_published_by_fk" FOREIGN KEY ("tenant_id","published_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kill_switches" ADD CONSTRAINT "kill_switches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kill_switches" ADD CONSTRAINT "kill_switches_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kill_switches" ADD CONSTRAINT "kill_switches_agent_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."agent_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kill_switches" ADD CONSTRAINT "kill_switches_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kill_switches" ADD CONSTRAINT "kill_switches_cleared_by_fk" FOREIGN KEY ("tenant_id","cleared_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_secret_fk" FOREIGN KEY ("tenant_id","api_key_secret_id") REFERENCES "public"."secrets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."agent_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_version_fk" FOREIGN KEY ("tenant_id","agent_version_id") REFERENCES "public"."agent_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profiles_brand_default_key" ON "agent_profiles" USING btree ("tenant_id","brand_id") WHERE "agent_profiles"."is_default" and "agent_profiles"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_versions_version_key" ON "agent_versions" USING btree ("tenant_id","profile_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_versions_one_draft_key" ON "agent_versions" USING btree ("tenant_id","profile_id") WHERE "agent_versions"."state" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_versions_one_published_key" ON "agent_versions" USING btree ("tenant_id","profile_id") WHERE "agent_versions"."state" = 'published';--> statement-breakpoint
CREATE INDEX "kill_switches_active_idx" ON "kill_switches" USING btree ("tenant_id") WHERE "kill_switches"."cleared_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_trigger_key" ON "runs" USING btree ("tenant_id","conversation_id","trigger_ref");--> statement-breakpoint
CREATE INDEX "runs_conversation_idx" ON "runs" USING btree ("tenant_id","conversation_id","started_at");--> statement-breakpoint
CREATE INDEX "runs_agent_idx" ON "runs" USING btree ("tenant_id","agent_id","started_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_profiles" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_versions" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kill_switches" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "model_connections" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "run_steps" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "runs" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));