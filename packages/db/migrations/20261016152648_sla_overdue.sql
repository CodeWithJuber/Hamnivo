ALTER TABLE "sla_policies" ADD COLUMN "overdue_alert_leads" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD COLUMN "overdue_move_after_minutes" integer;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD COLUMN "overdue_move_team_id" uuid;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_overdue_team_fk" FOREIGN KEY ("tenant_id","overdue_move_team_id") REFERENCES "public"."teams"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_overdue_move_ck" CHECK ("sla_policies"."overdue_move_after_minutes" is null or "sla_policies"."overdue_move_after_minutes" between 1 and 10080);