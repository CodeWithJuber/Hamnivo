/**
 * Shopify and WooCommerce orders, read only. This catalog is the whole of what Hamnivo asks a
 * store: no write, no customer record, no address and no payment detail ever leaves the adapter.
 */
export const STORE_KINDS = ['shopify', 'woocommerce'] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

export const STORE_CAPABILITIES = ['orders.read', 'order.status'] as const;
export type StoreCapability = (typeof STORE_CAPABILITIES)[number];

export const STORE_SPEC: Record<
  StoreCapability,
  {
    title: string;
    description: string;
    risk: 'read';
    approver: 'customer';
    inputSchema: Record<string, unknown>;
  }
> = {
  'orders.read': {
    title: 'Read the customer’s orders',
    description:
      'List the signed-in customer’s recent orders, found by the email the website verified: number, date, payment, delivery, tracking, item count and total.',
    risk: 'read',
    approver: 'customer',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  'order.status': {
    title: 'Look up one order',
    description:
      'Find one order by its number and the email it was placed with, as a track-my-order page does: its status, delivery, tracking, item count and total. A wrong email finds nothing.',
    risk: 'read',
    approver: 'customer',
    inputSchema: {
      type: 'object',
      properties: {
        orderNumber: {
          type: 'string',
          minLength: 1,
          maxLength: 33,
          description: 'The order number the customer gave, such as #1001 or 1001.',
        },
        email: {
          type: 'string',
          minLength: 3,
          maxLength: 254,
          description: 'The email address the order was placed with, as the customer gave it.',
        },
      },
      required: ['orderNumber', 'email'],
      additionalProperties: false,
    },
  },
};

export function storeKind(value: string): value is StoreKind {
  return (STORE_KINDS as readonly string[]).includes(value);
}

export function storeCapability(value: string): value is StoreCapability {
  return Object.hasOwn(STORE_SPEC, value);
}

/** One order as the assistant may tell it, the same for both stores. */
export interface StoreOrder {
  /** As the store shows it to customers: "#1001" (Shopify) or "1001" (WooCommerce). */
  number: string;
  placedAt: string | null;
  /** The store's own status, in lower case (paid, pending, processing, completed…). */
  storeStatus: string | null;
  payment: 'paid' | 'pending' | 'partially_paid' | 'refunded' | 'failed' | 'on_hold' | null;
  fulfilment: 'fulfilled' | 'partially_fulfilled' | 'unfulfilled' | null;
  cancelled: boolean;
  itemCount: number | null;
  total: { amount: string; currency: string } | null;
  tracking: { company: string | null; number: string | null; url: string | null }[];
}

/** The most orders one read returns. */
export const STORE_ORDER_LIMIT = 10;

/** An order number as customers type it: digits and letters, an optional leading #. */
export function orderNumberOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^#/, '');
  return /^[A-Za-z0-9-]{1,32}$/.test(trimmed) ? trimmed : null;
}

/** A plausible email address, compared without case or spaces. */
export function emailOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length <= 254 && /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/.test(trimmed)
    ? trimmed
    : null;
}

export function sameEmail(a: unknown, b: unknown): boolean {
  const left = emailOf(a);
  return left !== null && left === emailOf(b);
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Plain text, no markup, bounded. */
function plain(value: unknown, max = 120): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value)
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, max);
  return text || null;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function money(amount: unknown, currency: unknown): StoreOrder['total'] {
  const value = plain(amount, 32);
  const code = plain(currency, 3);
  if (!value || !/^-?\d+(\.\d+)?$/.test(value) || !code || !/^[A-Z]{3}$/i.test(code)) return null;
  return { amount: value, currency: code.toUpperCase() };
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function tracking(company: unknown, number: unknown, url: unknown) {
  const entry = { company: plain(company), number: plain(number, 64), url: httpUrl(url) };
  return entry.company || entry.number || entry.url ? entry : null;
}

const SHOPIFY_PAYMENT: Record<string, StoreOrder['payment']> = {
  paid: 'paid',
  pending: 'pending',
  authorized: 'pending',
  partially_paid: 'partially_paid',
  partially_refunded: 'paid',
  refunded: 'refunded',
  voided: 'failed',
  expired: 'failed',
};
const SHOPIFY_FULFILMENT: Record<string, StoreOrder['fulfilment']> = {
  fulfilled: 'fulfilled',
  partially_fulfilled: 'partially_fulfilled',
  unfulfilled: 'unfulfilled',
  in_progress: 'unfulfilled',
  on_hold: 'unfulfilled',
  scheduled: 'unfulfilled',
  open: 'unfulfilled',
  pending_fulfillment: 'unfulfilled',
};

/** A Shopify Admin GraphQL order node, with the email it was placed with. */
export function shopifyOrder(node: unknown): (StoreOrder & { email: string | null }) | null {
  const order = record(node);
  const number = plain(order?.name, 33);
  if (!order || !number) return null;
  const financial = plain(order.displayFinancialStatus, 40)?.toLowerCase() ?? null;
  const delivery = plain(order.displayFulfillmentStatus, 40)?.toLowerCase() ?? null;
  const price = record(record(order.currentTotalPriceSet)?.shopMoney);
  const count = order.currentSubtotalLineItemsQuantity;
  return {
    number,
    email: emailOf(order.email),
    placedAt: isoDate(order.createdAt),
    storeStatus: financial,
    payment: financial ? (SHOPIFY_PAYMENT[financial] ?? null) : null,
    fulfilment: delivery ? (SHOPIFY_FULFILMENT[delivery] ?? null) : null,
    cancelled: typeof order.cancelledAt === 'string' && order.cancelledAt.length > 0,
    itemCount:
      typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null,
    total: money(price?.amount, price?.currencyCode),
    tracking: list(order.fulfillments)
      .flatMap((f) => list(record(f)?.trackingInfo))
      .map((t) => tracking(record(t)?.company, record(t)?.number, record(t)?.url))
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .slice(0, 5),
  };
}

/** The orders in a Shopify `orders` GraphQL answer; null when it is not one. */
export function shopifyOrders(data: unknown): (StoreOrder & { email: string | null })[] | null {
  const orders = record(record(data)?.orders);
  if (!orders || !Array.isArray(orders.nodes)) return null;
  return orders.nodes
    .map(shopifyOrder)
    .filter((o): o is NonNullable<typeof o> => o !== null)
    .slice(0, STORE_ORDER_LIMIT);
}

const WOO_PAYMENT: Record<string, StoreOrder['payment']> = {
  pending: 'pending',
  processing: 'paid',
  completed: 'paid',
  'on-hold': 'on_hold',
  refunded: 'refunded',
  failed: 'failed',
};
const WOO_FULFILMENT: Record<string, StoreOrder['fulfilment']> = {
  processing: 'unfulfilled',
  completed: 'fulfilled',
};

/** A WooCommerce REST order, with the billing email it was placed with. */
export function wooOrder(row: unknown): (StoreOrder & { email: string | null }) | null {
  const order = record(row);
  const number = plain(order?.number ?? order?.id, 33);
  if (!order || !number) return null;
  const status = plain(order.status, 40)?.toLowerCase() ?? null;
  const items = list(order.line_items)
    .map((item) => record(item)?.quantity)
    .filter((q): q is number => typeof q === 'number' && Number.isSafeInteger(q) && q >= 0);
  // Tracking, when the store uses WooCommerce Shipment Tracking: only that one entry is read.
  const shipments = list(order.meta_data)
    .map(record)
    .filter((meta) => meta?.key === '_wc_shipment_tracking_items')
    .flatMap((meta) => list(meta?.value));
  return {
    number,
    email: emailOf(record(order.billing)?.email),
    placedAt: isoDate(order.date_created_gmt ? `${order.date_created_gmt}Z` : order.date_created),
    storeStatus: status,
    payment: status ? (WOO_PAYMENT[status] ?? null) : null,
    fulfilment: status ? (WOO_FULFILMENT[status] ?? null) : null,
    cancelled: status === 'cancelled',
    itemCount: items.length > 0 ? items.reduce((a, b) => a + b, 0) : null,
    total: money(order.total, order.currency),
    tracking: shipments
      .map((s) =>
        tracking(
          record(s)?.tracking_provider ?? record(s)?.custom_tracking_provider,
          record(s)?.tracking_number,
          record(s)?.custom_tracking_link,
        ),
      )
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .slice(0, 5),
  };
}

/** What the assistant receives: the order without the email it was matched by. */
export function publicOrder(order: StoreOrder & { email?: string | null }): StoreOrder {
  const { email: _email, ...rest } = order;
  return rest;
}
