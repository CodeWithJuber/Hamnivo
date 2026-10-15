CREATE TABLE "conversation_offers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"handoff_epoch" bigint NOT NULL,
	"round" smallint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"decline_reason" text,
	"decline_note" text,
	"cancel_reason" text,
	"offered_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"timeout_seconds" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_offers_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "conversation_offers_round_ck" CHECK ("conversation_offers"."round" between 1 and 10),
	CONSTRAINT "conversation_offers_state_ck" CHECK (("conversation_offers"."state" = 'pending') = ("conversation_offers"."decided_at" is null)
        and ("conversation_offers"."state" = 'declined') = ("conversation_offers"."decline_reason" is not null)
        and ("conversation_offers"."state" = 'cancelled') = ("conversation_offers"."cancel_reason" is not null)
        and ("conversation_offers"."decline_note" is null or char_length("conversation_offers"."decline_note") <= 500)
        and "conversation_offers"."expires_at" > "conversation_offers"."offered_at")
);
--> statement-breakpoint
ALTER TABLE "conversation_offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_routing_profiles" (
	"tenant_id" uuid NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_open_chats" smallint,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_routing_profiles_pkey" PRIMARY KEY("tenant_id","staff_member_id"),
	CONSTRAINT "staff_routing_profiles_max_ck" CHECK ("staff_routing_profiles"."max_open_chats" is null or "staff_routing_profiles"."max_open_chats" between 1 and 50),
	CONSTRAINT "staff_routing_profiles_languages_ck" CHECK (cardinality("staff_routing_profiles"."languages") <= 12)
);
--> statement-breakpoint
ALTER TABLE "staff_routing_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD COLUMN "offers_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_inbox_state" ADD COLUMN "offers_ended_epoch" bigint;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "assignment_mode" text DEFAULT 'queue' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "offer_timeout_seconds" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_offers" ADD CONSTRAINT "conversation_offers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_offers" ADD CONSTRAINT "conversation_offers_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_offers" ADD CONSTRAINT "conversation_offers_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "public"."teams"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_offers" ADD CONSTRAINT "conversation_offers_staff_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_routing_profiles" ADD CONSTRAINT "staff_routing_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_routing_profiles" ADD CONSTRAINT "staff_routing_profiles_staff_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_routing_profiles" ADD CONSTRAINT "staff_routing_profiles_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_offers_pending_key" ON "conversation_offers" USING btree ("tenant_id","conversation_id") WHERE "conversation_offers"."state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_offers_round_key" ON "conversation_offers" USING btree ("tenant_id","conversation_id","handoff_epoch","round");--> statement-breakpoint
CREATE INDEX "conversation_offers_staff_idx" ON "conversation_offers" USING btree ("tenant_id","staff_member_id","offered_at");--> statement-breakpoint
CREATE INDEX "conversation_offers_ended_idx" ON "conversation_offers" USING btree ("decided_at") WHERE "conversation_offers"."decided_at" is not null;--> statement-breakpoint
CREATE INDEX "conversation_controls_owner_staff_idx" ON "conversation_controls" USING btree ("tenant_id","owner_staff_id") WHERE "conversation_controls"."owner_mode" = 'HUMAN_ACTIVE';--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_offer_timeout_ck" CHECK ("teams"."offer_timeout_seconds" between 15 and 600);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversation_offers" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "staff_routing_profiles" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));