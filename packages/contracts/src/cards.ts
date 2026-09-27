import { z } from 'zod';
import { CurrencyCode, MinorUnits, Timestamp } from './common.js';

/**
 * Structured cards rendered from a known component registry (blueprint G24, W16). Values come
 * from validated server data — never from free model text — and every card carries a plain-text
 * fallback for channels or clients that cannot render it.
 */

export const QuoteLine = z.object({
  lineId: z.string(),
  name: z.string().max(200),
  variant: z.string().max(120).optional(),
  quantity: z.int().positive(),
  unitPriceMinor: MinorUnits,
  totalMinor: MinorUnits,
});

export const QuoteCard = z
  .object({
    kind: z.literal('quote'),
    version: z.literal(1),
    quoteId: z.string(),
    /** Hash binding approval to the exact quote content. */
    quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
    merchant: z.object({ id: z.string(), name: z.string() }),
    lines: z.array(QuoteLine).min(1),
    currency: CurrencyCode,
    subtotalMinor: MinorUnits,
    discountMinor: MinorUnits,
    taxMinor: MinorUnits.nullable(),
    shippingMinor: MinorUnits.nullable(),
    totalMinor: MinorUnits,
    recurring: z
      .object({ interval: z.enum(['week', 'month', 'year']), intervalCount: z.int().positive() })
      .nullable(),
    expiresAt: Timestamp,
  })
  .meta({ id: 'QuoteCard' });

export const ApprovalCard = z
  .object({
    kind: z.literal('approval'),
    version: z.literal(1),
    approvalId: z.string(),
    title: z.string().max(200),
    actionSummary: z.string().max(500),
    resource: z.object({ type: z.string(), id: z.string(), label: z.string() }),
    changes: z.array(z.object({ field: z.string(), from: z.string().nullable(), to: z.string() })),
    approver: z.enum(['customer', 'staff']),
    status: z.enum(['pending', 'approved', 'denied', 'expired', 'superseded']),
    expiresAt: Timestamp,
  })
  .meta({ id: 'ApprovalCard' });

export const OrderStatusCard = z
  .object({
    kind: z.literal('order_status'),
    version: z.literal(1),
    orderId: z.string(),
    reference: z.string(),
    paymentState: z.enum([
      'not_started',
      'pending',
      'authorized',
      'paid',
      'failed',
      'refunded',
      'partially_refunded',
      'unknown',
    ]),
    fulfillmentState: z.enum([
      'not_started',
      'processing',
      'partially_fulfilled',
      'fulfilled',
      'delayed',
      'cancelled',
      'unknown',
    ]),
    summary: z.string().max(300),
    /** When the authoritative system was last read — freshness is shown, not implied. */
    observedAt: Timestamp,
  })
  .meta({ id: 'OrderStatusCard' });

export const ChoicesCard = z
  .object({
    kind: z.literal('choices'),
    version: z.literal(1),
    prompt: z.string().max(300),
    options: z
      .array(z.object({ value: z.string().max(100), label: z.string().max(80) }))
      .min(1)
      .max(8),
    allowFreeText: z.boolean(),
  })
  .meta({ id: 'ChoicesCard' });

export const FormField = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  label: z.string().max(120),
  kind: z.enum(['text', 'email', 'tel', 'number', 'textarea', 'select']),
  required: z.boolean(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  maxLength: z.int().positive().max(5000).optional(),
});

export const FormCard = z
  .object({
    kind: z.literal('form'),
    version: z.literal(1),
    formId: z.string(),
    title: z.string().max(200),
    fields: z.array(FormField).min(1).max(12),
    submitLabel: z.string().max(40),
  })
  .meta({ id: 'FormCard' });

export const ArticleCard = z
  .object({
    kind: z.literal('article'),
    version: z.literal(1),
    sourceId: z.string(),
    title: z.string().max(200),
    summary: z.string().max(600),
    url: z.url().nullable(),
  })
  .meta({ id: 'ArticleCard' });

export const ReceiptCard = z
  .object({
    kind: z.literal('receipt'),
    version: z.literal(1),
    receiptId: z.string(),
    actionId: z.string(),
    outcome: z.enum(['completed', 'failed', 'unknown', 'cancelled']),
    summary: z.string().max(300),
    /** External system reference (order number, ticket ID, refund ID). */
    reference: z.string().max(120).nullable(),
    occurredAt: Timestamp,
  })
  .meta({ id: 'ReceiptCard' });

export const CatalogItem = z
  .object({
    productId: z.string().max(200),
    /** Provider price or variant reference; null when the product has one price. */
    variantId: z.string().max(200).nullable(),
    name: z.string().max(200),
    description: z.string().max(500).nullable(),
    unitPriceMinor: MinorUnits,
    currency: CurrencyCode,
    availability: z.enum(['in_stock', 'out_of_stock', 'unknown']),
    /** Units the merchant reported in stock; null when it does not report stock. */
    stockQuantity: z.int().nonnegative().nullable(),
    imageUrl: z.url().nullable(),
  })
  .meta({ id: 'CatalogItem' });

/**
 * Products as the merchant listed them at `observedAt` (C02). Prices here are what the catalog
 * said then; the binding price is always the quote, read from the merchant again.
 */
export const CatalogCard = z
  .object({
    kind: z.literal('catalog'),
    version: z.literal(1),
    snapshotId: z.string(),
    merchant: z.object({ id: z.string(), name: z.string() }),
    items: z.array(CatalogItem).max(20),
    observedAt: Timestamp,
    /** Where the data came from (e.g. `stripe:prices.list`). */
    source: z.string().max(80),
  })
  .meta({ id: 'CatalogCard' });

export const Card = z.discriminatedUnion('kind', [
  QuoteCard,
  ApprovalCard,
  OrderStatusCard,
  ChoicesCard,
  FormCard,
  ArticleCard,
  ReceiptCard,
  CatalogCard,
]);
export type Card = z.infer<typeof Card>;
export const CARD_KINDS = [
  'quote',
  'approval',
  'order_status',
  'choices',
  'form',
  'article',
  'receipt',
  'catalog',
] as const;
