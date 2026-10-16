import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { tenantId } from './tenancy.js';

export const OPERATION_STATES = [
  'pending',
  'dispatched',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export const OPERATION_ACTORS = ['customer', 'staff', 'ai', 'system'] as const;

/**
 * The operation ledger (C07): one row per external call with a side effect (a checkout session,
 * a refund, and later tool calls). The business key is durable and unique, so a retry reuses the
 * row and its provider idempotency key long after the provider has forgotten that key. A call
 * whose answer was lost is `unknown` until the provider is asked (next_reconcile_at), never sent
 * again blindly. The conversation and its ownership epoch at dispatch are kept, so a takeover
 * leaves the operation visible and reconciled under the new owner (R07).
 */
export const operations = pgTable(
  'operations',
  {
    id: id(),
    tenantId: tenantId(),
    /** What the call does, e.g. `commerce.checkout.create`, `commerce.refund.create`. */
    kind: text('kind').notNull(),
    /** Durable business identity, e.g. `checkout:{intentId}`; unique per tenant. */
    businessKey: text('business_key').notNull(),
    /** SHA-256 of the request's canonical form: the same key with other content is refused. */
    requestHash: bytea('request_hash').notNull(),
    state: text('state', { enum: OPERATION_STATES }).notNull().default('pending'),
    provider: text('provider'),
    /** The record the operation acts for, e.g. `purchase_intent` or `refund`. */
    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),
    conversationId: uuid('conversation_id'),
    /** Conversation ownership epoch when the operation was created. */
    ownerEpoch: bigint('owner_epoch', { mode: 'number' }),
    actorType: text('actor_type', { enum: OPERATION_ACTORS }).notNull(),
    actorId: text('actor_id'),
    /** Sent as the provider's idempotency key on every attempt. */
    providerIdempotencyKey: text('provider_idempotency_key').notNull(),
    /** The provider object created (session, refund…), once known. */
    providerRef: text('provider_ref'),
    attempts: integer('attempts').notNull().default(0),
    reconcileAttempts: integer('reconcile_attempts').notNull().default(0),
    dispatchedAt: tstz('dispatched_at'),
    completedAt: tstz('completed_at'),
    nextReconcileAt: tstz('next_reconcile_at'),
    lastErrorCode: text('last_error_code'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('operations_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('operations_business_key').on(t.tenantId, t.businessKey),
    index('operations_reconcile_idx')
      .on(t.nextReconcileAt)
      .where(sql`${t.state} in ('dispatched', 'unknown')`),
    index('operations_conversation_idx')
      .on(t.tenantId, t.conversationId)
      .where(sql`${t.conversationId} is not null`),
    index('operations_resource_idx').on(t.tenantId, t.resourceType, t.resourceId),
    check(
      'operations_state_ck',
      sql`${t.state} in ('pending', 'dispatched', 'succeeded', 'failed', 'unknown', 'cancelled')`,
    ),
    tenantIsolation(),
  ],
);

export const RECEIPT_KINDS = ['dispatch', 'response', 'webhook', 'reconcile', 'manual'] as const;
export const RECEIPT_OUTCOMES = ['pending', 'succeeded', 'failed', 'unknown'] as const;
export const RECEIPT_SOURCES = ['provider_api', 'provider_webhook', 'reconciler', 'staff'] as const;

/**
 * Receipts: what was observed about an operation, from where and when (X10). Append-only (no
 * update or delete for the application role). "Paid" or "refunded" is claimed only when a
 * succeeded receipt from the provider exists; a staff resolution is recorded as such.
 */
export const operationReceipts = pgTable(
  'operation_receipts',
  {
    id: id(),
    tenantId: tenantId(),
    operationId: uuid('operation_id').notNull(),
    kind: text('kind', { enum: RECEIPT_KINDS }).notNull(),
    outcome: text('outcome', { enum: RECEIPT_OUTCOMES }).notNull(),
    source: text('source', { enum: RECEIPT_SOURCES }).notNull(),
    providerRef: text('provider_ref'),
    providerEventId: text('provider_event_id'),
    /** Non-sensitive facts only: provider status, amount, currency, error kind. */
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    observedAt: tstz('observed_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('operation_receipts_tenant_id_id_key').on(t.tenantId, t.id),
    index('operation_receipts_operation_idx').on(t.tenantId, t.operationId, t.createdAt),
    foreignKey({
      name: 'operation_receipts_operation_fk',
      columns: [t.tenantId, t.operationId],
      foreignColumns: [operations.tenantId, operations.id],
    }),
    tenantIsolation(),
  ],
);
