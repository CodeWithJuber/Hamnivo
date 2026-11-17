import { EgressError, type EgressPolicy, safeRequest } from '../net/index.js';

/**
 * Read-only calls to Shopify's Admin GraphQL API and WooCommerce's REST API, through the egress
 * guard (no redirects, no private hosts unless the server administrator trusts the origin). Only
 * the fixed queries and paths below are ever sent: there is no way to ask a store for anything else.
 */

/** The Shopify Admin API version Hamnivo is written against. */
export const SHOPIFY_API_VERSION = '2025-07';

export type StoreProblem =
  | 'network'
  | 'timeout'
  | 'egress'
  | 'auth'
  | 'not_found'
  | 'rate_limited'
  | 'http'
  | 'response';

/** A failed store call. The message never carries the store's answer or a credential. */
export class StoreApiError extends Error {
  override readonly name = 'StoreApiError';
  constructor(readonly kind: StoreProblem) {
    super('The store could not be read.');
  }
}

export interface StoreCall {
  /** The shop's or site's root address, `https://…/`. */
  baseUrl: string;
  policy: EgressPolicy;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function root(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new StoreApiError('egress');
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new StoreApiError('egress');
  }
  return url;
}

async function send(
  call: StoreCall,
  url: URL,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  maxResponseBytes: number,
): Promise<{ status: number; json: unknown }> {
  let response: Awaited<ReturnType<typeof safeRequest>>;
  try {
    response = await safeRequest(
      {
        url: url.toString(),
        method: init.method,
        headers: { Accept: 'application/json', ...init.headers },
        ...(init.body !== undefined ? { body: init.body } : {}),
        timeoutMs: call.timeoutMs ?? 10_000,
        maxResponseBytes,
        ...(call.signal ? { signal: call.signal } : {}),
      },
      call.policy,
    );
  } catch (error) {
    if (error instanceof EgressError) {
      throw new StoreApiError(
        error.problem === 'timeout'
          ? 'timeout'
          : error.problem === 'network'
            ? 'network'
            : 'egress',
      );
    }
    throw new StoreApiError('network');
  }
  if (response.truncated) throw new StoreApiError('response');
  if (response.status === 401 || response.status === 403) throw new StoreApiError('auth');
  if (response.status === 429) throw new StoreApiError('rate_limited');
  let json: unknown = null;
  try {
    json = JSON.parse(response.body.toString('utf8'));
  } catch {
    if (response.status === 200) throw new StoreApiError('response');
  }
  return { status: response.status, json };
}

const SHOPIFY_ORDER = `name email createdAt displayFinancialStatus displayFulfillmentStatus cancelledAt
  currentSubtotalLineItemsQuantity currentTotalPriceSet { shopMoney { amount currencyCode } }
  fulfillments(first: 5) { trackingInfo(first: 3) { company number url } }`;

/** The only GraphQL documents Hamnivo sends to Shopify. */
export const SHOPIFY_QUERIES = {
  shop: 'query HamnivoShop { shop { name } }',
  orders: `query HamnivoOrders($query: String!, $first: Int!) {
  orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) { nodes { ${SHOPIFY_ORDER} } }
}`,
} as const;
export type ShopifyQuery = keyof typeof SHOPIFY_QUERIES;

/**
 * Runs one of the fixed Shopify queries with an Admin API access token and returns its `data`.
 * `search` is Shopify's search syntax (`email:"…"`, `name:"#1001"`); callers build it from
 * values already checked to hold no quotes or spaces.
 */
export async function callShopify(
  input: StoreCall & { token: string; query: ShopifyQuery; search?: string; first?: number },
): Promise<Record<string, unknown>> {
  if (!Object.hasOwn(SHOPIFY_QUERIES, input.query)) throw new StoreApiError('egress');
  const url = new URL(`/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, root(input.baseUrl));
  const variables =
    input.query === 'orders'
      ? { query: input.search ?? '', first: Math.min(Math.max(input.first ?? 10, 1), 10) }
      : {};
  const { status, json } = await send(
    input,
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': input.token },
      body: JSON.stringify({ query: SHOPIFY_QUERIES[input.query], variables }),
    },
    256 * 1024,
  );
  if (status === 404) throw new StoreApiError('not_found');
  if (status !== 200) throw new StoreApiError('http');
  const body = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  const errors = Array.isArray(body?.errors) ? (body.errors as unknown[]) : [];
  if (errors.length > 0) {
    const codes = errors.map(
      (e) => (e as { extensions?: { code?: unknown } } | null)?.extensions?.code,
    );
    if (codes.includes('THROTTLED')) throw new StoreApiError('rate_limited');
    if (codes.includes('ACCESS_DENIED')) throw new StoreApiError('auth');
    throw new StoreApiError('response');
  }
  const data = body?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new StoreApiError('response');
  return data as Record<string, unknown>;
}

/** The fields Hamnivo asks WooCommerce for; the adapter keeps fewer still. */
const WOO_FIELDS =
  'id,number,status,date_created,date_created_gmt,currency,total,billing,line_items,meta_data';

export type WooRead =
  /** Recent orders matching a search (an email), newest first. */
  | { kind: 'orders'; search: string; perPage?: number }
  /** One order by its id; null when the store has no such order. */
  | { kind: 'order'; id: number }
  /** One cheap call to see that the key works. */
  | { kind: 'check' };

/** Reads WooCommerce orders with a REST key and secret (read access is enough). */
export async function callWooCommerce(
  input: StoreCall & { key: string; secret: string; read: WooRead },
): Promise<unknown> {
  const base = root(input.baseUrl);
  const read = input.read;
  let url: URL;
  if (read.kind === 'order') {
    if (!Number.isSafeInteger(read.id) || read.id < 1) throw new StoreApiError('egress');
    url = new URL(`/wp-json/wc/v3/orders/${read.id}`, base);
  } else {
    url = new URL('/wp-json/wc/v3/orders', base);
    url.searchParams.set(
      'per_page',
      String(read.kind === 'check' ? 1 : Math.min(read.perPage ?? 10, 10)),
    );
    if (read.kind === 'orders') {
      url.searchParams.set('search', read.search);
      url.searchParams.set('orderby', 'date');
      url.searchParams.set('order', 'desc');
    }
  }
  url.searchParams.set('_fields', read.kind === 'check' ? 'id' : WOO_FIELDS);
  const auth = Buffer.from(`${input.key}:${input.secret}`, 'utf8').toString('base64');
  const { status, json } = await send(
    input,
    url,
    { method: 'GET', headers: { Authorization: `Basic ${auth}` } },
    512 * 1024,
  );
  if (status === 404) {
    // No such order is an answer; no WooCommerce on the site is a broken connection.
    const code = (json as { code?: unknown } | null)?.code;
    if (read.kind === 'order' && code !== 'rest_no_route') return null;
    throw new StoreApiError('not_found');
  }
  if (status !== 200) throw new StoreApiError('http');
  if (read.kind === 'order') {
    if (!json || typeof json !== 'object' || Array.isArray(json))
      throw new StoreApiError('response');
    return json;
  }
  if (!Array.isArray(json)) throw new StoreApiError('response');
  return json;
}
