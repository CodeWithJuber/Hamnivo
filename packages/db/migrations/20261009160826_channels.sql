ALTER TABLE "authority_inboxes" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "authority_inboxes" ADD COLUMN "display_address" text;--> statement-breakpoint
ALTER TABLE "authority_inboxes" ADD COLUMN "ai_answers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "authority_inboxes" ADD COLUMN "default_team_id" uuid;--> statement-breakpoint
ALTER TABLE "authority_inboxes" ADD COLUMN "last_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "authority_inboxes" ADD COLUMN "health" jsonb;--> statement-breakpoint
ALTER TABLE "authority_inboxes" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_principals" ADD COLUMN "channel_kind" text;--> statement-breakpoint
ALTER TABLE "customer_principals" ADD COLUMN "channel_handle" "citext";--> statement-breakpoint
CREATE UNIQUE INDEX "customer_principals_channel_key" ON "customer_principals" USING btree ("tenant_id","brand_id","channel_kind","channel_handle") WHERE "customer_principals"."channel_handle" is not null;--> statement-breakpoint
ALTER TABLE "customer_principals" ADD CONSTRAINT "customer_principals_channel_ck" CHECK (("customer_principals"."kind" = 'channel') = ("customer_principals"."channel_handle" is not null and "customer_principals"."channel_kind" is not null));