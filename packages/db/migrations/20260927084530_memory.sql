CREATE TABLE "deletion_tombstones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"deletion_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"memory_key" text,
	"source_event_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"fingerprints" text[] DEFAULT '{}'::text[] NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_tombstones_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "deletion_tombstones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "learning_consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"state" text NOT NULL,
	"notice_version" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_consents_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "learning_consents_scope_ck" CHECK ("learning_consents"."scope" in ('personal_memory', 'tenant_improvement', 'global_contribution', 'model_training')),
	CONSTRAINT "learning_consents_state_ck" CHECK ("learning_consents"."state" in ('granted', 'declined', 'withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "learning_consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memory_deletions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"reason" text NOT NULL,
	"requested_by_type" text NOT NULL,
	"requested_by_id" text,
	"record_count" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"steps" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "memory_deletions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "memory_deletions_status_ck" CHECK ("memory_deletions"."status" in ('pending', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "memory_deletions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memory_embeddings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"embedding" vector(768) NOT NULL,
	"embedding_model" text NOT NULL,
	"content_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_embeddings_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "memory_embeddings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memory_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"conversation_id" uuid,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"content_hash" "bytea" NOT NULL,
	"source_type" text NOT NULL,
	"source_event_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"evidence_status" text NOT NULL,
	"written_by_type" text NOT NULL,
	"written_by_id" text,
	"write_reason" text NOT NULL,
	"write_note" text,
	"purpose" text NOT NULL,
	"allowed_purposes" text[] NOT NULL,
	"allowed_roles" text[] NOT NULL,
	"access_grant_id" uuid,
	"subject_acl_ref" text,
	"sensitivity" text NOT NULL,
	"retention_class" text NOT NULL,
	"expires_at" timestamp with time zone,
	"policy_version" text NOT NULL,
	"status" text NOT NULL,
	"review_status" text NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"confidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"superseded_by_id" uuid,
	"observed_at" timestamp with time zone NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"last_confirmed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', replace("key", '_', ' ') || ' ' || coalesce("payload"->>'value', ''))) STORED,
	CONSTRAINT "memory_records_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "memory_records_status_ck" CHECK ("memory_records"."status" in ('active', 'pending', 'superseded', 'outdated')),
	CONSTRAINT "memory_records_kind_ck" CHECK ("memory_records"."kind" in ('observation', 'episode', 'claim', 'preference', 'procedure', 'commitment', 'constraint', 'outcome', 'correction')),
	CONSTRAINT "memory_records_scope_ck" CHECK ("memory_records"."scope" in ('session', 'conversation', 'person', 'team', 'tenant')),
	CONSTRAINT "memory_records_sensitivity_ck" CHECK ("memory_records"."sensitivity" in ('normal', 'personal')),
	CONSTRAINT "memory_records_validity_ck" CHECK ("memory_records"."valid_until" is null or "memory_records"."valid_until" >= "memory_records"."valid_from"),
	CONSTRAINT "memory_records_version_ck" CHECK ("memory_records"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "memory_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deletion_tombstones" ADD CONSTRAINT "deletion_tombstones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_tombstones" ADD CONSTRAINT "deletion_tombstones_deletion_fk" FOREIGN KEY ("tenant_id","deletion_id") REFERENCES "public"."memory_deletions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_consents" ADD CONSTRAINT "learning_consents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_consents" ADD CONSTRAINT "learning_consents_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_consents" ADD CONSTRAINT "learning_consents_subject_fk" FOREIGN KEY ("tenant_id","subject_id") REFERENCES "public"."customer_principals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_deletions" ADD CONSTRAINT "memory_deletions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_deletions" ADD CONSTRAINT "memory_deletions_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_memory_fk" FOREIGN KEY ("tenant_id","memory_id") REFERENCES "public"."memory_records"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."workspaces"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_subject_fk" FOREIGN KEY ("tenant_id","subject_id") REFERENCES "public"."customer_principals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_tombstones_record_key" ON "deletion_tombstones" USING btree ("tenant_id","target_id") WHERE "deletion_tombstones"."target_type" = 'memory_record';--> statement-breakpoint
CREATE INDEX "deletion_tombstones_subject_idx" ON "deletion_tombstones" USING btree ("tenant_id","subject_id");--> statement-breakpoint
CREATE INDEX "learning_consents_subject_idx" ON "learning_consents" USING btree ("tenant_id","subject_id","scope","created_at");--> statement-breakpoint
CREATE INDEX "memory_deletions_subject_idx" ON "memory_deletions" USING btree ("tenant_id","subject_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_embeddings_model_key" ON "memory_embeddings" USING btree ("tenant_id","memory_id","embedding_model");--> statement-breakpoint
CREATE INDEX "memory_embeddings_subject_idx" ON "memory_embeddings" USING btree ("tenant_id","subject_id");--> statement-breakpoint
CREATE INDEX "memory_embeddings_embedding_idx" ON "memory_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "memory_records_one_active_person_key" ON "memory_records" USING btree ("tenant_id","subject_id","key") WHERE "memory_records"."status" = 'active' and "memory_records"."scope" = 'person';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_records_one_active_conversation_key" ON "memory_records" USING btree ("tenant_id","subject_id","key","conversation_id") WHERE "memory_records"."status" = 'active' and "memory_records"."scope" = 'conversation';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_records_one_pending_key" ON "memory_records" USING btree ("tenant_id","subject_id","key") WHERE "memory_records"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "memory_records_subject_idx" ON "memory_records" USING btree ("tenant_id","subject_id","status");--> statement-breakpoint
CREATE INDEX "memory_records_brand_idx" ON "memory_records" USING btree ("tenant_id","brand_id");--> statement-breakpoint
CREATE INDEX "memory_records_expiry_idx" ON "memory_records" USING btree ("expires_at") WHERE "memory_records"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "memory_records_search_idx" ON "memory_records" USING gin ("search");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "deletion_tombstones" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "learning_consents" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memory_deletions" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memory_embeddings" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memory_records" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));