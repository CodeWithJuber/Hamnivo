CREATE TABLE "http_tool_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"operation_id" text,
	"method" text NOT NULL,
	"path_template" text NOT NULL,
	"parameters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"body_mode" text DEFAULT 'none' NOT NULL,
	"body_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "http_tool_endpoints_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "http_tool_endpoints_path_ck" CHECK ("http_tool_endpoints"."path_template" ~ '^/')
);
--> statement-breakpoint
ALTER TABLE "http_tool_endpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "http_tool_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"base_url" text NOT NULL,
	"auth_kind" text DEFAULT 'none' NOT NULL,
	"auth_header" text,
	"auth_secret_id" uuid,
	"spec_title" text,
	"spec_version" text,
	"spec_hash" "bytea",
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "http_tool_sources_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "http_tool_sources_url_ck" CHECK ("http_tool_sources"."base_url" ~ '^https?://'),
	CONSTRAINT "http_tool_sources_auth_ck" CHECK (("http_tool_sources"."auth_kind" = 'none') = ("http_tool_sources"."auth_secret_id" is null))
);
--> statement-breakpoint
ALTER TABLE "http_tool_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge_web_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"web_source_id" uuid NOT NULL,
	"url" text NOT NULL,
	"document_id" uuid,
	"depth" integer DEFAULT 0 NOT NULL,
	"etag" text,
	"last_modified" text,
	"content_hash" "bytea",
	"last_fetched_at" timestamp with time zone,
	"last_status" integer,
	"last_error" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"gone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_web_pages_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_web_pages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge_web_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"start_url" text NOT NULL,
	"mode" text NOT NULL,
	"max_pages" integer DEFAULT 50 NOT NULL,
	"max_depth" integer DEFAULT 2 NOT NULL,
	"schedule" text DEFAULT 'manual' NOT NULL,
	"next_run_at" timestamp with time zone,
	"state" text DEFAULT 'idle' NOT NULL,
	"lease_until" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_result" text,
	"last_run" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_web_sources_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "knowledge_web_sources_url_ck" CHECK ("knowledge_web_sources"."start_url" ~ '^https?://'),
	CONSTRAINT "knowledge_web_sources_limits_ck" CHECK ("knowledge_web_sources"."max_pages" between 1 and 500 and "knowledge_web_sources"."max_depth" between 0 and 5)
);
--> statement-breakpoint
ALTER TABLE "knowledge_web_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mcp_catalog_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"description" text,
	"mime_type" text,
	"size_bytes" integer,
	"arguments" jsonb,
	"ai_readable" boolean DEFAULT false NOT NULL,
	"listed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_catalog_items_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "mcp_catalog_items_ai_ck" CHECK (not "mcp_catalog_items"."ai_readable" or "mcp_catalog_items"."kind" = 'resource')
);
--> statement-breakpoint
ALTER TABLE "mcp_catalog_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mcp_oauth_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"state_hash" "bytea" NOT NULL,
	"verifier_secret_id" uuid NOT NULL,
	"client_secret_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"registration" text NOT NULL,
	"authorization_server" text NOT NULL,
	"resource" text NOT NULL,
	"scope" text,
	"discovery" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_attempts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "mcp_oauth_attempts_hash_ck" CHECK (octet_length("mcp_oauth_attempts"."state_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "mcp_oauth_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mcp_server_oauth" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"authorization_server" text NOT NULL,
	"resource" text NOT NULL,
	"client_id" text NOT NULL,
	"registration" text NOT NULL,
	"client_secret_id" uuid NOT NULL,
	"refresh_secret_id" uuid,
	"scope" text,
	"discovery" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"access_expires_at" timestamp with time zone,
	"connected_by" uuid,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_server_oauth_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "mcp_server_oauth" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_definitions" DROP CONSTRAINT "tool_definitions_source_ck";--> statement-breakpoint
ALTER TABLE "http_tool_endpoints" ADD CONSTRAINT "http_tool_endpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "http_tool_endpoints" ADD CONSTRAINT "http_tool_endpoints_source_fk" FOREIGN KEY ("tenant_id","source_id") REFERENCES "public"."http_tool_sources"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "http_tool_endpoints" ADD CONSTRAINT "http_tool_endpoints_tool_fk" FOREIGN KEY ("tenant_id","tool_id") REFERENCES "public"."tool_definitions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "http_tool_sources" ADD CONSTRAINT "http_tool_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "http_tool_sources" ADD CONSTRAINT "http_tool_sources_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."workspaces"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "http_tool_sources" ADD CONSTRAINT "http_tool_sources_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "http_tool_sources" ADD CONSTRAINT "http_tool_sources_auth_fk" FOREIGN KEY ("tenant_id","auth_secret_id") REFERENCES "public"."secrets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "http_tool_sources" ADD CONSTRAINT "http_tool_sources_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_web_pages" ADD CONSTRAINT "knowledge_web_pages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_web_pages" ADD CONSTRAINT "knowledge_web_pages_source_fk" FOREIGN KEY ("tenant_id","web_source_id") REFERENCES "public"."knowledge_web_sources"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_web_pages" ADD CONSTRAINT "knowledge_web_pages_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."knowledge_documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_web_sources" ADD CONSTRAINT "knowledge_web_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_web_sources" ADD CONSTRAINT "knowledge_web_sources_source_fk" FOREIGN KEY ("tenant_id","source_id") REFERENCES "public"."knowledge_sources"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_web_sources" ADD CONSTRAINT "knowledge_web_sources_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_catalog_items" ADD CONSTRAINT "mcp_catalog_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_catalog_items" ADD CONSTRAINT "mcp_catalog_items_server_fk" FOREIGN KEY ("tenant_id","mcp_server_id") REFERENCES "public"."mcp_servers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_attempts" ADD CONSTRAINT "mcp_oauth_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_attempts" ADD CONSTRAINT "mcp_oauth_attempts_server_fk" FOREIGN KEY ("tenant_id","mcp_server_id") REFERENCES "public"."mcp_servers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_attempts" ADD CONSTRAINT "mcp_oauth_attempts_staff_fk" FOREIGN KEY ("tenant_id","staff_member_id") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_attempts" ADD CONSTRAINT "mcp_oauth_attempts_verifier_fk" FOREIGN KEY ("tenant_id","verifier_secret_id") REFERENCES "public"."secrets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_attempts" ADD CONSTRAINT "mcp_oauth_attempts_client_fk" FOREIGN KEY ("tenant_id","client_secret_id") REFERENCES "public"."secrets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_oauth" ADD CONSTRAINT "mcp_server_oauth_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_oauth" ADD CONSTRAINT "mcp_server_oauth_server_fk" FOREIGN KEY ("tenant_id","mcp_server_id") REFERENCES "public"."mcp_servers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_oauth" ADD CONSTRAINT "mcp_server_oauth_client_secret_fk" FOREIGN KEY ("tenant_id","client_secret_id") REFERENCES "public"."secrets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_oauth" ADD CONSTRAINT "mcp_server_oauth_refresh_secret_fk" FOREIGN KEY ("tenant_id","refresh_secret_id") REFERENCES "public"."secrets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_oauth" ADD CONSTRAINT "mcp_server_oauth_connected_by_fk" FOREIGN KEY ("tenant_id","connected_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "http_tool_endpoints_tool_key" ON "http_tool_endpoints" USING btree ("tenant_id","tool_id");--> statement-breakpoint
CREATE UNIQUE INDEX "http_tool_endpoints_route_key" ON "http_tool_endpoints" USING btree ("tenant_id","source_id","method","path_template");--> statement-breakpoint
CREATE UNIQUE INDEX "http_tool_sources_name_key" ON "http_tool_sources" USING btree ("tenant_id","brand_id","name") WHERE "http_tool_sources"."status" <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_web_pages_url_key" ON "knowledge_web_pages" USING btree ("tenant_id","web_source_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_web_sources_source_key" ON "knowledge_web_sources" USING btree ("tenant_id","source_id");--> statement-breakpoint
CREATE INDEX "knowledge_web_sources_due_idx" ON "knowledge_web_sources" USING btree ("next_run_at") WHERE "knowledge_web_sources"."schedule" <> 'manual';--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_catalog_items_key" ON "mcp_catalog_items" USING btree ("tenant_id","mcp_server_id","kind","key");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_attempts_state_key" ON "mcp_oauth_attempts" USING btree ("tenant_id","state_hash");--> statement-breakpoint
CREATE INDEX "mcp_oauth_attempts_server_idx" ON "mcp_oauth_attempts" USING btree ("tenant_id","mcp_server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_oauth_server_key" ON "mcp_server_oauth" USING btree ("tenant_id","mcp_server_id");--> statement-breakpoint
ALTER TABLE "tool_definitions" ADD CONSTRAINT "tool_definitions_source_ck" CHECK (("tool_definitions"."source" = 'builtin' and "tool_definitions"."builtin" is not null and "tool_definitions"."mcp_server_id" is null)
        or ("tool_definitions"."source" = 'mcp' and "tool_definitions"."mcp_server_id" is not null and "tool_definitions"."remote_name" is not null)
        or ("tool_definitions"."source" = 'http' and "tool_definitions"."builtin" is null and "tool_definitions"."mcp_server_id" is null));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "http_tool_endpoints" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "http_tool_sources" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "knowledge_web_pages" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "knowledge_web_sources" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mcp_catalog_items" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mcp_oauth_attempts" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mcp_server_oauth" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));