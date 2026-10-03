CREATE TABLE "brand_appearance" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"appearance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_appearance_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "brand_appearance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "model_connection_tests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"ok" boolean NOT NULL,
	"kind" text NOT NULL,
	"model_id" text NOT NULL,
	"tested_by" uuid,
	"tested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_connection_tests_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "model_connection_tests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "onboarding_progress" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"brand_id" uuid,
	"finished_at" timestamp with time zone,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_progress_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "onboarding_progress" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "test_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_conversations_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "test_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "brand_appearance" ADD CONSTRAINT "brand_appearance_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_appearance" ADD CONSTRAINT "brand_appearance_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connection_tests" ADD CONSTRAINT "model_connection_tests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connection_tests" ADD CONSTRAINT "model_connection_tests_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."model_connections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_conversations" ADD CONSTRAINT "test_conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_conversations" ADD CONSTRAINT "test_conversations_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_conversations" ADD CONSTRAINT "test_conversations_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_appearance_brand_key" ON "brand_appearance" USING btree ("tenant_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_connection_tests_connection_key" ON "model_connection_tests" USING btree ("tenant_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_progress_tenant_key" ON "onboarding_progress" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "onboarding_progress_brand_idx" ON "onboarding_progress" USING btree ("tenant_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_conversations_conversation_key" ON "test_conversations" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "brand_appearance" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "model_connection_tests" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "onboarding_progress" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "test_conversations" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));