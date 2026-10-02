CREATE TABLE "decision_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"conversation_id" uuid,
	"run_id" uuid,
	"task" text NOT NULL,
	"trigger_ref" text NOT NULL,
	"rubric_id" uuid,
	"rubric_version" integer,
	"mode" text NOT NULL,
	"provider" text NOT NULL,
	"model_version" text,
	"status" text NOT NULL,
	"reason" text,
	"retryable" boolean,
	"language" text,
	"verdict" text NOT NULL,
	"action" text NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latency_ms" integer,
	"total_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"request_id" text,
	"policy_version" text,
	"state_hash" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_checks_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "decision_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "decision_checks" ADD CONSTRAINT "decision_checks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_checks" ADD CONSTRAINT "decision_checks_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_checks" ADD CONSTRAINT "decision_checks_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_checks" ADD CONSTRAINT "decision_checks_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_checks" ADD CONSTRAINT "decision_checks_rubric_fk" FOREIGN KEY ("tenant_id","rubric_id") REFERENCES "public"."decision_rubrics"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "decision_checks_trigger_key" ON "decision_checks" USING btree ("tenant_id","task","trigger_ref");--> statement-breakpoint
CREATE INDEX "decision_checks_brand_idx" ON "decision_checks" USING btree ("tenant_id","brand_id","task","created_at");--> statement-breakpoint
CREATE INDEX "decision_checks_conversation_idx" ON "decision_checks" USING btree ("tenant_id","conversation_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "decision_checks" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));