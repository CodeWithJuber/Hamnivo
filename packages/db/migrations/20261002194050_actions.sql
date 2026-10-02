CREATE TABLE "action_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"approver_kind" text NOT NULL,
	"approver_id" text NOT NULL,
	"client_request_id" uuid NOT NULL,
	"arguments_hash" "bytea" NOT NULL,
	"tool_revision" integer NOT NULL,
	"resource_revision" text,
	"owner_epoch" bigint NOT NULL,
	"step_up" boolean NOT NULL,
	"channel" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_approvals_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "action_approvals_hash_ck" CHECK (octet_length("action_approvals"."arguments_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "action_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "action_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"autopilot_enabled" boolean DEFAULT true NOT NULL,
	"daily_autopilot_limit" integer DEFAULT 200 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_settings_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "action_settings_limit_ck" CHECK ("action_settings"."daily_autopilot_limit" >= 0)
);
--> statement-breakpoint
ALTER TABLE "action_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"run_id" uuid,
	"agent_id" uuid,
	"agent_version_id" uuid,
	"tool_id" uuid NOT NULL,
	"tool_revision" integer NOT NULL,
	"tool_name" text NOT NULL,
	"tool_title" text NOT NULL,
	"risk" text NOT NULL,
	"approver" text NOT NULL,
	"required_permission" text,
	"step_up" boolean DEFAULT false NOT NULL,
	"state" text NOT NULL,
	"basis" text NOT NULL,
	"reason" text,
	"arguments" jsonb NOT NULL,
	"arguments_hash" "bytea" NOT NULL,
	"summary" text NOT NULL,
	"effects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"amount_minor" bigint,
	"currency" text,
	"resource_type" text,
	"resource_id" text,
	"resource_label" text,
	"resource_revision" text,
	"owner_epoch" bigint NOT NULL,
	"principal_id" uuid,
	"code" text,
	"expires_at" timestamp with time zone,
	"operation_id" uuid,
	"outcome_summary" text,
	"decided_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "actions_hash_ck" CHECK (octet_length("actions"."arguments_hash") = 32),
	CONSTRAINT "actions_high_risk_ck" CHECK ("actions"."risk" not in ('money', 'irreversible') or ("actions"."approver" = 'staff' and "actions"."basis" <> 'autopilot')),
	CONSTRAINT "actions_amount_ck" CHECK (("actions"."amount_minor" is null) = ("actions"."currency" is null))
);
--> statement-breakpoint
ALTER TABLE "actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "handoff_packets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"epoch" bigint NOT NULL,
	"run_id" uuid,
	"reason" text NOT NULL,
	"packet" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handoff_packets_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "handoff_packets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"token_secret_id" uuid,
	"protocol_version" text,
	"server_name" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "mcp_servers_url_ck" CHECK ("mcp_servers"."url" ~ '^https?://')
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "simulation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"suite_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"candidate_version_id" uuid NOT NULL,
	"baseline_version_id" uuid,
	"candidate_config_hash" "bytea" NOT NULL,
	"status" text NOT NULL,
	"summary" jsonb NOT NULL,
	"results" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	CONSTRAINT "simulation_runs_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "simulation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "simulation_suites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"cases" jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "simulation_suites_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "simulation_suites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tool_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"remote_description" text,
	"source" text NOT NULL,
	"builtin" text,
	"mcp_server_id" uuid,
	"remote_name" text,
	"remote_digest" "bytea",
	"input_schema" jsonb NOT NULL,
	"output_schema" jsonb,
	"risk" text NOT NULL,
	"approver" text NOT NULL,
	"required_permission" text,
	"autopilot" boolean DEFAULT false NOT NULL,
	"customer_step_up" boolean DEFAULT false NOT NULL,
	"resource_type" text,
	"timeout_ms" integer DEFAULT 10000 NOT NULL,
	"max_output_bytes" integer DEFAULT 16384 NOT NULL,
	"egress_hosts" text[] DEFAULT '{}'::text[] NOT NULL,
	"amount_argument" text,
	"currency_argument" text,
	"approval_minutes" integer,
	"status" text DEFAULT 'enabled' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_definitions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tool_definitions_source_ck" CHECK (("tool_definitions"."source" = 'builtin' and "tool_definitions"."builtin" is not null and "tool_definitions"."mcp_server_id" is null)
        or ("tool_definitions"."source" = 'mcp' and "tool_definitions"."mcp_server_id" is not null and "tool_definitions"."remote_name" is not null)),
	CONSTRAINT "tool_definitions_high_risk_ck" CHECK ("tool_definitions"."risk" not in ('money', 'irreversible') or ("tool_definitions"."approver" = 'staff' and not "tool_definitions"."autopilot")),
	CONSTRAINT "tool_definitions_limits_ck" CHECK ("tool_definitions"."timeout_ms" between 1000 and 60000 and "tool_definitions"."max_output_bytes" between 256 and 262144 and "tool_definitions"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "tool_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kill_switches" DROP CONSTRAINT "kill_switches_target_ck";--> statement-breakpoint
ALTER TABLE "kill_switches" ADD COLUMN "tool_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancel_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "action_approvals" ADD CONSTRAINT "action_approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_approvals" ADD CONSTRAINT "action_approvals_action_fk" FOREIGN KEY ("tenant_id","action_id") REFERENCES "public"."actions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_settings" ADD CONSTRAINT "action_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_settings" ADD CONSTRAINT "action_settings_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_agent_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."agent_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_agent_version_fk" FOREIGN KEY ("tenant_id","agent_version_id") REFERENCES "public"."agent_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_tool_fk" FOREIGN KEY ("tenant_id","tool_id") REFERENCES "public"."tool_definitions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."customer_principals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_operation_fk" FOREIGN KEY ("tenant_id","operation_id") REFERENCES "public"."operations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_packets" ADD CONSTRAINT "handoff_packets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_packets" ADD CONSTRAINT "handoff_packets_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_packets" ADD CONSTRAINT "handoff_packets_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."workspaces"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_token_fk" FOREIGN KEY ("tenant_id","token_secret_id") REFERENCES "public"."secrets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_suite_fk" FOREIGN KEY ("tenant_id","suite_id") REFERENCES "public"."simulation_suites"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_agent_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."agent_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_candidate_fk" FOREIGN KEY ("tenant_id","candidate_version_id") REFERENCES "public"."agent_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_baseline_fk" FOREIGN KEY ("tenant_id","baseline_version_id") REFERENCES "public"."agent_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation_suites" ADD CONSTRAINT "simulation_suites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation_suites" ADD CONSTRAINT "simulation_suites_agent_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."agent_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation_suites" ADD CONSTRAINT "simulation_suites_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation_suites" ADD CONSTRAINT "simulation_suites_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_definitions" ADD CONSTRAINT "tool_definitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_definitions" ADD CONSTRAINT "tool_definitions_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."workspaces"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_definitions" ADD CONSTRAINT "tool_definitions_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_definitions" ADD CONSTRAINT "tool_definitions_mcp_server_fk" FOREIGN KEY ("tenant_id","mcp_server_id") REFERENCES "public"."mcp_servers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_definitions" ADD CONSTRAINT "tool_definitions_reviewed_by_fk" FOREIGN KEY ("tenant_id","reviewed_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_definitions" ADD CONSTRAINT "tool_definitions_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_definitions" ADD CONSTRAINT "tool_definitions_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_approvals_action_key" ON "action_approvals" USING btree ("tenant_id","action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "action_approvals_request_key" ON "action_approvals" USING btree ("tenant_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "action_settings_tenant_key" ON "action_settings" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "actions_run_call_key" ON "actions" USING btree ("tenant_id","run_id","tool_id","arguments_hash") WHERE "actions"."run_id" is not null;--> statement-breakpoint
CREATE INDEX "actions_conversation_idx" ON "actions" USING btree ("tenant_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "actions_open_idx" ON "actions" USING btree ("tenant_id","state") WHERE "actions"."state" in ('awaiting_approval', 'approved', 'executing', 'unknown');--> statement-breakpoint
CREATE INDEX "actions_autopilot_idx" ON "actions" USING btree ("tenant_id","created_at") WHERE "actions"."basis" = 'autopilot';--> statement-breakpoint
CREATE INDEX "actions_expiry_idx" ON "actions" USING btree ("expires_at") WHERE "actions"."state" = 'awaiting_approval';--> statement-breakpoint
CREATE UNIQUE INDEX "handoff_packets_epoch_key" ON "handoff_packets" USING btree ("tenant_id","conversation_id","epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_brand_url_key" ON "mcp_servers" USING btree ("tenant_id","brand_id","url");--> statement-breakpoint
CREATE INDEX "simulation_runs_suite_idx" ON "simulation_runs" USING btree ("tenant_id","suite_id","started_at");--> statement-breakpoint
CREATE INDEX "simulation_runs_candidate_idx" ON "simulation_runs" USING btree ("tenant_id","candidate_version_id");--> statement-breakpoint
CREATE INDEX "simulation_suites_agent_idx" ON "simulation_suites" USING btree ("tenant_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_definitions_brand_name_key" ON "tool_definitions" USING btree ("tenant_id","brand_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_definitions_remote_key" ON "tool_definitions" USING btree ("tenant_id","mcp_server_id","remote_name") WHERE "tool_definitions"."mcp_server_id" is not null;--> statement-breakpoint
ALTER TABLE "kill_switches" ADD CONSTRAINT "kill_switches_tool_fk" FOREIGN KEY ("tenant_id","tool_id") REFERENCES "public"."tool_definitions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_cancel_requested_by_fk" FOREIGN KEY ("tenant_id","cancel_requested_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kill_switches" ADD CONSTRAINT "kill_switches_target_ck" CHECK (("kill_switches"."scope" = 'tenant' and "kill_switches"."brand_id" is null and "kill_switches"."agent_id" is null and "kill_switches"."tool_id" is null)
        or ("kill_switches"."scope" = 'brand' and "kill_switches"."brand_id" is not null and "kill_switches"."agent_id" is null and "kill_switches"."tool_id" is null)
        or ("kill_switches"."scope" = 'agent' and "kill_switches"."agent_id" is not null and "kill_switches"."tool_id" is null)
        or ("kill_switches"."scope" = 'tool' and "kill_switches"."tool_id" is not null and "kill_switches"."agent_id" is null));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "action_approvals" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "action_settings" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "actions" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "handoff_packets" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mcp_servers" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "simulation_runs" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "simulation_suites" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tool_definitions" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));