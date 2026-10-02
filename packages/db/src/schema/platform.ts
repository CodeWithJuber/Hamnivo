import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, createdAt, id, platformRead, tenantIsolation, tstz } from './helpers.js';
import { tenantId } from './tenancy.js';

/** Transactional outbox: written in the same transaction as the state change it announces. */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: id(),
    tenantId: tenantId(),
    topic: text('topic').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').notNull(),
    headers: jsonb('headers').notNull().default({}),
    createdAt: createdAt(),
    availableAt: tstz('available_at').notNull().defaultNow(),
    lockedUntil: tstz('locked_until'),
    attempts: integer('attempts').notNull().default(0),
    processedAt: tstz('processed_at'),
    lastError: text('last_error'),
  },
  (t) => [
    unique('outbox_events_tenant_id_id_key').on(t.tenantId, t.id),
    index('outbox_events_pending_idx').on(t.availableAt).where(sql`${t.processedAt} is null`),
    tenantIsolation(),
    // Queue backlog for platform health; column grants leave out payloads and headers.
    platformRead(),
  ],
);

/** Consumer-side deduplication (inbox pattern) for events handled at least once. */
export const processedEvents = pgTable(
  'processed_events',
  {
    tenantId: tenantId(),
    consumer: text('consumer').notNull(),
    eventId: uuid('event_id').notNull(),
    processedAt: tstz('processed_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'processed_events_pkey', columns: [t.tenantId, t.consumer, t.eventId] }),
    tenantIsolation(),
  ],
);

/** `Idempotency-Key` records for mutating API requests. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    tenantId: tenantId(),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: bytea('request_hash').notNull(),
    status: text('status', { enum: ['in_progress', 'completed'] })
      .notNull()
      .default('in_progress'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: createdAt(),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'idempotency_keys_pkey', columns: [t.tenantId, t.scope, t.key] }),
    index('idempotency_keys_expires_idx').on(t.expiresAt),
    tenantIsolation(),
  ],
);

/** Metered usage for plans, budgets and billing; deduplicated per source event. */
export const usageEntries = pgTable(
  'usage_entries',
  {
    id: id(),
    tenantId: tenantId(),
    meter: text('meter').notNull(),
    quantity: bigint('quantity', { mode: 'number' }).notNull(),
    unit: text('unit').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    sourceRef: text('source_ref'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('usage_entries_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('usage_entries_dedupe_key').on(t.tenantId, t.dedupeKey),
    index('usage_entries_meter_idx').on(t.tenantId, t.meter, t.occurredAt),
    tenantIsolation(),
    platformRead(),
  ],
);
