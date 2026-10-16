CREATE TABLE "erasure_tombstones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"authority" jsonb DEFAULT '{"contacts":[],"conversations":[]}'::jsonb NOT NULL,
	"fingerprints" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "erasure_tombstones_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "erasure_tombstones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"raw" "bytea",
	"sha256" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"purge_after" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_files_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "privacy_files_size_ck" CHECK ("privacy_files"."byte_size" >= 0)
);
--> statement-breakpoint
ALTER TABLE "privacy_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"reason" text NOT NULL,
	"reference" text,
	"requested_by" uuid,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"problem" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "privacy_requests_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "privacy_requests_reference_ck" CHECK ("privacy_requests"."reference" is null or char_length("privacy_requests"."reference") between 1 and 80),
	CONSTRAINT "privacy_requests_attempts_ck" CHECK ("privacy_requests"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "privacy_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_principals" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "erasure_tombstones" ADD CONSTRAINT "erasure_tombstones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_tombstones" ADD CONSTRAINT "erasure_tombstones_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."privacy_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_files" ADD CONSTRAINT "privacy_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_files" ADD CONSTRAINT "privacy_files_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."privacy_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "erasure_tombstones_request_key" ON "erasure_tombstones" USING btree ("tenant_id","request_id");--> statement-breakpoint
CREATE INDEX "erasure_tombstones_principal_idx" ON "erasure_tombstones" USING btree ("tenant_id","principal_id");--> statement-breakpoint
CREATE INDEX "erasure_tombstones_fingerprints_idx" ON "erasure_tombstones" USING gin ("fingerprints");--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_files_request_key" ON "privacy_files" USING btree ("tenant_id","request_id");--> statement-breakpoint
CREATE INDEX "privacy_requests_created_idx" ON "privacy_requests" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "privacy_requests_principal_idx" ON "privacy_requests" USING btree ("tenant_id","principal_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "erasure_tombstones" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "privacy_files" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "privacy_requests" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));