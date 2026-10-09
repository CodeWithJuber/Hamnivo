CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"event" text NOT NULL,
	"event_key" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"actions" text[] DEFAULT '{}'::text[] NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_runs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "automation_runs_outcome_ck" CHECK ("automation_runs"."outcome" in ('done', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "automation_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_versions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "automation_versions_version_ck" CHECK ("automation_versions"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "automation_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"draft" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"published_version_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "automations_kind_ck" CHECK ("automations"."kind" in ('visitor', 'conversation')),
	CONSTRAINT "automations_revision_ck" CHECK ("automations"."revision" > 0),
	CONSTRAINT "automations_name_ck" CHECK (char_length("automations"."name") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "automations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_fk" FOREIGN KEY ("tenant_id","automation_id") REFERENCES "public"."automations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."automation_versions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_automation_fk" FOREIGN KEY ("tenant_id","automation_id") REFERENCES "public"."automations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_published_by_fk" FOREIGN KEY ("tenant_id","published_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_once_key" ON "automation_runs" USING btree ("tenant_id","automation_id","conversation_id","event_key");--> statement-breakpoint
CREATE INDEX "automation_runs_recent_idx" ON "automation_runs" USING btree ("tenant_id","automation_id","ran_at");--> statement-breakpoint
CREATE INDEX "automation_runs_conversation_idx" ON "automation_runs" USING btree ("tenant_id","conversation_id","ran_at");--> statement-breakpoint
CREATE INDEX "automation_runs_expiry_idx" ON "automation_runs" USING btree ("ran_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_versions_version_key" ON "automation_versions" USING btree ("tenant_id","automation_id","version");--> statement-breakpoint
CREATE INDEX "automations_brand_idx" ON "automations" USING btree ("tenant_id","brand_id","kind");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "automation_runs" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "automation_versions" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "automations" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));