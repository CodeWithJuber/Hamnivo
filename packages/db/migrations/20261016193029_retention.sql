CREATE TABLE "retention_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_days" integer,
	"pending_days" integer,
	"pending_from" timestamp with time zone,
	"sweep_state" text DEFAULT 'idle' NOT NULL,
	"swept_at" timestamp with time zone,
	"conversations_deleted" bigint DEFAULT 0 NOT NULL,
	"customers_deleted" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policies_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "retention_policies_days_ck" CHECK (("retention_policies"."conversation_days" is null or "retention_policies"."conversation_days" in (90, 180, 365, 730, 1095, 1825, 2555))
        and ("retention_policies"."pending_days" is null or "retention_policies"."pending_days" in (90, 180, 365, 730, 1095, 1825, 2555))),
	CONSTRAINT "retention_policies_pending_ck" CHECK (("retention_policies"."pending_days" is null) = ("retention_policies"."pending_from" is null)),
	CONSTRAINT "retention_policies_counts_ck" CHECK ("retention_policies"."conversations_deleted" >= 0 and "retention_policies"."customers_deleted" >= 0)
);
--> statement-breakpoint
ALTER TABLE "retention_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_metrics" DROP CONSTRAINT "conversation_metrics_conversation_fk";
--> statement-breakpoint
ALTER TABLE "carts" DROP CONSTRAINT "carts_conversation_fk";
--> statement-breakpoint
ALTER TABLE "catalog_snapshots" DROP CONSTRAINT "catalog_snapshots_conversation_fk";
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_conversation_fk";
--> statement-breakpoint
ALTER TABLE "purchase_intents" DROP CONSTRAINT "purchase_intents_conversation_fk";
--> statement-breakpoint
ALTER TABLE "quotes" DROP CONSTRAINT "quotes_conversation_fk";
--> statement-breakpoint
ALTER TABLE "chat_consents" DROP CONSTRAINT "chat_consents_principal_fk";
--> statement-breakpoint
ALTER TABLE "learning_consents" DROP CONSTRAINT "learning_consents_subject_fk";
--> statement-breakpoint
ALTER TABLE "memory_records" DROP CONSTRAINT "memory_records_conversation_fk";
--> statement-breakpoint
ALTER TABLE "conversation_offers" DROP CONSTRAINT "conversation_offers_conversation_fk";
--> statement-breakpoint
ALTER TABLE "operations" DROP CONSTRAINT "operations_conversation_fk";
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_conversation_fk";
--> statement-breakpoint
ALTER TABLE "sla_outcomes" DROP CONSTRAINT "sla_outcomes_conversation_fk";
--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD COLUMN "priority" text;--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD COLUMN "ticket_number" integer;--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD COLUMN "ticket_source" text;--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD COLUMN "ticket_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD COLUMN "rating_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_metrics" ADD COLUMN "rating_sum" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retention_policies_tenant_key" ON "retention_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "conversation_controls_resolved_activity_idx" ON "conversation_controls" USING btree ("tenant_id","last_activity_at") WHERE "conversation_controls"."authority_status" = 'resolved';--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "retention_policies" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));