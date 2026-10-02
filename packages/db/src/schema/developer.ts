import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { secrets, staffMembers } from './identity.js';
import { tenantId } from './tenancy.js';

/**
 * Outgoing webhooks (D06) and the network egress allowlist (X05). Events come from the
 * transactional outbox; each event is delivered at least once to every subscribed endpoint, signed
 * per Standard Webhooks with the endpoint's secret from the secret broker.
 */

export const WEBHOOK_DISABLED_REASONS = ['manual', 'failing', 'gone'] as const;

/** A tenant's HTTPS endpoint and the event types it receives. */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: id(),
    tenantId: tenantId(),
    url: text('url').notNull(),
    description: text('description'),
    eventTypes: text('event_types').array().notNull(),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    disabledReason: text('disabled_reason', { enum: WEBHOOK_DISABLED_REASONS }),
    disabledAt: tstz('disabled_at'),
    /** The `whsec_…` signing secret, envelope-encrypted in `secrets`. */
    secretId: uuid('secret_id').notNull(),
    /** After a rotation, the old secret also signs until `previous_secret_expires_at`. */
    previousSecretId: uuid('previous_secret_id'),
    previousSecretExpiresAt: tstz('previous_secret_expires_at'),
    secretRotatedAt: tstz('secret_rotated_at'),
    /** When a signed test event was last answered with 2xx. */
    verifiedAt: tstz('verified_at'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    failingSince: tstz('failing_since'),
    lastSuccessAt: tstz('last_success_at'),
    lastFailureAt: tstz('last_failure_at'),
    createdBy: uuid('created_by'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('webhook_endpoints_tenant_id_id_key').on(t.tenantId, t.id),
    index('webhook_endpoints_active_idx').on(t.tenantId).where(sql`${t.status} = 'active'`),
    foreignKey({
      name: 'webhook_endpoints_secret_fk',
      columns: [t.tenantId, t.secretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'webhook_endpoints_previous_secret_fk',
      columns: [t.tenantId, t.previousSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'webhook_endpoints_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check(
      'webhook_endpoints_disabled_ck',
      sql`(${t.status} = 'disabled') = (${t.disabledReason} is not null)`,
    ),
    check('webhook_endpoints_events_ck', sql`cardinality(${t.eventTypes}) > 0`),
    tenantIsolation(),
  ],
);

/**
 * One event as sent to endpoints. `body` is the exact JSON that is signed, kept until
 * `expires_at` so failed deliveries can be replayed; after that only the metadata remains.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: id(),
    tenantId: tenantId(),
    type: text('type').notNull(),
    /** What produced the event (outbox event id), so a retried fan-out creates it once. */
    sourceKey: text('source_key').notNull(),
    body: text('body'),
    occurredAt: tstz('occurred_at').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('webhook_events_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('webhook_events_source_key').on(t.tenantId, t.sourceKey),
    index('webhook_events_created_idx').on(t.tenantId, t.createdAt),
    index('webhook_events_expires_idx').on(t.expiresAt).where(sql`${t.body} is not null`),
    tenantIsolation(),
  ],
);

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'succeeded', 'failed', 'cancelled'] as const;

/** One event for one endpoint: attempted until it succeeds, fails for good or is cancelled. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    tenantId: tenantId(),
    endpointId: uuid('endpoint_id').notNull(),
    eventId: uuid('event_id').notNull(),
    status: text('status', { enum: WEBHOOK_DELIVERY_STATUSES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** When the next attempt is due (pending only); also moved forward while leased. */
    nextAttemptAt: tstz('next_attempt_at'),
    lastAttemptAt: tstz('last_attempt_at'),
    lastStatusCode: integer('last_status_code'),
    lastOutcome: text('last_outcome'),
    succeededAt: tstz('succeeded_at'),
    /** A replay repeats this delivery (same event, same `webhook-id`). */
    replayOf: uuid('replay_of'),
    requestedBy: uuid('requested_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('webhook_deliveries_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('webhook_deliveries_first_key')
      .on(t.tenantId, t.endpointId, t.eventId)
      .where(sql`${t.replayOf} is null`),
    index('webhook_deliveries_due_idx').on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
    index('webhook_deliveries_endpoint_idx').on(t.tenantId, t.endpointId, t.createdAt),
    index('webhook_deliveries_event_idx').on(t.tenantId, t.eventId),
    foreignKey({
      name: 'webhook_deliveries_endpoint_fk',
      columns: [t.tenantId, t.endpointId],
      foreignColumns: [webhookEndpoints.tenantId, webhookEndpoints.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'webhook_deliveries_event_fk',
      columns: [t.tenantId, t.eventId],
      foreignColumns: [webhookEvents.tenantId, webhookEvents.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'webhook_deliveries_replay_fk',
      columns: [t.tenantId, t.replayOf],
      foreignColumns: [t.tenantId, t.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'webhook_deliveries_requested_by_fk',
      columns: [t.tenantId, t.requestedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check(
      'webhook_deliveries_due_ck',
      sql`(${t.status} = 'pending') = (${t.nextAttemptAt} is not null)`,
    ),
    tenantIsolation(),
  ],
);

/**
 * Each attempt: status, time taken and a short sanitized excerpt of the answer. Never the
 * request headers (they carry the signature) and never a secret.
 */
export const webhookAttempts = pgTable(
  'webhook_attempts',
  {
    id: id(),
    tenantId: tenantId(),
    deliveryId: uuid('delivery_id').notNull(),
    attempt: integer('attempt').notNull(),
    startedAt: tstz('started_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
    statusCode: integer('status_code'),
    outcome: text('outcome').notNull(),
    error: text('error'),
    responseExcerpt: text('response_excerpt'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('webhook_attempts_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('webhook_attempts_attempt_key').on(t.tenantId, t.deliveryId, t.attempt),
    foreignKey({
      name: 'webhook_attempts_delivery_fk',
      columns: [t.tenantId, t.deliveryId],
      foreignColumns: [webhookDeliveries.tenantId, webhookDeliveries.id],
    }).onDelete('cascade'),
    tenantIsolation(),
  ],
);

export interface EgressHostEntry {
  pattern: string;
  note: string | null;
  createdAt: string;
}

/**
 * The tenant's egress allowlist (X05): hosts Hamnivo may call on its behalf. Empty means any
 * public host; private and reserved networks are refused in every case.
 */
export const egressPolicies = pgTable(
  'egress_policies',
  {
    id: id(),
    tenantId: tenantId(),
    hosts: jsonb('hosts').$type<EgressHostEntry[]>().notNull().default([]),
    version: integer('version').notNull().default(1),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('egress_policies_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('egress_policies_tenant_key').on(t.tenantId),
    foreignKey({
      name: 'egress_policies_updated_by_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);
