CREATE TABLE "conversation_feedback" (
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_feedback_pkey" PRIMARY KEY("tenant_id","conversation_id","principal_id"),
	CONSTRAINT "conversation_feedback_rating_ck" CHECK ("conversation_feedback"."rating" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "conversation_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_feedback" ADD CONSTRAINT "conversation_feedback_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_feedback" ADD CONSTRAINT "conversation_feedback_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_feedback" ADD CONSTRAINT "conversation_feedback_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."customer_principals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversation_feedback" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));