import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { STRIPE_API_VERSION } from './stripe-shapes.js';

/**
 * A stateful stand-in for the parts of the Stripe API Hamnivo uses, for tests and local end-to-end
 * runs. Objects follow the shapes in Stripe's API reference; the real Stripe SDK talks to it over
 * HTTP (form-encoded requests, idempotency keys, error bodies), and events are delivered signed
 * with Stripe's `t=…,v1=…` scheme so the SDK's own verification runs. It also serves a minimal
 * hosted payment page. It is not Stripe: behaviour beyond these endpoints is not modelled.
 */

type Json = Record<string, unknown>;

export interface FakeStripeProduct {
  id: string;
  name: string;
  description: string | null;
  priceId: string;
  unitAmount: number;
  currency: string;
  active: boolean;
}

export type FakeStripeFault = 'timeout_before' | 'timeout_after' | 'error_500';

export interface FakeStripe {
  url: string;
  apiKey: string;
  products: Map<string, FakeStripeProduct>;
  sessions: Map<string, Json>;
  paymentIntents: Map<string, Json>;
  refunds: Map<string, Json>;
  /** Every API request, oldest first. */
  requests: { method: string; path: string; idempotencyKey: string | null }[];
  webhookEndpoints: { url: string; secret: string }[];
  refundMode: 'pending' | 'succeeded';
  /** Makes the next request whose path starts with `pathPrefix` misbehave. */
  inject(method: string, pathPrefix: string, fault: FakeStripeFault, holdMs?: number): void;
  setPrice(productId: string, unitAmount: number): void;
  /** The customer pays on the hosted page; events are delivered to the webhook endpoints. */
  pay(sessionId: string): Promise<Json[]>;
  expire(sessionId: string): Promise<Json>;
  settleRefund(refundId: string, outcome: 'succeeded' | 'failed'): Promise<Json>;
  /** Events created so far (delivered or not). */
  events: Json[];
  close(): Promise<void>;
}

/** Stripe's form encoding: `a[b][0][c]=x` becomes `{ a: { b: [{ c: 'x' }] } }`. */
export function parseStripeForm(text: string): Json {
  const root: Json = {};
  for (const pair of text.split('&')) {
    if (!pair) continue;
    const at = pair.indexOf('=');
    const rawKey = decodeURIComponent((at < 0 ? pair : pair.slice(0, at)).replace(/\+/g, ' '));
    const value = at < 0 ? '' : decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '));
    const path = rawKey.replace(/\]/g, '').split('[');
    let node: Record<string, unknown> | unknown[] = root;
    path.forEach((segment, index) => {
      const last = index === path.length - 1;
      const key = segment === '' && Array.isArray(node) ? node.length : segment;
      const container = node as Record<string, unknown>;
      if (last) {
        container[key as string] = value;
        return;
      }
      const nextIsIndex = /^\d*$/.test(path[index + 1] ?? '');
      container[key as string] ??= nextIsIndex ? [] : {};
      node = container[key as string] as Record<string, unknown> | unknown[];
    });
  }
  return root;
}

const now = () => Math.floor(Date.now() / 1000);
const id = (prefix: string) => `${prefix}_test_${randomBytes(12).toString('hex')}`;

function error(
  response: ServerResponse,
  status: number,
  type: string,
  message: string,
  code?: string,
) {
  response.writeHead(status, { 'content-type': 'application/json', 'request-id': id('req') });
  response.end(JSON.stringify({ error: { type, message, ...(code ? { code } : {}) } }));
}

function send(response: ServerResponse, status: number, body: unknown, replayed = false) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'request-id': id('req'),
    'stripe-version': STRIPE_API_VERSION,
    ...(replayed ? { 'idempotent-replayed': 'true' } : {}),
  });
  response.end(JSON.stringify(body));
}

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function startFakeStripe(
  options: { apiKey?: string; products?: FakeStripeProduct[]; port?: number } = {},
): Promise<FakeStripe> {
  const apiKey = options.apiKey ?? `sk_test_${randomBytes(12).toString('hex')}`;
  const products = new Map<string, FakeStripeProduct>();
  for (const product of options.products ?? defaultFakeProducts())
    products.set(product.id, product);
  const sessions = new Map<string, Json>();
  const paymentIntents = new Map<string, Json>();
  const refunds = new Map<string, Json>();
  const events: Json[] = [];
  const requests: FakeStripe['requests'] = [];
  const webhookEndpoints: FakeStripe['webhookEndpoints'] = [];
  const idempotency = new Map<string, { fingerprint: string; status: number; body: unknown }>();
  const faults: { method: string; pathPrefix: string; fault: FakeStripeFault; holdMs: number }[] =
    [];
  let baseUrl = '';
  let refundMode: 'pending' | 'succeeded' = 'pending';

  const priceObject = (product: FakeStripeProduct, expand: boolean): Json => ({
    id: product.priceId,
    object: 'price',
    active: product.active,
    billing_scheme: 'per_unit',
    created: 1_790_000_000,
    currency: product.currency,
    livemode: false,
    lookup_key: null,
    metadata: {},
    nickname: null,
    product: expand ? productObject(product) : product.id,
    recurring: null,
    tax_behavior: 'inclusive',
    type: 'one_time',
    unit_amount: product.unitAmount,
    unit_amount_decimal: String(product.unitAmount),
  });
  const productObject = (product: FakeStripeProduct): Json => ({
    id: product.id,
    object: 'product',
    active: product.active,
    created: 1_790_000_000,
    default_price: product.priceId,
    description: product.description,
    images: [],
    livemode: false,
    metadata: {},
    name: product.name,
    updated: 1_790_000_000,
    url: null,
  });

  const event = (type: string, object: Json): Json => {
    const created: Json = {
      id: id('evt'),
      object: 'event',
      api_version: STRIPE_API_VERSION,
      created: now(),
      data: { object: structuredClone(object) },
      livemode: false,
      pending_webhooks: webhookEndpoints.length,
      request: { id: null, idempotency_key: null },
      type,
    };
    events.push(created);
    return created;
  };

  const deliver = async (events: Json[]) => {
    for (const item of events) {
      const payload = JSON.stringify(item);
      for (const endpoint of webhookEndpoints) {
        const timestamp = now();
        const signature = createHmac('sha256', endpoint.secret)
          .update(`${timestamp}.${payload}`)
          .digest('hex');
        await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'stripe-signature': `t=${timestamp},v1=${signature}`,
          },
          body: payload,
        }).catch(() => undefined);
      }
    }
  };

  const pay = async (sessionId: string): Promise<Json[]> => {
    const session = sessions.get(sessionId);
    if (session?.status !== 'open') throw new Error(`Session ${sessionId} is not open`);
    const intentId = id('pi');
    const intent: Json = {
      id: intentId,
      object: 'payment_intent',
      amount: session.amount_total,
      amount_received: session.amount_total,
      currency: session.currency,
      created: now(),
      livemode: false,
      metadata: session.metadata,
      status: 'succeeded',
      refunded: 0,
    };
    paymentIntents.set(intentId, intent);
    Object.assign(session, {
      status: 'complete',
      payment_status: 'paid',
      payment_intent: intentId,
      url: null,
    });
    const created = [
      event('checkout.session.completed', session),
      event('payment_intent.succeeded', intent),
    ];
    await deliver(created);
    return created;
  };

  const expire = async (sessionId: string): Promise<Json> => {
    const session = sessions.get(sessionId);
    if (session?.status !== 'open') throw new Error(`Session ${sessionId} is not open`);
    Object.assign(session, { status: 'expired', url: null });
    const created = event('checkout.session.expired', session);
    await deliver([created]);
    return created;
  };

  const settleRefund = async (refundId: string, outcome: 'succeeded' | 'failed') => {
    const refund = refunds.get(refundId);
    if (!refund) throw new Error(`No refund ${refundId}`);
    refund.status = outcome;
    if (outcome === 'failed') {
      refund.failure_reason = 'expired_or_canceled_card';
      const intent = paymentIntents.get(String(refund.payment_intent));
      if (intent) intent.refunded = Number(intent.refunded) - Number(refund.amount);
    }
    const created = event(outcome === 'failed' ? 'refund.failed' : 'refund.updated', refund);
    await deliver([created]);
    return created;
  };

  const createSession = (params: Json): Json | { error: [number, string, string] } => {
    const items = (params.line_items ?? []) as Json[];
    if (!params.mode || items.length === 0) {
      return { error: [400, 'invalid_request_error', 'Missing required param: line_items.'] };
    }
    let total = 0;
    let currency = '';
    for (const item of items) {
      const quantity = Number(item.quantity ?? 1);
      const data = item.price_data as Json | undefined;
      let unit: number;
      if (data) {
        unit = Number(data.unit_amount);
        currency = String(data.currency);
        if (!products.has(String(data.product))) {
          return { error: [400, 'invalid_request_error', 'No such product'] };
        }
      } else {
        const product = [...products.values()].find((p) => p.priceId === item.price);
        if (!product) return { error: [400, 'invalid_request_error', 'No such price'] };
        unit = product.unitAmount;
        currency = product.currency;
      }
      total += unit * quantity;
    }
    const subtotal = total;
    for (const option of (params.shipping_options ?? []) as Json[]) {
      const rate = option.shipping_rate_data as Json | undefined;
      const fixed = rate?.fixed_amount as Json | undefined;
      if (fixed) total += Number(fixed.amount);
    }
    const sessionId = id('cs');
    const session: Json = {
      id: sessionId,
      object: 'checkout.session',
      amount_subtotal: subtotal,
      amount_total: total,
      cancel_url: params.cancel_url ?? null,
      client_reference_id: params.client_reference_id ?? null,
      created: now(),
      currency,
      customer: null,
      customer_details: null,
      expires_at: params.expires_at ? Number(params.expires_at) : now() + 24 * 3600,
      livemode: false,
      locale: params.locale ?? null,
      metadata: params.metadata ?? {},
      mode: params.mode,
      payment_intent: null,
      payment_status: 'unpaid',
      status: 'open',
      success_url: params.success_url ?? null,
      url: `${baseUrl}/pay/${sessionId}`,
    };
    sessions.set(sessionId, session);
    return session;
  };

  const createRefund = (params: Json): Json | { error: [number, string, string] } => {
    const intent = paymentIntents.get(String(params.payment_intent));
    if (!intent) return { error: [400, 'invalid_request_error', 'No such payment_intent'] };
    const amount = params.amount ? Number(params.amount) : Number(intent.amount);
    if (Number(intent.refunded) + amount > Number(intent.amount)) {
      return { error: [400, 'invalid_request_error', 'Refund amount exceeds the charge'] };
    }
    intent.refunded = Number(intent.refunded) + amount;
    const refund: Json = {
      id: id('re'),
      object: 'refund',
      amount,
      charge: id('ch'),
      created: now(),
      currency: intent.currency,
      metadata: params.metadata ?? {},
      payment_intent: intent.id,
      reason: params.reason ?? null,
      status: refundMode,
      failure_reason: null,
    };
    refunds.set(String(refund.id), refund);
    event('refund.created', refund);
    return refund;
  };

  const list = (items: Json[], url: string, limit: number, startingAfter?: string) => {
    let start = 0;
    if (startingAfter) start = items.findIndex((i) => i.id === startingAfter) + 1;
    const data = items.slice(start, start + limit);
    return { object: 'list', data, has_more: start + limit < items.length, url };
  };

  async function api(request: IncomingMessage, response: ServerResponse, url: URL) {
    const method = request.method ?? 'GET';
    const text = await readBody(request);
    const idempotencyKey = (request.headers['idempotency-key'] as string | undefined) ?? null;
    requests.push({ method, path: url.pathname, idempotencyKey });
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      error(response, 401, 'invalid_request_error', 'Invalid API Key provided.');
      return;
    }
    const fault = faults.findIndex(
      (f) => f.method === method && url.pathname.startsWith(f.pathPrefix),
    );
    const injected = fault >= 0 ? faults.splice(fault, 1)[0] : undefined;
    if (injected?.fault === 'error_500') {
      error(response, 500, 'api_error', 'Something went wrong on our end.');
      return;
    }
    if (injected?.fault === 'timeout_before') {
      setTimeout(() => response.destroy(), injected.holdMs);
      return;
    }
    const params = method === 'GET' ? parseStripeForm(url.search.slice(1)) : parseStripeForm(text);
    const fingerprint = text;
    if (method === 'POST' && idempotencyKey) {
      const seen = idempotency.get(idempotencyKey);
      if (seen) {
        if (seen.fingerprint !== fingerprint) {
          error(
            response,
            400,
            'idempotency_error',
            'Keys for idempotent requests can only be used with the same parameters they were first used with.',
          );
          return;
        }
        send(response, seen.status, seen.body, true);
        return;
      }
    }
    const result = route(method, url.pathname, params);
    if (method === 'POST' && idempotencyKey && result.status < 500) {
      idempotency.set(idempotencyKey, { fingerprint, status: result.status, body: result.body });
    }
    if (injected?.fault === 'timeout_after') {
      // Applied, but the answer never arrives in time.
      setTimeout(() => response.destroy(), injected.holdMs);
      return;
    }
    send(response, result.status, result.body);
  }

  function route(method: string, path: string, params: Json): { status: number; body: unknown } {
    const fail = (status: number, type: string, message: string, code?: string) => ({
      status,
      body: { error: { type, message, ...(code ? { code } : {}) } },
    });
    const expand = JSON.stringify(params.expand ?? []);
    const priceMatch = /^\/v1\/prices\/([^/]+)$/.exec(path);
    const productMatch = /^\/v1\/products\/([^/]+)$/.exec(path);
    const sessionMatch = /^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/.exec(path);
    const refundMatch = /^\/v1\/refunds\/([^/]+)$/.exec(path);
    if (method === 'GET' && path === '/v1/prices') {
      const all = [...products.values()]
        .filter((p) => params.active === undefined || String(p.active) === params.active)
        .map((p) => priceObject(p, expand.includes('data.product')));
      return { status: 200, body: list(all, '/v1/prices', Number(params.limit ?? 10)) };
    }
    if (method === 'GET' && priceMatch) {
      const product = [...products.values()].find((p) => p.priceId === priceMatch[1]);
      if (!product) return fail(404, 'invalid_request_error', 'No such price', 'resource_missing');
      return { status: 200, body: priceObject(product, expand.includes('product')) };
    }
    if (method === 'GET' && productMatch) {
      const product = products.get(productMatch[1] ?? '');
      if (!product)
        return fail(404, 'invalid_request_error', 'No such product', 'resource_missing');
      return { status: 200, body: productObject(product) };
    }
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      const created = createSession(params);
      if ('error' in created) return fail(...(created.error as [number, string, string]));
      return { status: 200, body: created };
    }
    if (method === 'GET' && path === '/v1/checkout/sessions') {
      const gte = Number((params.created as Json | undefined)?.gte ?? 0);
      const all = [...sessions.values()]
        .filter((s) => Number(s.created) >= gte)
        .sort((a, b) => Number(b.created) - Number(a.created));
      return {
        status: 200,
        body: list(
          all,
          '/v1/checkout/sessions',
          Number(params.limit ?? 10),
          params.starting_after as string | undefined,
        ),
      };
    }
    if (sessionMatch) {
      const session = sessions.get(sessionMatch[1] ?? '');
      if (!session) {
        return fail(404, 'invalid_request_error', 'No such checkout.session', 'resource_missing');
      }
      if (method === 'POST' && sessionMatch[2]) {
        if (session.status !== 'open') {
          return fail(
            400,
            'invalid_request_error',
            'Only Checkout Sessions with a status in ["open"] can be expired.',
          );
        }
        Object.assign(session, { status: 'expired', url: null });
        void deliver([event('checkout.session.expired', session)]);
        return { status: 200, body: session };
      }
      if (method === 'GET') {
        if (session.status === 'open' && Number(session.expires_at) <= now()) {
          Object.assign(session, { status: 'expired', url: null });
          void deliver([event('checkout.session.expired', session)]);
        }
        return { status: 200, body: session };
      }
    }
    if (method === 'POST' && path === '/v1/refunds') {
      const created = createRefund(params);
      if ('error' in created) return fail(...(created.error as [number, string, string]));
      void deliver([events.at(-1) as Json]);
      return { status: 200, body: created };
    }
    if (method === 'GET' && path === '/v1/refunds') {
      const all = [...refunds.values()].filter(
        (r) => !params.payment_intent || r.payment_intent === params.payment_intent,
      );
      return { status: 200, body: list(all, '/v1/refunds', Number(params.limit ?? 10)) };
    }
    if (method === 'GET' && refundMatch) {
      const refund = refunds.get(refundMatch[1] ?? '');
      if (!refund) return fail(404, 'invalid_request_error', 'No such refund', 'resource_missing');
      return { status: 200, body: refund };
    }
    return fail(404, 'invalid_request_error', `Unrecognized request URL (${method}: ${path}).`);
  }

  /** A minimal hosted payment page: summary, Pay and Cancel. No card fields are collected. */
  async function hosted(request: IncomingMessage, response: ServerResponse, url: URL) {
    const sessionId = url.pathname.split('/')[2] ?? '';
    const session = sessions.get(sessionId);
    if (!session) {
      response.writeHead(404).end('Unknown session');
      return;
    }
    if (request.method === 'POST' && session.status === 'open') {
      await pay(sessionId);
      const target = String(session.success_url ?? '/').replace('{CHECKOUT_SESSION_ID}', sessionId);
      response.writeHead(303, { location: target }).end();
      return;
    }
    const amount = (Number(session.amount_total) / 100).toFixed(2);
    const currency = String(session.currency).toUpperCase();
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Test checkout</title></head><body><main>
<h1>Test checkout</h1><p>This is a test payment page. No card details are collected.</p>
<p>Total: <strong data-testid="fake-total">${escapeHtml(currency)} ${escapeHtml(amount)}</strong></p>
${
  session.status === 'open'
    ? `<form method="post"><button type="submit">Pay ${escapeHtml(currency)} ${escapeHtml(amount)}</button></form>
<p><a href="${escapeHtml(String(session.cancel_url ?? '/'))}">Cancel</a></p>`
    : `<p>This checkout is ${escapeHtml(String(session.status))}.</p>`
}</main></body></html>`);
  }

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake-stripe');
    const handle = url.pathname.startsWith('/pay/')
      ? hosted(request, response, url)
      : url.pathname.startsWith('/__fake/')
        ? control(request, response, url)
        : api(request, response, url);
    handle.catch((cause: unknown) => {
      if (!response.headersSent) error(response, 500, 'api_error', String(cause));
    });
  });

  /** Test-only controls for runs where the tests live in another process. */
  async function control(request: IncomingMessage, response: ServerResponse, url: URL) {
    const body = await readBody(request);
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (parts[1] === 'webhook-endpoints' && request.method === 'POST') {
        webhookEndpoints.push(JSON.parse(body) as { url: string; secret: string });
        send(response, 200, { ok: true });
      } else if (parts[1] === 'sessions' && parts[3] === 'expire') {
        send(response, 200, await expire(parts[2] ?? ''));
      } else if (parts[1] === 'refunds' && parts[3] === 'settle') {
        const outcome = url.searchParams.get('outcome') === 'failed' ? 'failed' : 'succeeded';
        send(response, 200, await settleRefund(parts[2] ?? '', outcome));
      } else if (parts[1] === 'refunds' && request.method === 'GET') {
        send(response, 200, { data: [...refunds.values()] });
      } else {
        error(response, 404, 'invalid_request_error', 'Unknown control');
      }
    } catch (cause) {
      error(response, 400, 'invalid_request_error', String(cause));
    }
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: baseUrl,
    apiKey,
    products,
    sessions,
    paymentIntents,
    refunds,
    requests,
    webhookEndpoints,
    events,
    get refundMode() {
      return refundMode;
    },
    set refundMode(mode) {
      refundMode = mode;
    },
    inject(method, pathPrefix, fault, holdMs = 3000) {
      faults.push({ method, pathPrefix, fault, holdMs });
    },
    setPrice(productId, unitAmount) {
      const product = products.get(productId);
      if (!product) throw new Error(`No product ${productId}`);
      product.unitAmount = unitAmount;
    },
    pay,
    expire,
    settleRefund,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The demo store from the design boards (Northline), priced in AED. */
export function defaultFakeProducts(): FakeStripeProduct[] {
  return [
    {
      id: 'prod_notebook',
      name: 'Everyday Notebook',
      description: 'Lined pages, A5, 160 pages',
      priceId: 'price_notebook',
      unitAmount: 3500,
      currency: 'aed',
      active: true,
    },
    {
      id: 'prod_pens',
      name: 'Black Pen Set',
      description: 'Set of 2 ballpoint pens',
      priceId: 'price_pens',
      unitAmount: 1500,
      currency: 'aed',
      active: true,
    },
  ];
}
