CREATE TABLE "external_id_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"kind" text NOT NULL,
	"source_id" text NOT NULL,
	"target_ref" text NOT NULL,
	"job_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_id_mappings_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "external_id_mappings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "migration_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" "bytea" NOT NULL,
	"state" text DEFAULT 'quarantined' NOT NULL,
	"raw" "bytea",
	"scan_engine" text,
	"rejected_reason" text,
	"purge_after" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scanned_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	CONSTRAINT "migration_files_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "migration_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "migration_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_id" text NOT NULL,
	"conversation_source_id" text,
	"seq" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"detail" text,
	"private" boolean DEFAULT false NOT NULL,
	"target_ref" text,
	"created" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"imported_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_items_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "migration_items_status_ck" CHECK ("migration_items"."status" in ('pending', 'writing', 'imported', 'skipped', 'quarantined', 'failed', 'rolled_back')),
	CONSTRAINT "migration_items_kind_ck" CHECK ("migration_items"."kind" in ('contact', 'conversation', 'message', 'attachment'))
);
--> statement-breakpoint
ALTER TABLE "migration_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "migration_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"connection_id" uuid,
	"import_inbox_id" uuid,
	"source_system" text NOT NULL,
	"source_kind" text NOT NULL,
	"label" text NOT NULL,
	"state" text DEFAULT 'scanning' NOT NULL,
	"requested_action" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preflight" jsonb,
	"dry_run" jsonb,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_secret_id" uuid,
	"error_code" text,
	"error_detail" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "migration_jobs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "migration_jobs_state_ck" CHECK ("migration_jobs"."state" in ('scanning', 'rejected', 'blocked', 'ready', 'dry_running', 'dry_run_ready', 'queued', 'running', 'paused', 'cancelled', 'completed', 'failed', 'rolling_back', 'rolled_back', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "migration_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reconciliation_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"gate" text NOT NULL,
	"report" jsonb NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"acknowledged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_reports_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "reconciliation_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "external_id_mappings" ADD CONSTRAINT "external_id_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_id_mappings" ADD CONSTRAINT "external_id_mappings_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."authority_connections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_id_mappings" ADD CONSTRAINT "external_id_mappings_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_id_mappings" ADD CONSTRAINT "external_id_mappings_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."migration_jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_files" ADD CONSTRAINT "migration_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_files" ADD CONSTRAINT "migration_files_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."migration_jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_files" ADD CONSTRAINT "migration_files_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_items" ADD CONSTRAINT "migration_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_items" ADD CONSTRAINT "migration_items_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."migration_jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_jobs" ADD CONSTRAINT "migration_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_jobs" ADD CONSTRAINT "migration_jobs_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."workspaces"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_jobs" ADD CONSTRAINT "migration_jobs_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_jobs" ADD CONSTRAINT "migration_jobs_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."authority_connections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_jobs" ADD CONSTRAINT "migration_jobs_import_inbox_fk" FOREIGN KEY ("tenant_id","import_inbox_id") REFERENCES "public"."authority_inboxes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_jobs" ADD CONSTRAINT "migration_jobs_source_secret_fk" FOREIGN KEY ("tenant_id","source_secret_id") REFERENCES "public"."secrets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_jobs" ADD CONSTRAINT "migration_jobs_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_reports" ADD CONSTRAINT "reconciliation_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_reports" ADD CONSTRAINT "reconciliation_reports_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."migration_jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_reports" ADD CONSTRAINT "reconciliation_reports_approved_by_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_id_mappings_source_key" ON "external_id_mappings" USING btree ("tenant_id","connection_id","source_system","kind","source_id");--> statement-breakpoint
CREATE INDEX "external_id_mappings_job_idx" ON "external_id_mappings" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE INDEX "migration_files_job_idx" ON "migration_files" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE INDEX "migration_files_purge_idx" ON "migration_files" USING btree ("purge_after") WHERE "migration_files"."raw" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "migration_items_source_key" ON "migration_items" USING btree ("tenant_id","job_id","kind","source_id");--> statement-breakpoint
CREATE INDEX "migration_items_status_idx" ON "migration_items" USING btree ("tenant_id","job_id","status");--> statement-breakpoint
CREATE INDEX "migration_items_conversation_idx" ON "migration_items" USING btree ("tenant_id","job_id","conversation_source_id","kind","seq");--> statement-breakpoint
CREATE INDEX "migration_jobs_brand_idx" ON "migration_jobs" USING btree ("tenant_id","brand_id","created_at");--> statement-breakpoint
CREATE INDEX "reconciliation_reports_job_idx" ON "reconciliation_reports" USING btree ("tenant_id","job_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "external_id_mappings" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "migration_files" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "migration_items" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "migration_jobs" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "reconciliation_reports" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));