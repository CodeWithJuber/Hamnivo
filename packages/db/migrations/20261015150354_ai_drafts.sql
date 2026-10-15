CREATE TABLE "ai_draft_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"text_hash" "bytea",
	"owner_epoch" bigint NOT NULL,
	"reason" text,
	"note" text,
	"client_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_draft_decisions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "ai_draft_decisions_shape_ck" CHECK (("ai_draft_decisions"."decision" = 'edited') = ("ai_draft_decisions"."text_hash" is not null)
        and ("ai_draft_decisions"."decision" = 'rejected') = ("ai_draft_decisions"."reason" is not null)
        and ("ai_draft_decisions"."decision" = 'rejected') = ("ai_draft_decisions"."client_message_id" is null)
        and ("ai_draft_decisions"."text_hash" is null or octet_length("ai_draft_decisions"."text_hash") = 32)
        and ("ai_draft_decisions"."note" is null or char_length("ai_draft_decisions"."note") <= 500))
);
--> statement-breakpoint
ALTER TABLE "ai_draft_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid,
	"agent_version_id" uuid,
	"trigger_ledger_id" uuid NOT NULL,
	"owner_epoch" bigint NOT NULL,
	"text" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"language" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"superseded_reason" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_drafts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "ai_drafts_text_ck" CHECK (char_length("ai_drafts"."text") between 1 and 10000),
	CONSTRAINT "ai_drafts_sources_ck" CHECK (jsonb_typeof("ai_drafts"."sources") = 'array'),
	CONSTRAINT "ai_drafts_state_ck" CHECK (("ai_drafts"."state" = 'superseded') = ("ai_drafts"."superseded_reason" is not null)
        and ("ai_drafts"."state" in ('approved', 'edited', 'rejected')) = ("ai_drafts"."decided_by" is not null)
        and ("ai_drafts"."state" = 'pending') = ("ai_drafts"."decided_at" is null))
);
--> statement-breakpoint
ALTER TABLE "ai_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_draft_decisions" ADD CONSTRAINT "ai_draft_decisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_draft_decisions" ADD CONSTRAINT "ai_draft_decisions_draft_fk" FOREIGN KEY ("tenant_id","draft_id") REFERENCES "public"."ai_drafts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_draft_decisions" ADD CONSTRAINT "ai_draft_decisions_staff_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_agent_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."agent_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_agent_version_fk" FOREIGN KEY ("tenant_id","agent_version_id") REFERENCES "public"."agent_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_trigger_fk" FOREIGN KEY ("tenant_id","trigger_ledger_id") REFERENCES "public"."message_ledger"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_draft_decisions_draft_key" ON "ai_draft_decisions" USING btree ("tenant_id","draft_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_draft_decisions_request_key" ON "ai_draft_decisions" USING btree ("tenant_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_drafts_run_key" ON "ai_drafts" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_drafts_pending_key" ON "ai_drafts" USING btree ("tenant_id","conversation_id") WHERE "ai_drafts"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "ai_drafts_conversation_idx" ON "ai_drafts" USING btree ("tenant_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_drafts_ended_idx" ON "ai_drafts" USING btree ("decided_at") WHERE "ai_drafts"."decided_at" is not null;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_draft_decisions" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_drafts" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));