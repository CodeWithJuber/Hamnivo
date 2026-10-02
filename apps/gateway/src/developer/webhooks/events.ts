import { WEBHOOK_SCHEMA_VERSION, type WebhookEventType, WebhookPayload } from '@hamnivo/contracts';
import { schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { and, eq } from 'drizzle-orm';

/**
 * Turns a `webhooks.source` outbox event (written by database triggers in the same transaction as
 * the change) into the public event. The trigger only says what changed; the event is read here,
 * so it carries what the customer could see and nothing else:
 *
 * - conversation and message events come from the customer lane of the journal only, so internal
 *   notes, staff context and AI work never reach a webhook;
 * - orders, payments and refunds carry states and amounts, never payment details or notes;
 * - a memory deletion carries the receipt, never what was deleted.
 */

export interface BuiltEvent {
  type: WebhookEventType;
  occurredAt: Date;
  data: Record<string, unknown>;
}

type Source =
  | { kind: 'conversation_created'; conversationId: string }
  | {
      kind: 'ownership';
      conversationId: string;
      from: string | null;
      to: string;
      reason: string | null;
      staffId: string | null;
      at: string;
    }
  | { kind: 'journal'; conversationId: string; lane: string; seq: number }
  | {
      kind: 'orders' | 'payments' | 'refunds';
      id: string;
      op: 'insert' | 'update';
      state: string;
      previousState: string | null;
      at: string;
    }
  | { kind: 'memory_deletion'; id: string }
  | {
      kind: 'usage_alert';
      limit: string;
      source: 'plan' | 'budget';
      threshold: number;
      used: number;
      max: number;
      period: { key: string; start: string; end: string };
      at: string;
    };

const iso = (value: Date | string) => new Date(value).toISOString();

/** Who holds a conversation, as webhook events name it. */
export function holder(mode: string | null): 'ai' | 'queue' | 'person' {
  switch (mode) {
    case 'AI_ACTIVE':
      return 'ai';
    case 'HUMAN_ACTIVE':
      return 'person';
    default:
      return 'queue';
  }
}

/** The handoff event for a change of owner, or null when nothing changed hands. */
export function handoffType(from: string | null, to: string): WebhookEventType | null {
  const before = holder(from);
  const after = holder(to);
  if (before === after) return null;
  if (after === 'queue') return 'handoff.requested';
  if (after === 'person') return 'handoff.accepted';
  return 'handoff.returned';
}

async function conversationCreated(
  tx: TenantTx,
  source: Extract<Source, { kind: 'conversation_created' }>,
): Promise<BuiltEvent | null> {
  const c = schema.conversationControls;
  const [row] = await tx
    .select({
      id: c.id,
      brandId: c.brandId,
      createdAt: c.createdAt,
      channel: schema.authorityInboxes.channelType,
    })
    .from(c)
    .leftJoin(schema.authorityInboxes, eq(schema.authorityInboxes.id, c.inboxId))
    .where(eq(c.id, source.conversationId));
  if (!row) return null;
  return {
    type: 'conversation.created',
    occurredAt: row.createdAt,
    data: {
      conversationId: toPublicId('conversation', row.id),
      brandId: row.brandId ? toPublicId('brand', row.brandId) : null,
      channel: row.channel ?? null,
      createdAt: iso(row.createdAt),
    },
  };
}

function ownership(source: Extract<Source, { kind: 'ownership' }>): BuiltEvent | null {
  const type = handoffType(source.from, source.to);
  if (!type) return null;
  const at = new Date(source.at);
  return {
    type,
    occurredAt: at,
    data: {
      conversationId: toPublicId('conversation', source.conversationId),
      reason: source.reason,
      from: holder(source.from),
      to: holder(source.to),
      staffId:
        source.staffId && holder(source.to) === 'person'
          ? toPublicId('staff', source.staffId)
          : null,
      at: at.toISOString(),
    },
  };
}

async function journal(
  tx: TenantTx,
  source: Extract<Source, { kind: 'journal' }>,
): Promise<BuiltEvent | null> {
  // Only the customer lane: what the customer saw is all a webhook may carry.
  if (source.lane !== 'customer') return null;
  const j = schema.conversationJournal;
  const [row] = await tx
    .select({ type: j.eventType, event: j.event })
    .from(j)
    .where(
      and(
        eq(j.conversationId, source.conversationId),
        eq(j.lane, 'customer'),
        eq(j.seq, source.seq),
      ),
    );
  if (!row) return null;
  const event = row.event as { occurredAt?: string; data?: Record<string, unknown> };
  const data = event.data ?? {};
  const occurredAt = event.occurredAt ? new Date(event.occurredAt) : new Date();
  const conversationId = toPublicId('conversation', source.conversationId);
  switch (row.type) {
    case 'message.created': {
      const message = data.message as { visibility?: string } | undefined;
      if (message?.visibility !== 'public') return null;
      return { type: 'message.created', occurredAt, data: { conversationId, message } };
    }
    case 'conversation.updated':
      return {
        type: 'conversation.updated',
        occurredAt,
        data: { conversationId, status: data.status, responder: data.responder },
      };
    case 'conversation.resolved':
      return {
        type: 'conversation.resolved',
        occurredAt,
        data: { conversationId, canReopen: data.canReopen ?? true },
      };
    case 'conversation.reopened':
      return { type: 'conversation.reopened', occurredAt, data: { conversationId } };
    default:
      return null;
  }
}

async function commerce(
  tx: TenantTx,
  source: Extract<Source, { kind: 'orders' | 'payments' | 'refunds' }>,
): Promise<BuiltEvent | null> {
  const occurredAt = new Date(source.at);
  if (source.kind === 'orders') {
    const o = schema.orders;
    const [order] = await tx.select().from(o).where(eq(o.id, source.id));
    if (!order) return null;
    return {
      type: source.op === 'insert' ? 'order.created' : 'order.updated',
      occurredAt,
      data: {
        order: {
          id: toPublicId('order', order.id),
          reference: order.reference,
          conversationId: toPublicId('conversation', order.conversationId),
          state: source.state,
          previousState: source.previousState,
          paymentState: order.paymentState,
          fulfillmentState: order.fulfillmentState,
          currency: order.currency,
          totalMinor: order.totalMinor.toString(),
          placedAt: iso(order.placedAt),
        },
      },
    };
  }
  if (source.kind === 'payments') {
    const p = schema.payments;
    const [payment] = await tx
      .select({ payment: p, orderId: schema.orders.id })
      .from(p)
      .leftJoin(schema.orders, eq(schema.orders.purchaseIntentId, p.purchaseIntentId))
      .where(eq(p.id, source.id))
      .limit(1);
    if (!payment) return null;
    return {
      type: 'payment.updated',
      occurredAt,
      data: {
        payment: {
          id: toPublicId('payment', payment.payment.id),
          orderId: payment.orderId ? toPublicId('order', payment.orderId) : null,
          state: source.state,
          previousState: source.previousState,
          currency: payment.payment.currency,
          amountMinor: payment.payment.amountMinor.toString(),
          capturedMinor: payment.payment.capturedMinor.toString(),
          refundedMinor: payment.payment.refundedMinor.toString(),
        },
      },
    };
  }
  const r = schema.refunds;
  const [refund] = await tx.select().from(r).where(eq(r.id, source.id));
  if (!refund) return null;
  return {
    type: source.op === 'insert' ? 'refund.created' : 'refund.updated',
    occurredAt,
    data: {
      refund: {
        id: toPublicId('refund', refund.id),
        orderId: toPublicId('order', refund.orderId),
        state: source.state,
        previousState: source.previousState,
        currency: refund.currency,
        amountMinor: refund.amountMinor.toString(),
        // The reason code only; the staff note stays inside Hamnivo.
        reason: refund.reason,
      },
    },
  };
}

async function memoryDeleted(
  tx: TenantTx,
  source: Extract<Source, { kind: 'memory_deletion' }>,
): Promise<BuiltEvent | null> {
  const m = schema.memoryDeletions;
  const [row] = await tx.select().from(m).where(eq(m.id, source.id));
  if (row?.status !== 'completed' || !row.completedAt) return null;
  return {
    type: 'memory.deleted',
    occurredAt: row.completedAt,
    data: {
      deletion: {
        id: toPublicId('memoryDeletion', row.id),
        customerId: toPublicId('customer', row.subjectId),
        scope: row.scope,
        reason: row.reason,
        recordCount: row.recordCount,
        completedAt: iso(row.completedAt),
      },
    },
  };
}

/** Reads what a source event points at and builds the event, or null when there is none. */
export async function buildEvent(tx: TenantTx, payload: unknown): Promise<BuiltEvent | null> {
  const source = payload as Source;
  switch (source?.kind) {
    case 'conversation_created':
      return conversationCreated(tx, source);
    case 'ownership':
      return ownership(source);
    case 'journal':
      return journal(tx, source);
    case 'orders':
    case 'payments':
    case 'refunds':
      return commerce(tx, source);
    case 'memory_deletion':
      return memoryDeleted(tx, source);
    case 'usage_alert':
      return {
        type: 'usage.threshold_reached',
        occurredAt: new Date(source.at),
        data: {
          limit: source.limit,
          source: source.source,
          threshold: source.threshold,
          used: source.used,
          max: source.max,
          period: source.period,
        },
      };
    default:
      return null;
  }
}

/**
 * The exact body that is signed and sent, checked against the published schema so a receiver
 * never gets something the documentation does not describe.
 */
export function serializeEvent(input: {
  eventId: string;
  tenantId: string;
  type: WebhookEventType;
  occurredAt: Date;
  data: Record<string, unknown>;
}): string {
  const payload = WebhookPayload.parse({
    id: toPublicId('event', input.eventId),
    type: input.type,
    timestamp: input.occurredAt.toISOString(),
    schemaVersion: WEBHOOK_SCHEMA_VERSION,
    tenantId: toPublicId('tenant', input.tenantId),
    data: input.data,
  });
  return JSON.stringify(payload);
}
