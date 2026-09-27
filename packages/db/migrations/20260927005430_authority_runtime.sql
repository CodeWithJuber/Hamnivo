ALTER TABLE "conversation_controls" DROP CONSTRAINT "conversation_controls_human_owner_ck";--> statement-breakpoint
ALTER TABLE "authority_contacts" ALTER COLUMN "external_contact_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "authority_bots" ADD COLUMN "webhook_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "authority_inboxes" ADD COLUMN "webhook_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_controls" ADD COLUMN "owner_synced_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_controls" ADD COLUMN "owner_external_user_id" integer;--> statement-breakpoint
ALTER TABLE "conversation_controls" ADD COLUMN "staff_journal_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_controls" ADD COLUMN "agent_journal_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "authority_bots" ADD CONSTRAINT "authority_bots_webhook_secret_fk" FOREIGN KEY ("tenant_id","webhook_secret_id") REFERENCES "public"."secrets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authority_inboxes" ADD CONSTRAINT "authority_inboxes_webhook_secret_fk" FOREIGN KEY ("tenant_id","webhook_secret_id") REFERENCES "public"."secrets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_journal" DROP CONSTRAINT "conversation_journal_pkey";
--> statement-breakpoint
ALTER TABLE "conversation_journal" ADD CONSTRAINT "conversation_journal_pkey" PRIMARY KEY("tenant_id","conversation_id","lane","seq");--> statement-breakpoint
ALTER TABLE "conversation_controls" ADD CONSTRAINT "conversation_controls_human_owner_ck" CHECK ("conversation_controls"."owner_mode" <> 'HUMAN_ACTIVE' or "conversation_controls"."owner_staff_id" is not null or "conversation_controls"."owner_external_user_id" is not null);