CREATE TABLE "brand_install_sightings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_install_sightings_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "brand_install_sightings_origin_ck" CHECK (char_length("brand_install_sightings"."origin") between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "brand_install_sightings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "brand_install_sightings" ADD CONSTRAINT "brand_install_sightings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_install_sightings" ADD CONSTRAINT "brand_install_sightings_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_install_sightings_origin_key" ON "brand_install_sightings" USING btree ("tenant_id","brand_id","origin");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "brand_install_sightings" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));