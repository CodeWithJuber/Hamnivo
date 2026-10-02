import {
  type ReplayFailedRequest,
  type ReplayFailedResult,
  WEBHOOK_EVENT_CATALOG,
  WEBHOOK_EVENT_TYPES,
  type WebhookDelivery,
  type WebhookDeliveryDetail,
  type WebhookDeliveryStatus,
  type WebhookEventType,
  WebhookPayload,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../../common/app-error.js';
import { APP_DB, CLOCK, type Clock } from '../../tokens.js';
import { payloadPreview } from './redact.js';
import { attemptView, deliveryView } from './views.js';

type DeliveryStatus = z.infer<typeof WebhookDeliveryStatus>;

function encodeCursor(id: string): string {
  return Buffer.from(id).toString('base64url');
}

function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new AppError('VALIDATION_FAILED', {
      fields: [{ path: 'cursor', message: 'Invalid cursor' }],
    });
  }
  return id;
}

/** Fixed, recognizable ids for samples (UUIDv7-shaped, never real records). */
const sampleId = (kind: Parameters<typeof toPublicId>[0], n: number) =>
  toPublicId(kind, `01999999-0000-7000-8000-${String(n).padStart(12, '0')}`);

const SAMPLE_IDS = {
  conversation: sampleId('conversation', 1),
  message: sampleId('message', 2),
  brand: sampleId('brand', 3),
  staff: sampleId('staff', 4),
  order: sampleId('order', 5),
  payment: sampleId('payment', 6),
  refund: sampleId('refund', 7),
  deletion: sampleId('memoryDeletion', 8),
  customer: sampleId('customer', 9),
  endpoint: sampleId('webhookEndpoint', 10),
  event: sampleId('event', 11),
};

/** Made-up `data` for each event type, to build and test a receiver against. */
function sampleData(type: WebhookEventType, at: string): Record<string, unknown> {
  const conversationId = SAMPLE_IDS.conversation;
  const handoff = (from: string, to: string, reason: string) => ({
    conversationId,
    reason,
    from,
    to,
    staffId: to === 'person' ? SAMPLE_IDS.staff : null,
    at,
  });
  const order = (state: string, previousState: string | null) => ({
    order: {
      id: SAMPLE_IDS.order,
      reference: 'HV-1042',
      conversationId,
      state,
      previousState,
      paymentState: 'captured',
      fulfillmentState: 'not_started',
      currency: 'EUR',
      totalMinor: '4990',
      placedAt: at,
    },
  });
  const refund = (state: string, previousState: string | null) => ({
    refund: {
      id: SAMPLE_IDS.refund,
      orderId: SAMPLE_IDS.order,
      state,
      previousState,
      currency: 'EUR',
      amountMinor: '1990',
      reason: 'damaged',
    },
  });
  switch (type) {
    case 'conversation.created':
      return { conversationId, brandId: SAMPLE_IDS.brand, channel: 'Channel::Api', createdAt: at };
    case 'conversation.updated':
      return { conversationId, status: 'waiting_for_person', responder: 'none' };
    case 'conversation.resolved':
      return { conversationId, canReopen: true };
    case 'conversation.reopened':
      return { conversationId };
    case 'message.created':
      return {
        conversationId,
        message: {
          id: SAMPLE_IDS.message,
          conversationId,
          sequence: 3,
          sender: { kind: 'customer', displayName: 'Customer' },
          visibility: 'public',
          parts: [{ type: 'text', text: 'Hello, where is my order?', format: 'plain' }],
          createdAt: at,
          clientMessageId: null,
          delivery: null,
          language: 'en',
        },
      };
    case 'handoff.requested':
      return handoff('ai', 'queue', 'customer_request');
    case 'handoff.accepted':
      return handoff('queue', 'person', 'staff_takeover');
    case 'handoff.returned':
      return handoff('person', 'ai', 'return_to_ai');
    case 'order.created':
      return order('confirmed', null);
    case 'order.updated':
      return order('fulfilled', 'confirmed');
    case 'payment.updated':
      return {
        payment: {
          id: SAMPLE_IDS.payment,
          orderId: SAMPLE_IDS.order,
          state: 'captured',
          previousState: 'authorized',
          currency: 'EUR',
          amountMinor: '4990',
          capturedMinor: '4990',
          refundedMinor: '0',
        },
      };
    case 'refund.created':
      return refund('requested', null);
    case 'refund.updated':
      return refund('succeeded', 'approved');
    case 'memory.deleted':
      return {
        deletion: {
          id: SAMPLE_IDS.deletion,
          customerId: SAMPLE_IDS.customer,
          scope: 'customer',
          reason: 'customer_request',
          recordCount: 12,
          completedAt: at,
        },
      };
    case 'usage.threshold_reached':
      return {
        limit: 'aiReplies',
        source: 'plan',
        threshold: 80,
        used: 8000,
        max: 10000,
        period: {
          key: '2026-10',
          start: '2026-10-01T00:00:00.000Z',
          end: '2026-11-01T00:00:00.000Z',
        },
      };
    case 'webhook.test':
      return {
        endpointId: SAMPLE_IDS.endpoint,
        message: 'A test event from Hamnivo. Answer with any 2xx status to confirm.',
      };
  }
}

/**
 * The delivery log, the event log and replays (D06). Logs show status, timing and a sanitized
 * excerpt of each answer; payload previews hide customer text and names. A replay repeats a
 * finished delivery with the same event body and `webhook-id`, so receivers deduplicate it.
 */
@Injectable()
export class WebhookDeliveriesService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  eventTypes() {
    return WEBHOOK_EVENT_TYPES.map((type) => ({
      type,
      category: WEBHOOK_EVENT_CATALOG[type].category,
      description: WEBHOOK_EVENT_CATALOG[type].description,
    }));
  }

  sample(type: WebhookEventType, tenantId: string) {
    const at = '2026-10-01T09:30:00.000Z';
    return WebhookPayload.parse({
      id: SAMPLE_IDS.event,
      type,
      timestamp: at,
      schemaVersion: '1.0',
      tenantId: toPublicId('tenant', tenantId),
      data: sampleData(type, at),
    });
  }

  private parseId(publicId: string): string {
    try {
      return fromPublicId('webhookDelivery', publicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Delivery not found.' });
    }
  }

  async list(
    tenantId: string,
    query: {
      endpointId?: string;
      status?: DeliveryStatus;
      eventType?: WebhookEventType;
      cursor?: string;
      limit: number;
    },
  ): Promise<{ items: WebhookDelivery[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor);
    let endpointId: string | null = null;
    if (query.endpointId) {
      try {
        endpointId = fromPublicId('webhookEndpoint', query.endpointId);
      } catch {
        return { items: [], nextCursor: null };
      }
    }
    return withTenant(this.db, { tenantId }, async (tx) => {
      const d = schema.webhookDeliveries;
      const rows = await tx
        .select({ delivery: d, url: schema.webhookEndpoints.url, type: schema.webhookEvents.type })
        .from(d)
        .innerJoin(schema.webhookEndpoints, eq(schema.webhookEndpoints.id, d.endpointId))
        .innerJoin(schema.webhookEvents, eq(schema.webhookEvents.id, d.eventId))
        .where(
          and(
            endpointId ? eq(d.endpointId, endpointId) : undefined,
            query.status ? eq(d.status, query.status) : undefined,
            query.eventType ? eq(schema.webhookEvents.type, query.eventType) : undefined,
            after ? lt(d.id, after) : undefined,
          ),
        )
        .orderBy(desc(d.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => deliveryView(row.delivery, row.url, row.type)),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.delivery.id) : null,
      };
    });
  }

  private async detailIn(tx: TenantTx, id: string): Promise<WebhookDeliveryDetail> {
    const d = schema.webhookDeliveries;
    const [row] = await tx
      .select({
        delivery: d,
        url: schema.webhookEndpoints.url,
        type: schema.webhookEvents.type,
        body: schema.webhookEvents.body,
        expiresAt: schema.webhookEvents.expiresAt,
      })
      .from(d)
      .innerJoin(schema.webhookEndpoints, eq(schema.webhookEndpoints.id, d.endpointId))
      .innerJoin(schema.webhookEvents, eq(schema.webhookEvents.id, d.eventId))
      .where(eq(d.id, id));
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Delivery not found.' });
    const attempts = await tx
      .select()
      .from(schema.webhookAttempts)
      .where(eq(schema.webhookAttempts.deliveryId, id))
      .orderBy(asc(schema.webhookAttempts.attempt));
    const replayable =
      row.body !== null && row.expiresAt > this.clock() && row.delivery.status !== 'pending';
    return {
      ...deliveryView(row.delivery, row.url, row.type),
      attemptLog: attempts.map(attemptView),
      payloadPreview: payloadPreview(row.body),
      replayable,
    };
  }

  async detail(tenantId: string, publicId: string): Promise<WebhookDeliveryDetail> {
    const id = this.parseId(publicId);
    return withTenant(this.db, { tenantId }, (tx) => this.detailIn(tx, id));
  }

  /** Queues a new delivery of the same event (same body, same webhook-id) to the same endpoint. */
  async replay(principal: StaffPrincipal, publicId: string): Promise<WebhookDelivery> {
    const id = this.parseId(publicId);
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      async (tx) => {
        const detail = await this.detailIn(tx, id);
        if (detail.status === 'pending') {
          throw new AppError('VERSION_CONFLICT', {
            detail: 'This delivery is still being attempted. Wait for it to finish.',
          });
        }
        if (!detail.replayable) {
          throw new AppError('VALIDATION_FAILED', {
            detail: 'This event is past its retention and can no longer be sent again.',
            fields: [{ path: 'id', message: 'The event is no longer kept.' }],
          });
        }
        const [original] = await tx
          .select()
          .from(schema.webhookDeliveries)
          .where(eq(schema.webhookDeliveries.id, id));
        const [endpoint] = await tx
          .select()
          .from(schema.webhookEndpoints)
          .where(eq(schema.webhookEndpoints.id, original?.endpointId ?? id));
        if (!original || !endpoint) throw new AppError('NOT_FOUND');
        if (endpoint.status !== 'active') {
          throw new AppError('VALIDATION_FAILED', {
            detail: 'Turn the endpoint on before replaying deliveries to it.',
            fields: [{ path: 'endpoint', message: 'The endpoint is turned off.' }],
          });
        }
        const now = this.clock();
        const [replay] = await tx
          .insert(schema.webhookDeliveries)
          .values({
            tenantId: principal.tenantId,
            endpointId: original.endpointId,
            eventId: original.eventId,
            status: 'pending',
            nextAttemptAt: now,
            replayOf: original.replayOf ?? original.id,
            requestedBy: principal.staffMemberId,
          })
          .returning();
        if (!replay) throw new Error('replay not stored');
        await appendAudit(tx, {
          actorType: 'staff',
          actorId: toPublicId('staff', principal.staffMemberId),
          action: 'webhook.delivery_replayed',
          targetType: 'webhook_delivery',
          targetId: publicId,
          outcome: 'success',
          data: { replay: toPublicId('webhookDelivery', replay.id), eventType: detail.eventType },
        });
        return deliveryView(replay, endpoint.url, detail.eventType);
      },
    );
  }

  /** Replays every failed or cancelled delivery of an endpoint since a time (once per event). */
  async replayFailed(
    principal: StaffPrincipal,
    endpointPublicId: string,
    input: z.output<typeof ReplayFailedRequest>,
  ): Promise<z.infer<typeof ReplayFailedResult>> {
    let endpointId: string;
    try {
      endpointId = fromPublicId('webhookEndpoint', endpointPublicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Webhook endpoint not found.' });
    }
    const since = new Date(input.since);
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      async (tx) => {
        const [endpoint] = await tx
          .select()
          .from(schema.webhookEndpoints)
          .where(eq(schema.webhookEndpoints.id, endpointId))
          .for('update');
        if (!endpoint) throw new AppError('NOT_FOUND', { detail: 'Webhook endpoint not found.' });
        if (endpoint.status !== 'active') {
          throw new AppError('VALIDATION_FAILED', {
            detail: 'Turn the endpoint on before replaying deliveries to it.',
            fields: [{ path: 'endpoint', message: 'The endpoint is turned off.' }],
          });
        }
        const d = schema.webhookDeliveries;
        const ev = schema.webhookEvents;
        // Events whose latest delivery to this endpoint did not succeed and is not running.
        const failed = await tx
          .selectDistinctOn([d.eventId], {
            id: d.id,
            eventId: d.eventId,
            status: d.status,
            replayOf: d.replayOf,
            body: ev.body,
            expiresAt: ev.expiresAt,
          })
          .from(d)
          .innerJoin(ev, eq(ev.id, d.eventId))
          .where(and(eq(d.endpointId, endpointId), gte(d.createdAt, since)))
          .orderBy(d.eventId, desc(d.id));
        const now = this.clock();
        const due = failed.filter((row) => row.status === 'failed' || row.status === 'cancelled');
        const sendable = due.filter((row) => row.body !== null && row.expiresAt > now);
        if (sendable.length > 0) {
          await tx.insert(d).values(
            sendable.map((row) => ({
              tenantId: principal.tenantId,
              endpointId,
              eventId: row.eventId,
              status: 'pending' as const,
              nextAttemptAt: now,
              replayOf: row.replayOf ?? row.id,
              requestedBy: principal.staffMemberId,
            })),
          );
        }
        const result = { replayed: sendable.length, expired: due.length - sendable.length };
        await appendAudit(tx, {
          actorType: 'staff',
          actorId: toPublicId('staff', principal.staffMemberId),
          action: 'webhook.deliveries_replayed',
          targetType: 'webhook_endpoint',
          targetId: endpointPublicId,
          outcome: 'success',
          data: { since: since.toISOString(), ...result },
        });
        return result;
      },
    );
  }

  async events(
    tenantId: string,
    query: { type?: WebhookEventType; cursor?: string; limit: number },
  ) {
    const after = decodeCursor(query.cursor);
    return withTenant(this.db, { tenantId }, async (tx) => {
      const ev = schema.webhookEvents;
      const rows = await tx
        .select({ id: ev.id, type: ev.type, occurredAt: ev.occurredAt })
        .from(ev)
        .where(
          and(
            query.type ? eq(ev.type, query.type) : undefined,
            after ? lt(ev.id, after) : undefined,
          ),
        )
        .orderBy(desc(ev.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const d = schema.webhookDeliveries;
      const counts =
        page.length === 0
          ? []
          : await tx
              .select({
                eventId: d.eventId,
                total: sql<number>`count(*)`.mapWith(Number),
                succeeded: sql<number>`count(*) filter (where ${d.status} = 'succeeded')`.mapWith(
                  Number,
                ),
                failed:
                  sql<number>`count(*) filter (where ${d.status} in ('failed', 'cancelled'))`.mapWith(
                    Number,
                  ),
                pending: sql<number>`count(*) filter (where ${d.status} = 'pending')`.mapWith(
                  Number,
                ),
              })
              .from(d)
              .where(
                inArray(
                  d.eventId,
                  page.map((row) => row.id),
                ),
              )
              .groupBy(d.eventId);
      const byEvent = new Map(counts.map((row) => [row.eventId, row]));
      const last = page.at(-1);
      return {
        items: page.map((row) => {
          const c = byEvent.get(row.id);
          return {
            id: toPublicId('event', row.id),
            type: row.type as WebhookEventType,
            occurredAt: row.occurredAt.toISOString(),
            deliveries: {
              total: c?.total ?? 0,
              succeeded: c?.succeeded ?? 0,
              failed: c?.failed ?? 0,
              pending: c?.pending ?? 0,
            },
          };
        }),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.id) : null,
      };
    });
  }
}
