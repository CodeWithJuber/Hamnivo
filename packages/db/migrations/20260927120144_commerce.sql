CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"merchant_connection_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"currency" text NOT NULL,
	"lines" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "carts_revision_ck" CHECK ("carts"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "carts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"merchant_connection_id" uuid NOT NULL,
	"conversation_id" uuid,
	"query" text,
	"items" jsonb NOT NULL,
	"item_count" integer NOT NULL,
	"source" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_snapshots_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "catalog_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"merchant_connection_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"provider_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"body_hash" "bytea" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" text,
	"last_error" text,
	CONSTRAINT "commerce_events_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "commerce_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_exceptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"operation_id" uuid,
	"order_id" uuid,
	"source_state" text NOT NULL,
	"next_safe_action" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution" text,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_exceptions_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "finance_exceptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "fulfillments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"source" text NOT NULL,
	"estimate_at" timestamp with time zone,
	"carrier_ref" text,
	"note" text,
	"last_update_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillments_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "fulfillments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "merchant_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"provider_account_id" text,
	"capabilities" jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"api_key_secret_id" uuid,
	"webhook_secret_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_connections_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "merchant_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"merchant_connection_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"purchase_intent_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"state" text NOT NULL,
	"payment_state" text NOT NULL,
	"fulfillment_state" text DEFAULT 'not_started' NOT NULL,
	"currency" text NOT NULL,
	"total_minor" bigint NOT NULL,
	"lines" jsonb NOT NULL,
	"delivery_summary" text,
	"merchant_order_ref" text,
	"placed_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_intent_id" uuid NOT NULL,
	"merchant_connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"session_ref" text NOT NULL,
	"payment_ref" text,
	"state" text DEFAULT 'not_started' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"captured_minor" bigint DEFAULT 0 NOT NULL,
	"refunded_minor" bigint DEFAULT 0 NOT NULL,
	"captured_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone,
	"sync_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payments_amounts_ck" CHECK ("payments"."captured_minor" >= 0 and "payments"."refunded_minor" >= 0 and "payments"."refunded_minor" <= "payments"."captured_minor")
);
--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "purchase_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"merchant_connection_id" uuid NOT NULL,
	"cart_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"state" text NOT NULL,
	"approved_hash" "bytea",
	"approved_cart_revision" integer,
	"approved_at" timestamp with time zone,
	"approval_nonce" uuid,
	"approval_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checkout_operation_id" uuid,
	"checkout_session_ref" text,
	"checkout_url" text,
	"checkout_expires_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_intents_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_intents_approval_ck" CHECK ("purchase_intents"."approved_at" is null or ("purchase_intents"."approved_hash" is not null and "purchase_intents"."approval_nonce" is not null))
);
--> statement-breakpoint
ALTER TABLE "purchase_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cart_id" uuid NOT NULL,
	"cart_revision" integer NOT NULL,
	"conversation_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"merchant_connection_id" uuid NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"approver" text DEFAULT 'customer' NOT NULL,
	"currency" text NOT NULL,
	"document" jsonb NOT NULL,
	"hash" "bytea" NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"discount_minor" bigint NOT NULL,
	"tax_minor" bigint,
	"shipping_minor" bigint,
	"total_minor" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "quotes_total_ck" CHECK ("quotes"."total_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "quotes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"state" text DEFAULT 'requested' NOT NULL,
	"client_request_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejected_by" uuid,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text,
	"policy" jsonb NOT NULL,
	"operation_id" uuid,
	"provider_refund_ref" text,
	"failure_reason" text,
	"succeeded_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone,
	"sync_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "refunds_amount_ck" CHECK ("refunds"."amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "operation_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"source" text NOT NULL,
	"provider_ref" text,
	"provider_event_id" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operation_receipts_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "operation_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"business_key" text NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"provider" text,
	"resource_type" text,
	"resource_id" uuid,
	"conversation_id" uuid,
	"owner_epoch" bigint,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"provider_idempotency_key" text NOT NULL,
	"provider_ref" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"reconcile_attempts" integer DEFAULT 0 NOT NULL,
	"dispatched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"next_reconcile_at" timestamp with time zone,
	"last_error_code" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "operations_state_ck" CHECK ("operations"."state" in ('pending', 'dispatched', 'succeeded', 'failed', 'unknown', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."customer_principals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_merchant_fk" FOREIGN KEY ("tenant_id","merchant_connection_id") REFERENCES "public"."merchant_connections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_snapshots" ADD CONSTRAINT "catalog_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_snapshots" ADD CONSTRAINT "catalog_snapshots_merchant_fk" FOREIGN KEY ("tenant_id","merchant_connection_id") REFERENCES "public"."merchant_connections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_snapshots" ADD CONSTRAINT "catalog_snapshots_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_events" ADD CONSTRAINT "commerce_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_events" ADD CONSTRAINT "commerce_events_merchant_fk" FOREIGN KEY ("tenant_id","merchant_connection_id") REFERENCES "public"."merchant_connections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_exceptions" ADD CONSTRAINT "finance_exceptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_exceptions" ADD CONSTRAINT "finance_exceptions_operation_fk" FOREIGN KEY ("tenant_id","operation_id") REFERENCES "public"."operations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_exceptions" ADD CONSTRAINT "finance_exceptions_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_exceptions" ADD CONSTRAINT "finance_exceptions_resolved_by_fk" FOREIGN KEY ("tenant_id","resolved_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_connections" ADD CONSTRAINT "merchant_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_connections" ADD CONSTRAINT "merchant_connections_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."workspaces"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_connections" ADD CONSTRAINT "merchant_connections_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_connections" ADD CONSTRAINT "merchant_connections_api_key_fk" FOREIGN KEY ("tenant_id","api_key_secret_id") REFERENCES "public"."secrets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_connections" ADD CONSTRAINT "merchant_connections_webhook_secret_fk" FOREIGN KEY ("tenant_id","webhook_secret_id") REFERENCES "public"."secrets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_connections" ADD CONSTRAINT "merchant_connections_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."customer_principals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchant_fk" FOREIGN KEY ("tenant_id","merchant_connection_id") REFERENCES "public"."merchant_connections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_intent_fk" FOREIGN KEY ("tenant_id","purchase_intent_id") REFERENCES "public"."purchase_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_quote_fk" FOREIGN KEY ("tenant_id","quote_id") REFERENCES "public"."quotes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_intent_fk" FOREIGN KEY ("tenant_id","purchase_intent_id") REFERENCES "public"."purchase_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_merchant_fk" FOREIGN KEY ("tenant_id","merchant_connection_id") REFERENCES "public"."merchant_connections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_intents" ADD CONSTRAINT "purchase_intents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_intents" ADD CONSTRAINT "purchase_intents_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_intents" ADD CONSTRAINT "purchase_intents_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."customer_principals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_intents" ADD CONSTRAINT "purchase_intents_merchant_fk" FOREIGN KEY ("tenant_id","merchant_connection_id") REFERENCES "public"."merchant_connections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_intents" ADD CONSTRAINT "purchase_intents_cart_fk" FOREIGN KEY ("tenant_id","cart_id") REFERENCES "public"."carts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_intents" ADD CONSTRAINT "purchase_intents_quote_fk" FOREIGN KEY ("tenant_id","quote_id") REFERENCES "public"."quotes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_intents" ADD CONSTRAINT "purchase_intents_operation_fk" FOREIGN KEY ("tenant_id","checkout_operation_id") REFERENCES "public"."operations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_cart_fk" FOREIGN KEY ("tenant_id","cart_id") REFERENCES "public"."carts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."customer_principals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_merchant_fk" FOREIGN KEY ("tenant_id","merchant_connection_id") REFERENCES "public"."merchant_connections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_approved_by_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_rejected_by_fk" FOREIGN KEY ("tenant_id","rejected_by") REFERENCES "public"."staff_members"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_operation_fk" FOREIGN KEY ("tenant_id","operation_id") REFERENCES "public"."operations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_receipts" ADD CONSTRAINT "operation_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_receipts" ADD CONSTRAINT "operation_receipts_operation_fk" FOREIGN KEY ("tenant_id","operation_id") REFERENCES "public"."operations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversation_controls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "carts_one_active_key" ON "carts" USING btree ("tenant_id","conversation_id","principal_id") WHERE "carts"."status" in ('open', 'locked');--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_events_provider_key" ON "commerce_events" USING btree ("tenant_id","merchant_connection_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "commerce_events_pending_idx" ON "commerce_events" USING btree ("available_at") WHERE "commerce_events"."processed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_exceptions_open_key" ON "finance_exceptions" USING btree ("tenant_id","kind","subject_id") WHERE "finance_exceptions"."state" = 'open';--> statement-breakpoint
CREATE INDEX "finance_exceptions_state_idx" ON "finance_exceptions" USING btree ("tenant_id","state","opened_at");--> statement-breakpoint
CREATE INDEX "fulfillments_order_idx" ON "fulfillments" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_connections_brand_active_key" ON "merchant_connections" USING btree ("tenant_id","brand_id") WHERE "merchant_connections"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "orders_reference_key" ON "orders" USING btree ("tenant_id","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_intent_key" ON "orders" USING btree ("tenant_id","purchase_intent_id");--> statement-breakpoint
CREATE INDEX "orders_placed_idx" ON "orders" USING btree ("tenant_id","placed_at");--> statement-breakpoint
CREATE INDEX "orders_conversation_idx" ON "orders" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_intent_key" ON "payments" USING btree ("tenant_id","purchase_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_session_key" ON "payments" USING btree ("tenant_id","merchant_connection_id","session_ref");--> statement-breakpoint
CREATE INDEX "payments_sync_idx" ON "payments" USING btree ("next_sync_at") WHERE "payments"."next_sync_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_intents_quote_key" ON "purchase_intents" USING btree ("tenant_id","quote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_intents_nonce_key" ON "purchase_intents" USING btree ("tenant_id","approval_nonce") WHERE "purchase_intents"."approval_nonce" is not null;--> statement-breakpoint
CREATE INDEX "quotes_cart_idx" ON "quotes" USING btree ("tenant_id","cart_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_client_request_key" ON "refunds" USING btree ("tenant_id","order_id","client_request_id");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "refunds_sync_idx" ON "refunds" USING btree ("next_sync_at") WHERE "refunds"."next_sync_at" is not null;--> statement-breakpoint
CREATE INDEX "operation_receipts_operation_idx" ON "operation_receipts" USING btree ("tenant_id","operation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operations_business_key" ON "operations" USING btree ("tenant_id","business_key");--> statement-breakpoint
CREATE INDEX "operations_reconcile_idx" ON "operations" USING btree ("next_reconcile_at") WHERE "operations"."state" in ('dispatched', 'unknown');--> statement-breakpoint
CREATE INDEX "operations_conversation_idx" ON "operations" USING btree ("tenant_id","conversation_id") WHERE "operations"."conversation_id" is not null;--> statement-breakpoint
CREATE INDEX "operations_resource_idx" ON "operations" USING btree ("tenant_id","resource_type","resource_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "carts" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "catalog_snapshots" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commerce_events" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "finance_exceptions" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fulfillments" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "merchant_connections" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "orders" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payments" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "purchase_intents" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "quotes" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "refunds" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "operation_receipts" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "operations" AS PERMISSIVE FOR ALL TO "hamnivo_app" USING (tenant_id = (select app.current_tenant())) WITH CHECK (tenant_id = (select app.current_tenant()));