CREATE TABLE "conversation_inbox_state" (
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"team_id" uuid,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"snoozed_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_inbox_state_pkey" PRIMARY KEY("tenant_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversation_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"linked_conversation_id" uuid NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_links_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "conversation_links_order_ck" CHECK ("conversation_links"."conversation_id" < "conversation_links"."linked_conversation_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversation_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"subject_staff_id" uuid,
	"rating" smallint NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_reviews_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "conversation_reviews_rating_ck" CHECK ("conversation_reviews"."rating" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "conversation_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"lane" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"client_message_id" uuid,
	"state" text DEFAULT 'editing' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_drafts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_drafts_lane_ck" CHECK ("staff_drafts"."lane" in ('public', 'internal')),
	CONSTRAINT "staff_drafts_kind_ck" CHECK (("staff_drafts"."kind" = 'draft' and "staff_drafts"."client_message_id" is null) or ("staff_drafts"."kind" = 'outgoing' and "staff_drafts"."client_message_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "staff_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "team_authority_links" (
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_team_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_authority_links_pkey" PRIMARY KEY("tenant_id","team_id","connection_id")
);
--> statement-breakpoint
ALTER TABLE "team_authority_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "team_members" (
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_pkey" PRIMARY KEY("tenant_id","team_id","staff_member_id")
);
--> statement-breakpoint
ALTER TABLE "team_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_controls" ADD COLUMN "owner_reason" text;--> statement-breakpoint
ALTER TABLE "conversation_controls" ADD COLUMN "owner_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD CONSTRAINT "conversation_inbox_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD CONSTRAINT "conversation_inbox_state_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD CONSTRAINT "conversation_inbox_state_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "public"."teams"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_links" ADD CONSTRAINT "conversation_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_links" ADD CONSTRAINT "conversation_links_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_links" ADD CONSTRAINT "conversation_links_linked_fk" FOREIGN KEY ("tenant_id","linked_conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_links" ADD CONSTRAINT "conversation_links_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reviews" ADD CONSTRAINT "conversation_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reviews" ADD CONSTRAINT "conversation_reviews_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reviews" ADD CONSTRAINT "conversation_reviews_reviewer_fk" FOREIGN KEY ("tenant_id","reviewer_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reviews" ADD CONSTRAINT "conversation_reviews_subject_fk" FOREIGN KEY ("tenant_id","subject_staff_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_drafts" ADD CONSTRAINT "staff_drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_drafts" ADD CONSTRAINT "staff_drafts_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_drafts" ADD CONSTRAINT "staff_drafts_staff_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_authority_links" ADD CONSTRAINT "team_authority_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_authority_links" ADD CONSTRAINT "team_authority_links_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "public"."teams"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_authority_links" ADD CONSTRAINT "team_authority_links_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."authority_connections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "public"."teams"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_staff_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."workspaces"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_inbox_state_team_idx" ON "conversation_inbox_state" USING btree ("tenant_id","team_id");--> statement-breakpoint
CREATE INDEX "conversation_inbox_state_labels_idx" ON "conversation_inbox_state" USING gin ("labels");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_links_pair_key" ON "conversation_links" USING btree ("tenant_id","conversation_id","linked_conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_links_linked_idx" ON "conversation_links" USING btree ("tenant_id","linked_conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_reviews_conversation_idx" ON "conversation_reviews" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_drafts_lane_key" ON "staff_drafts" USING btree ("tenant_id","conversation_id","staff_member_id","lane") WHERE "staff_drafts"."kind" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "staff_drafts_outgoing_key" ON "staff_drafts" USING btree ("tenant_id","conversation_id","staff_member_id","client_message_id") WHERE "staff_drafts"."kind" = 'outgoing';--> statement-breakpoint
CREATE UNIQUE INDEX "team_authority_links_external_key" ON "team_authority_links" USING btree ("tenant_id","connection_id","external_team_id");--> statement-breakpoint
CREATE INDEX "team_members_staff_idx" ON "team_members" USING btree ("tenant_id","staff_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_name_key" ON "teams" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversation_inbox_state" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversation_links" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversation_reviews" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "staff_drafts" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "team_authority_links" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "team_members" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "teams" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));