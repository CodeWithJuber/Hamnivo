CREATE TABLE "connector_connections" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "label" text NOT NULL,
  "base_url" text NOT NULL,
  "status" text DEFAULT 'disabled' NOT NULL,
  "identifier_secret_id" uuid NOT NULL,
  "token_secret_id" uuid NOT NULL,
  "identity_key_id" uuid NOT NULL,
  "grant_version" integer DEFAULT 1 NOT NULL,
  "last_tested_at" timestamp with time zone,
  "last_error" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "connector_connections_tenant_id_id_key" UNIQUE("tenant_id","id"),
  CONSTRAINT "connector_connections_https_ck" CHECK ("base_url" ~ '^https://[^/?#]+/?$'),
  CONSTRAINT "connector_connections_version_ck" CHECK ("grant_version" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "connector_connections_brand_origin_key" ON "connector_connections" ("tenant_id","brand_id","base_url");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_connections_identity_key_key" ON "connector_connections" ("tenant_id","brand_id","identity_key_id");--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "workspaces"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "brands"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_identifier_fk" FOREIGN KEY ("tenant_id","identifier_secret_id") REFERENCES "secrets"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_token_fk" FOREIGN KEY ("tenant_id","token_secret_id") REFERENCES "secrets"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_key_fk" FOREIGN KEY ("tenant_id","identity_key_id") REFERENCES "brand_identity_keys"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "staff_members"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id");--> statement-breakpoint
ALTER TABLE "connector_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "connector_connections" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint

CREATE TABLE "connector_tool_grants" (
  "id" uuid PRIMARY KEY NOT NULL, "tenant_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL, "tool_id" uuid NOT NULL,
  "capability" text NOT NULL, "version" integer NOT NULL,
  "enabled" text DEFAULT 'yes' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "connector_tool_grants_tenant_id_id_key" UNIQUE("tenant_id","id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "connector_tool_grants_tool_key" ON "connector_tool_grants" ("tenant_id","tool_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_tool_grants_capability_key" ON "connector_tool_grants" ("tenant_id","connection_id","capability");--> statement-breakpoint
ALTER TABLE "connector_tool_grants" ADD CONSTRAINT "connector_tool_grants_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "connector_connections"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "connector_tool_grants" ADD CONSTRAINT "connector_tool_grants_tool_fk" FOREIGN KEY ("tenant_id","tool_id") REFERENCES "tool_definitions"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "connector_tool_grants" ADD CONSTRAINT "connector_tool_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id");--> statement-breakpoint
ALTER TABLE "connector_tool_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "connector_tool_grants" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint

CREATE TABLE "connector_identity_bindings" (
  "id" uuid PRIMARY KEY NOT NULL, "tenant_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL, "connection_id" uuid NOT NULL,
  "principal_id" uuid NOT NULL, "user_id" integer NOT NULL, "client_id" integer NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "connector_identity_bindings_tenant_id_id_key" UNIQUE("tenant_id","id"),
  CONSTRAINT "connector_identity_bindings_ids_ck" CHECK ("user_id" > 0 AND "client_id" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "connector_identity_bindings_principal_key" ON "connector_identity_bindings" ("tenant_id","connection_id","principal_id");--> statement-breakpoint
CREATE INDEX "connector_identity_bindings_expiry_idx" ON "connector_identity_bindings" ("expires_at");--> statement-breakpoint
ALTER TABLE "connector_identity_bindings" ADD CONSTRAINT "connector_identity_bindings_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "connector_connections"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "connector_identity_bindings" ADD CONSTRAINT "connector_identity_bindings_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "customer_principals"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "connector_identity_bindings" ADD CONSTRAINT "connector_identity_bindings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id");--> statement-breakpoint
ALTER TABLE "connector_identity_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "connector_identity_bindings" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint

ALTER TABLE "tool_definitions" DROP CONSTRAINT "tool_definitions_source_ck";--> statement-breakpoint
ALTER TABLE "tool_definitions" ADD CONSTRAINT "tool_definitions_source_ck" CHECK (
  (source = 'builtin' AND builtin IS NOT NULL AND mcp_server_id IS NULL)
  OR (source = 'mcp' AND mcp_server_id IS NOT NULL AND remote_name IS NOT NULL)
  OR (source = 'http' AND builtin IS NULL AND mcp_server_id IS NULL)
  OR (source = 'native' AND builtin IS NULL AND mcp_server_id IS NULL AND remote_name IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "connector_quotes" (
  "id" uuid PRIMARY KEY NOT NULL, "tenant_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL, "principal_id" uuid NOT NULL, "conversation_id" uuid NOT NULL,
  "fingerprint" text NOT NULL, "price" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL, "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "connector_quotes" ADD CONSTRAINT "connector_quotes_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "connector_connections"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "connector_quotes" ADD CONSTRAINT "connector_quotes_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "customer_principals"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "connector_quotes" ADD CONSTRAINT "connector_quotes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id");--> statement-breakpoint
ALTER TABLE "connector_quotes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "connector_quotes" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));
--> statement-breakpoint
CREATE TABLE "connector_dispatches" (
  "id" uuid PRIMARY KEY NOT NULL, "tenant_id" uuid NOT NULL, "connection_id" uuid NOT NULL,
  "principal_id" uuid NOT NULL, "fingerprint" text NOT NULL, "idempotency_key" text NOT NULL,
  "state" text NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "connector_dispatches_idempotency_key" ON "connector_dispatches" ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "connector_dispatches_pending_idx" ON "connector_dispatches" ("tenant_id","connection_id","principal_id","fingerprint","state");--> statement-breakpoint
ALTER TABLE "connector_dispatches" ADD CONSTRAINT "connector_dispatches_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "connector_connections"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "connector_dispatches" ADD CONSTRAINT "connector_dispatches_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "customer_principals"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "connector_dispatches" ADD CONSTRAINT "connector_dispatches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id");--> statement-breakpoint
ALTER TABLE "connector_dispatches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "connector_dispatches" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));
