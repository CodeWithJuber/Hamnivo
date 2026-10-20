ALTER TABLE brand_appearance ADD COLUMN draft_appearance jsonb;
--> statement-breakpoint
ALTER TABLE brand_appearance ADD COLUMN draft_revision integer NOT NULL DEFAULT 0;
