CREATE TABLE "visitor_blocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"principal_id" uuid,
	"visitor_id" uuid,
	"external_subject" text,
	"label" text NOT NULL,
	"conversation_id" uuid,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid,
	CONSTRAINT "visitor_blocks_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "visitor_blocks_target_ck" CHECK ("visitor_blocks"."principal_id" is not null or "visitor_blocks"."visitor_id" is not null or "visitor_blocks"."external_subject" is not null),
	CONSTRAINT "visitor_blocks_reason_ck" CHECK (char_length("visitor_blocks"."reason") between 1 and 500),
	CONSTRAINT "visitor_blocks_lifted_ck" CHECK (("visitor_blocks"."lifted_at" is null) = ("visitor_blocks"."lifted_by" is null))
);
--> statement-breakpoint
ALTER TABLE "visitor_blocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "visitor_blocks" ADD CONSTRAINT "visitor_blocks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_blocks" ADD CONSTRAINT "visitor_blocks_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_blocks" ADD CONSTRAINT "visitor_blocks_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_blocks" ADD CONSTRAINT "visitor_blocks_lifted_by_fk" FOREIGN KEY ("tenant_id","lifted_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visitor_blocks_principal_idx" ON "visitor_blocks" USING btree ("tenant_id","brand_id","principal_id") WHERE "visitor_blocks"."lifted_at" is null and "visitor_blocks"."principal_id" is not null;--> statement-breakpoint
CREATE INDEX "visitor_blocks_visitor_idx" ON "visitor_blocks" USING btree ("tenant_id","brand_id","visitor_id") WHERE "visitor_blocks"."lifted_at" is null and "visitor_blocks"."visitor_id" is not null;--> statement-breakpoint
CREATE INDEX "visitor_blocks_subject_idx" ON "visitor_blocks" USING btree ("tenant_id","brand_id","external_subject") WHERE "visitor_blocks"."lifted_at" is null and "visitor_blocks"."external_subject" is not null;--> statement-breakpoint
CREATE INDEX "visitor_blocks_recent_idx" ON "visitor_blocks" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "visitor_blocks" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));