CREATE TABLE "sla_policies" (
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"targets" jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sla_policies_pkey" PRIMARY KEY("tenant_id","brand_id"),
	CONSTRAINT "sla_policies_targets_ck" CHECK (jsonb_typeof("sla_policies"."targets") = 'object')
);
--> statement-breakpoint
ALTER TABLE "sla_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD COLUMN "last_human_reply_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD COLUMN "sla_kind" text;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD COLUMN "sla_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD COLUMN "sla_target_minutes" integer;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD COLUMN "sla_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD COLUMN "sla_paused_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD COLUMN "sla_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD COLUMN "sla_breached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_inbox_state_sla_due_idx" ON "conversation_inbox_state" USING btree ("tenant_id","sla_due_at") WHERE "conversation_inbox_state"."sla_due_at" is not null;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD CONSTRAINT "conversation_inbox_state_sla_ck" CHECK (("conversation_inbox_state"."sla_kind" is null and "conversation_inbox_state"."sla_started_at" is null and "conversation_inbox_state"."sla_target_minutes" is null) or ("conversation_inbox_state"."sla_kind" in ('first_reply', 'next_reply') and "conversation_inbox_state"."sla_started_at" is not null and "conversation_inbox_state"."sla_target_minutes" > 0));--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD CONSTRAINT "conversation_inbox_state_sla_paused_ck" CHECK ("conversation_inbox_state"."sla_paused_minutes" >= 0);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sla_policies" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));