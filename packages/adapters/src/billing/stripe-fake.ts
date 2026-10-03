import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseStripeForm } from '../commerce/stripe-fake.js';
import { BILLING_STRIPE_API_VERSION } from './stripe-shapes.js';

/**
 * A stateful stand-in for the parts of Stripe Billing Hamnivo uses, for tests: customers,
 * subscription Checkout Sessions, Customer Portal sessions, subscriptions and invoices, in the
 * shapes of API version 2026-09-30.endive. The real Stripe SDK talks to it over HTTP (form
 * bodies, idempotency keys, error bodies). Test controls play what a customer or Stripe's dunning
 * would do and return the events Stripe would send; `signBillingEvent` signs one the way Stripe
 * does (`t=…,v1=…`) so the SDK's own verification runs. It is not Stripe.
 */

type Json = Record<string, unknown>;

export interface FakeBillingPrice {
  id: string;
  unitAmount: number;
  currency: string;
}

export interface FakeStripeBilling {
  url: string;
  apiKey: string;
  customers: Map<string, Json>;
  sessions: Map<string, Json>;
  subscriptions: Map<string, Json>;
  invoices: Map<string, Json>;
  /** Every API request, oldest first. */
  requests: { method: string; path: string; idempotencyKey: string | null }[];
  /** The customer pays on the checkout page: subscription created, first invoice paid. */
  completeCheckout(sessionId: string): Json[];
  /** A renewal fails: an open invoice, the subscription past due. */
  failPayment(subscriptionId: string): Json[];
  /** The latest open invoice is paid (a retry worked): the subscription is active again. */
  payLatestInvoice(subscriptionId: string): Json[];
  /** Stripe gave up after its retries (or the customer cancelled): the subscription ends. */
  cancel(subscriptionId: string): Json[];
  /** The customer switched plans in the portal. */
  changePrice(subscriptionId: string, priceId: string): Json[];
  /** Makes the next request whose path starts with `pathPrefix` answer 500. */
  failNext(method: string, pathPrefix: string): void;
  close(): Promise<void>;
}

const now = () => Math.floor(Date.now() / 1000);
const newId = (prefix: string) => `${prefix}_test_${randomBytes(12).toString('hex')}`;
const DAY = 86_400;

/** Signs an event like Stripe does, for the SDK's verification. */
export function signBillingEvent(
  event: Json,
  secret: string,
  at: Date = new Date(),
): { rawBody: Buffer; headers: Record<string, string> } {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(at.getTime() / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return {
    rawBody: Buffer.from(payload),
    headers: {
      'content-type': 'application/json',
      'stripe-signature': `t=${timestamp},v1=${signature}`,
    },
  };
}

function send(response: ServerResponse, status: number, body: unknown, replayed = false) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'request-id': newId('req'),
    'stripe-version': BILLING_STRIPE_API_VERSION,
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

export async function startFakeStripeBilling(
  options: { apiKey?: string; prices?: FakeBillingPrice[] } = {},
): Promise<FakeStripeBilling> {
  const apiKey = options.apiKey ?? `sk_test_${randomBytes(12).toString('hex')}`;
  const prices = new Map<string, FakeBillingPrice>(
    (options.prices ?? [{ id: 'price_test_pro', unitAmount: 4900, currency: 'usd' }]).map((p) => [
      p.id,
      p,
    ]),
  );
  const customers = new Map<string, Json>();
  const sessions = new Map<string, Json>();
  const subscriptions = new Map<string, Json>();
  const invoices = new Map<string, Json>();
  const requests: FakeStripeBilling['requests'] = [];
  const idempotency = new Map<string, { fingerprint: string; status: number; body: unknown }>();
  const failures: { method: string; pathPrefix: string }[] = [];
  let baseUrl = '';

  const event = (type: string, object: Json): Json => ({
    id: newId('evt'),
    object: 'event',
    api_version: BILLING_STRIPE_API_VERSION,
    created: now(),
    data: { object: structuredClone(object) },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
  });

  const priceObject = (price: FakeBillingPrice): Json => ({
    id: price.id,
    object: 'price',
    active: true,
    currency: price.currency,
    recurring: { interval: 'month', interval_count: 1 },
    type: 'recurring',
    unit_amount: price.unitAmount,
  });

  const invoiceFor = (subscription: Json, status: 'paid' | 'open'): Json => {
    const item = (subscription.items as { data: Json[] }).data[0] as Json;
    const price = item.price as Json;
    const created = now();
    const invoice: Json = {
      id: newId('in'),
      object: 'invoice',
      number: `HV-${randomBytes(3).toString('hex').toUpperCase()}`,
      status,
      currency: price.currency,
      total: price.unit_amount,
      amount_due: price.unit_amount,
      amount_paid: status === 'paid' ? price.unit_amount : 0,
      created,
      customer: subscription.customer,
      hosted_invoice_url: `${baseUrl}/invoice/${created}`,
      invoice_pdf: `${baseUrl}/invoice/${created}/pdf`,
      parent: {
        type: 'subscription_details',
        quote_details: null,
        subscription_details: {
          subscription: subscription.id,
          metadata: structuredClone(subscription.metadata),
        },
      },
      attempt_count: status === 'paid' ? 1 : 1,
      next_payment_attempt: status === 'open' ? created + 3 * DAY : null,
      status_transitions: { paid_at: status === 'paid' ? created : null, finalized_at: created },
    };
    invoices.set(String(invoice.id), invoice);
    return invoice;
  };

  const control = {
    completeCheckout(sessionId: string): Json[] {
      const session = sessions.get(sessionId);
      if (session?.status !== 'open') throw new Error(`Session ${sessionId} is not open`);
      const data = session.subscription_data as Json | undefined;
      const trialDays = Number(data?.trial_period_days ?? 0);
      const lineItems = session.line_items as { price: string }[];
      const price = prices.get(lineItems[0]?.price ?? '');
      if (!price) throw new Error('unknown price');
      const start = now();
      const subscription: Json = {
        id: newId('sub'),
        object: 'subscription',
        customer: session.customer,
        status: trialDays > 0 ? 'trialing' : 'active',
        cancel_at_period_end: false,
        created: start,
        trial_end: trialDays > 0 ? start + trialDays * DAY : null,
        metadata: structuredClone((data?.metadata as Json | undefined) ?? {}),
        items: {
          object: 'list',
          data: [
            {
              id: newId('si'),
              object: 'subscription_item',
              price: priceObject(price),
              quantity: 1,
              current_period_start: start,
              current_period_end: start + (trialDays > 0 ? trialDays : 30) * DAY,
            },
          ],
        },
      };
      subscriptions.set(String(subscription.id), subscription);
      Object.assign(session, { status: 'complete', subscription: subscription.id, url: null });
      const events = [
        event('checkout.session.completed', session),
        event('customer.subscription.created', subscription),
      ];
      if (trialDays === 0) events.push(event('invoice.paid', invoiceFor(subscription, 'paid')));
      return events;
    },
    failPayment(subscriptionId: string): Json[] {
      const subscription = subscriptions.get(subscriptionId);
      if (!subscription) throw new Error(`No subscription ${subscriptionId}`);
      const invoice = invoiceFor(subscription, 'open');
      subscription.status = 'past_due';
      return [
        event('invoice.payment_failed', invoice),
        event('customer.subscription.updated', subscription),
      ];
    },
    payLatestInvoice(subscriptionId: string): Json[] {
      const subscription = subscriptions.get(subscriptionId);
      if (!subscription) throw new Error(`No subscription ${subscriptionId}`);
      const open = [...invoices.values()]
        .filter(
          (i) =>
            i.status === 'open' &&
            (i.parent as { subscription_details: Json }).subscription_details.subscription ===
              subscriptionId,
        )
        .at(-1);
      if (!open) throw new Error('No open invoice');
      Object.assign(open, {
        status: 'paid',
        amount_paid: open.total,
        attempt_count: Number(open.attempt_count) + 1,
        next_payment_attempt: null,
        status_transitions: { paid_at: now(), finalized_at: open.created },
      });
      subscription.status = 'active';
      return [event('invoice.paid', open), event('customer.subscription.updated', subscription)];
    },
    cancel(subscriptionId: string): Json[] {
      const subscription = subscriptions.get(subscriptionId);
      if (!subscription) throw new Error(`No subscription ${subscriptionId}`);
      Object.assign(subscription, { status: 'canceled', canceled_at: now(), ended_at: now() });
      return [event('customer.subscription.deleted', subscription)];
    },
    changePrice(subscriptionId: string, priceId: string): Json[] {
      const subscription = subscriptions.get(subscriptionId);
      const price = prices.get(priceId);
      if (!subscription || !price) throw new Error('No such subscription or price');
      const item = (subscription.items as { data: Json[] }).data[0] as Json;
      item.price = priceObject(price);
      return [event('customer.subscription.updated', subscription)];
    },
  };

  const list = (items: Json[], url: string, limit: number) => ({
    object: 'list',
    data: items.slice(0, limit),
    has_more: items.length > limit,
    url,
  });

  function route(method: string, path: string, params: Json): { status: number; body: unknown } {
    const fail = (status: number, message: string, code?: string) => ({
      status,
      body: { error: { type: 'invalid_request_error', message, ...(code ? { code } : {}) } },
    });
    if (method === 'POST' && path === '/v1/customers') {
      const customer: Json = {
        id: newId('cus'),
        object: 'customer',
        created: now(),
        email: params.email ?? null,
        name: params.name ?? null,
        metadata: params.metadata ?? {},
      };
      customers.set(String(customer.id), customer);
      return { status: 200, body: customer };
    }
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      if (params.mode !== 'subscription') return fail(400, 'Only subscription mode is faked');
      if (!customers.has(String(params.customer))) {
        return fail(400, `No such customer: '${String(params.customer)}'`, 'resource_missing');
      }
      const lineItems = (params.line_items as Json[] | undefined) ?? [];
      const priceId = String(lineItems[0]?.price ?? '');
      if (!prices.has(priceId)) return fail(400, `No such price: '${priceId}'`, 'resource_missing');
      const sessionId = newId('cs');
      const session: Json = {
        id: sessionId,
        object: 'checkout.session',
        mode: 'subscription',
        status: 'open',
        url: `${baseUrl}/checkout/${sessionId}`,
        customer: params.customer,
        client_reference_id: params.client_reference_id ?? null,
        metadata: params.metadata ?? {},
        subscription: null,
        success_url: params.success_url,
        cancel_url: params.cancel_url,
        created: now(),
        expires_at: now() + DAY,
        line_items: lineItems,
        subscription_data: params.subscription_data ?? {},
      };
      sessions.set(sessionId, session);
      return { status: 200, body: session };
    }
    if (method === 'POST' && path === '/v1/billing_portal/sessions') {
      if (!customers.has(String(params.customer))) {
        return fail(400, `No such customer: '${String(params.customer)}'`, 'resource_missing');
      }
      const sessionId = newId('bps');
      return {
        status: 200,
        body: {
          id: sessionId,
          object: 'billing_portal.session',
          customer: params.customer,
          return_url: params.return_url,
          url: `${baseUrl}/portal/${sessionId}`,
          created: now(),
          livemode: false,
        },
      };
    }
    if (method === 'GET' && path === '/v1/invoices') {
      const all = [...invoices.values()]
        .filter((i) => !params.customer || i.customer === params.customer)
        .sort((a, b) => Number(b.created) - Number(a.created));
      return { status: 200, body: list(all, '/v1/invoices', Number(params.limit ?? 10)) };
    }
    const subscriptionMatch = /^\/v1\/subscriptions\/([^/]+)$/.exec(path);
    if (method === 'GET' && subscriptionMatch) {
      const subscription = subscriptions.get(subscriptionMatch[1] ?? '');
      if (!subscription) return fail(404, 'No such subscription', 'resource_missing');
      return { status: 200, body: subscription };
    }
    return fail(404, `Unrecognized request URL (${method}: ${path}).`);
  }

  async function api(request: IncomingMessage, response: ServerResponse, url: URL) {
    const method = request.method ?? 'GET';
    const text = await readBody(request);
    const idempotencyKey = (request.headers['idempotency-key'] as string | undefined) ?? null;
    requests.push({ method, path: url.pathname, idempotencyKey });
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      send(response, 401, {
        error: { type: 'invalid_request_error', message: 'Invalid API Key provided.' },
      });
      return;
    }
    const failure = failures.findIndex(
      (f) => f.method === method && url.pathname.startsWith(f.pathPrefix),
    );
    if (failure >= 0) {
      failures.splice(failure, 1);
      send(response, 500, { error: { type: 'api_error', message: 'Something went wrong.' } });
      return;
    }
    const params = method === 'GET' ? parseStripeForm(url.search.slice(1)) : parseStripeForm(text);
    if (method === 'POST' && idempotencyKey) {
      const seen = idempotency.get(idempotencyKey);
      if (seen) {
        if (seen.fingerprint !== text) {
          send(response, 400, {
            error: {
              type: 'idempotency_error',
              message:
                'Keys for idempotent requests can only be used with the same parameters they were first used with.',
            },
          });
          return;
        }
        send(response, seen.status, seen.body, true);
        return;
      }
    }
    const result = route(method, url.pathname, params);
    if (method === 'POST' && idempotencyKey && result.status < 500) {
      idempotency.set(idempotencyKey, {
        fingerprint: text,
        status: result.status,
        body: result.body,
      });
    }
    send(response, result.status, result.body);
  }

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake-stripe-billing');
    api(request, response, url).catch((cause: unknown) => {
      if (!response.headersSent) {
        send(response, 500, { error: { type: 'api_error', message: String(cause) } });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    url: baseUrl,
    apiKey,
    customers,
    sessions,
    subscriptions,
    invoices,
    requests,
    ...control,
    failNext(method: string, pathPrefix: string) {
      failures.push({ method, pathPrefix });
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
