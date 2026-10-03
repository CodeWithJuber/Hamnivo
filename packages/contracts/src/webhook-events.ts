import { z } from 'zod';
import { MinorUnits, Timestamp } from './common.js';
import { CustomerConversationStatus, Message } from './conversations.js';
import { typeId } from './ids.js';

/**
 * Outgoing webhook events (D06). Delivered as signed Standard Webhooks requests: the body is
 * `{ id, type, timestamp, schemaVersion, tenantId, data }`, `webhook-id` carries the event id
 * (the same on every retry and replay, so receivers deduplicate on it), `webhook-timestamp` the
 * attempt time and `webhook-signature` one `v1,<base64 HMAC-SHA256>` per active secret.
 *
 * Events describe what happened in customer conversations and orders as the customer could see
 * it. Internal notes, private staff context, AI prompts and payment details are never included.
 */

export const WEBHOOK_SCHEMA_VERSION = '1.0';

export const WEBHOOK_EVENT_CATEGORIES = [
  'conversations',
  'messages',
  'handoffs',
  'orders',
  'payments',
  'refunds',
  'memory',
  'usage',
  'testing',
] as const;
export type WebhookEventCategory = (typeof WEBHOOK_EVENT_CATEGORIES)[number];

/** Every event type, its group and what it means (English; Studio translates by type). */
export const WEBHOOK_EVENT_CATALOG = {
  'conversation.created': { category: 'conversations', description: 'A conversation started.' },
  'conversation.updated': {
    category: 'conversations',
    description: 'Who answers the customer, or the status the customer sees, changed.',
  },
  'conversation.resolved': {
    category: 'conversations',
    description: 'A conversation was resolved.',
  },
  'conversation.reopened': {
    category: 'conversations',
    description: 'A conversation was reopened.',
  },
  'message.created': {
    category: 'messages',
    description: 'A message the customer can see was sent. Internal notes are never sent.',
  },
  'handoff.requested': {
    category: 'handoffs',
    description: 'The conversation is waiting for a person.',
  },
  'handoff.accepted': { category: 'handoffs', description: 'A person took the conversation.' },
  'handoff.returned': {
    category: 'handoffs',
    description: 'The conversation went back to the AI assistant.',
  },
  'order.created': { category: 'orders', description: 'An order was placed.' },
  'order.updated': { category: 'orders', description: 'An order changed state.' },
  'payment.updated': { category: 'payments', description: 'A payment changed state.' },
  'refund.created': { category: 'refunds', description: 'A refund was requested.' },
  'refund.updated': { category: 'refunds', description: 'A refund changed state.' },
  'memory.deleted': {
    category: 'memory',
    description: 'Customer memory was deleted; the event is the receipt, without the content.',
  },
  'usage.threshold_reached': {
    category: 'usage',
    description: 'Usage reached an alert threshold of a plan limit or budget.',
  },
  'webhook.test': { category: 'testing', description: 'A test event sent from Studio or the API.' },
} as const satisfies Record<string, { category: WebhookEventCategory; description: string }>;

export type WebhookEventType = keyof typeof WEBHOOK_EVENT_CATALOG;
export const WEBHOOK_EVENT_TYPES = Object.keys(WEBHOOK_EVENT_CATALOG) as [
  WebhookEventType,
  ...WebhookEventType[],
];
export const WebhookEventType = z.enum(WEBHOOK_EVENT_TYPES).meta({ id: 'WebhookEventType' });

const conversationId = typeId('conversation');

export const ConversationCreatedData = z.object({
  conversationId,
  brandId: typeId('brand').nullable(),
  /** The channel as the conversation authority names it, e.g. `Channel::Api`. */
  channel: z.string().nullable(),
  createdAt: Timestamp,
});

export const ConversationUpdatedData = z.object({
  conversationId,
  status: CustomerConversationStatus,
  responder: z.enum(['ai', 'person', 'none']),
});

export const ConversationResolvedData = z.object({ conversationId, canReopen: z.boolean() });
export const ConversationReopenedData = z.object({ conversationId });

export const MessageCreatedData = z.object({
  conversationId,
  /** Always `visibility: public`. */
  message: Message,
});

export const HandoffData = z.object({
  conversationId,
  /** Why ownership changed, e.g. `customer_request`, `ai_unavailable`, `staff_takeover`. */
  reason: z.string().nullable(),
  from: z.enum(['ai', 'queue', 'person']),
  to: z.enum(['ai', 'queue', 'person']),
  /** The staff member who holds the conversation now, when a Hamnivo member does. */
  staffId: typeId('staff').nullable(),
  at: Timestamp,
});

export const OrderData = z.object({
  order: z.object({
    id: typeId('order'),
    reference: z.string(),
    conversationId,
    state: z.string(),
    previousState: z.string().nullable(),
    paymentState: z.string(),
    fulfillmentState: z.string(),
    currency: z.string(),
    totalMinor: MinorUnits,
    placedAt: Timestamp,
  }),
});

export const PaymentData = z.object({
  payment: z.object({
    id: typeId('payment'),
    orderId: typeId('order').nullable(),
    state: z.string(),
    previousState: z.string().nullable(),
    currency: z.string(),
    amountMinor: MinorUnits,
    capturedMinor: MinorUnits,
    refundedMinor: MinorUnits,
  }),
});

export const RefundData = z.object({
  refund: z.object({
    id: typeId('refund'),
    orderId: typeId('order'),
    state: z.string(),
    previousState: z.string().nullable(),
    currency: z.string(),
    amountMinor: MinorUnits,
    reason: z.string(),
  }),
});

export const MemoryDeletedData = z.object({
  deletion: z.object({
    id: typeId('memoryDeletion'),
    customerId: typeId('customer'),
    scope: z.enum(['record', 'customer']),
    reason: z.string(),
    recordCount: z.int().nonnegative(),
    completedAt: Timestamp,
  }),
});

export const UsageThresholdData = z.object({
  limit: z.string(),
  /** `plan` for a plan limit, `budget` for the workspace's own budget. */
  source: z.enum(['plan', 'budget']),
  threshold: z.int().min(1).max(100),
  used: z.int().nonnegative(),
  max: z.int().nonnegative(),
  period: z.object({ key: z.string(), start: Timestamp, end: Timestamp }),
});

export const WebhookTestData = z.object({
  endpointId: typeId('webhookEndpoint'),
  message: z.string(),
});

const envelope = {
  id: typeId('event'),
  timestamp: Timestamp,
  schemaVersion: z.string().regex(/^1\.\d+$/),
  tenantId: typeId('tenant'),
};

const event = <T extends WebhookEventType, D extends z.ZodType>(type: T, data: D) =>
  z.object({ ...envelope, type: z.literal(type), data });

/** The body of a webhook request. */
export const WebhookPayload = z
  .discriminatedUnion('type', [
    event('conversation.created', ConversationCreatedData),
    event('conversation.updated', ConversationUpdatedData),
    event('conversation.resolved', ConversationResolvedData),
    event('conversation.reopened', ConversationReopenedData),
    event('message.created', MessageCreatedData),
    event('handoff.requested', HandoffData),
    event('handoff.accepted', HandoffData),
    event('handoff.returned', HandoffData),
    event('order.created', OrderData),
    event('order.updated', OrderData),
    event('payment.updated', PaymentData),
    event('refund.created', RefundData),
    event('refund.updated', RefundData),
    event('memory.deleted', MemoryDeletedData),
    event('usage.threshold_reached', UsageThresholdData),
    event('webhook.test', WebhookTestData),
  ])
  .meta({ id: 'WebhookPayload' });
export type WebhookPayload = z.infer<typeof WebhookPayload>;
