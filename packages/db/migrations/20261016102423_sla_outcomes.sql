CREATE TABLE "sla_outcomes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"priority" text NOT NULL,
	"target_minutes" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"business_minutes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sla_outcomes_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "sla_outcomes_minutes_ck" CHECK ("sla_outcomes"."target_minutes" > 0 and "sla_outcomes"."business_minutes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sla_outcomes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sla_outcomes" ADD CONSTRAINT "sla_outcomes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_outcomes" ADD CONSTRAINT "sla_outcomes_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sla_outcomes_ended_idx" ON "sla_outcomes" USING btree ("tenant_id","ended_at");--> statement-breakpoint
CREATE INDEX "sla_outcomes_conversation_idx" ON "sla_outcomes" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
CREATE INDEX "ai_drafts_created_idx" ON "ai_drafts" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_offers_offered_idx" ON "conversation_offers" USING btree ("tenant_id","offered_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sla_outcomes" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));