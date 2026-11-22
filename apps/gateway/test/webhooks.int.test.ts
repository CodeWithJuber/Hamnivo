import { randomUUID } from 'node:crypto';
import type { ResolvedAddress } from '@hamnivo/adapters/net';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { verifyWebhook } from '@hamnivo/server';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhookDispatcher } from '../src/developer/webhooks/dispatcher.service.js';
import { Receiver, withTwoStep } from './developer-support.js';
import type { Client } from './harness.js';
import { customerStarts, type Shop } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice } from './slice-harness.js';

let slice: Slice;
let shop: Shop;
let receiver: Receiver;
let trap: Receiver;
let endpoint: { id: string; signingSecret: string; version: number };

/** Host names the gateway resolves in these tests (DNS is replaced in both processes). */
const dns: Record<string, string[]> = {
  'rebind.example.com': ['10.1.2.3'],
  'hooks.partner.example': ['93.184.216.34'],
};

const SUBSCRIBED = [
  'conversation.created',
  'conversation.updated',
  'conversation.resolved',
  'message.created',
  'handoff.requested',
  'handoff.accepted',
  'handoff.returned',
] as const;

const hookPath = '/hooks';

async function dispatch(): Promise<void> {
  const dispatcher = slice.worker.get(WebhookDispatcher);
  for (let round = 0; round < 10; round += 1) {
    if ((await dispatcher.drainOnce()) === 0) return;
  }
}

/** Delivers everything: Chatwoot callbacks, the outbox (fan-out) and webhook requests. */
async function settle(): Promise<void> {
  await slice.drain();
  await dispatch();
}

const tenantId = () => fromPublicId('tenant', shop.tenantId);

/** Makes pending retries due now (instead of waiting for the backoff). */
async function forceDue(): Promise<void> {
  await withTenant(slice.app, { tenantId: tenantId() }, (tx) =>
    tx
      .update(schema.webhookDeliveries)
      .set({ nextAttemptAt: sql`now() - interval '1 second'` })
      .where(eq(schema.webhookDeliveries.status, 'pending')),
  );
}

async function verified(
  request: { body: string; headers: Record<string, unknown> },
  secret: string | string[],
) {
  return verifyWebhook(request.body, request.headers as Record<string, string>, {
    secret,
  });
}

beforeAll(async () => {
  receiver = await new Receiver().start();
  trap = await new Receiver().start();
  slice = await startSlice({
    env: {
      EGRESS_TRUSTED_ORIGINS: `${receiver.origin},${trap.origin}`,
      WEBHOOK_DISABLE_AFTER_FAILURES: '3',
      WEBHOOK_DISABLE_AFTER_HOURS: '0',
    },
    egressResolver: async (host): Promise<ResolvedAddress[]> => {
      const addresses = dns[host];
      if (!addresses) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
  });
  shop = await connectedTenant(slice, 'hooks');
});

afterAll(async () => {
  await slice?.close();
  await receiver?.close();
  await trap?.close();
});

describe('webhook endpoints', () => {
  it('refuses addresses outside the public internet before storing anything', async () => {
    const cases: [string, string][] = [
      ['https://10.0.0.1/hook', 'private'],
      ['https://[::1]/hook', 'private'],
      ['https://localhost/hook', 'private'],
      ['https://intranet/hook', 'private'],
      ['https://rebind.example.com/hook', 'private'],
      ['http://hooks.example.com/hook', 'https://'],
      ['https://user:pw@hooks.example.com/hook', 'https://'],
      ['ftp://hooks.example.com/hook', 'https://'],
    ];
    for (const [url, message] of cases) {
      const refused = await shop.owner.post('/v1/admin/webhooks/endpoints', {
        url,
        eventTypes: ['order.created'],
      });
      expect(refused.status, url).toBe(422);
      expect(refused.body.fields[0].path, url).toBe('url');
      expect(refused.body.fields[0].message, url).toContain(message);
    }
    const list = await shop.owner.get('/v1/admin/webhooks/endpoints');
    expect(list.body.items).toEqual([]);
  });

  it('shows the signing secret once and keeps it out of lists and the audit log', async () => {
    const created = await shop.owner.post('/v1/admin/webhooks/endpoints', {
      url: `${receiver.origin}${hookPath}`,
      description: 'Orders system',
      eventTypes: SUBSCRIBED,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.signingSecret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(created.body).toMatchObject({
      status: 'active',
      verifiedAt: null,
      secret: { hint: created.body.signingSecret.slice(-4), previousValidUntil: null },
    });
    endpoint = created.body;

    const list = await shop.owner.get('/v1/admin/webhooks/endpoints');
    expect(list.body.items).toHaveLength(1);
    const secretBody = created.body.signingSecret.slice(6, 30);
    expect(JSON.stringify(list.body)).not.toContain(secretBody);
    const audit = await shop.owner.get('/v1/admin/audit?action=webhook.endpoint_created');
    expect(audit.body.items[0].data).toMatchObject({ url: `${receiver.origin}${hookPath}` });
    expect(JSON.stringify(audit.body)).not.toContain(secretBody);
    // Stored encrypted in the secret broker, never in the endpoint row.
    const [row] = await withTenant(slice.app, { tenantId: tenantId() }, (tx) =>
      tx
        .select({ kind: schema.secrets.kind, ciphertext: schema.secrets.ciphertext })
        .from(schema.secrets)
        .innerJoin(
          schema.webhookEndpoints,
          eq(schema.webhookEndpoints.secretId, schema.secrets.id),
        ),
    );
    expect(row?.kind).toBe('webhook.signing_secret');
    expect(row?.ciphertext.toString('utf8')).not.toContain(secretBody);
  });

  it('sends a signed test event that the server SDK verifies', async () => {
    receiver.reset();
    const tested = await shop.owner.post(`/v1/admin/webhooks/endpoints/${endpoint.id}/test`);
    expect(tested.status, JSON.stringify(tested.body)).toBe(200);
    expect(tested.body).toMatchObject({
      verified: true,
      attempt: { attempt: 1, outcome: 'succeeded', statusCode: 204 },
      delivery: { status: 'succeeded', eventType: 'webhook.test' },
    });
    const [request] = receiver.at(hookPath);
    expect(request?.headers['user-agent']).toBe('Hamnivo-Webhooks/1.0');
    expect(request?.headers['content-type']).toBe('application/json');
    const event = await verified(request as never, endpoint.signingSecret);
    expect(event).toMatchObject({
      type: 'webhook.test',
      schemaVersion: '1.0',
      tenantId: shop.tenantId,
      data: { endpointId: endpoint.id },
    });
    expect(event.id).toBe(request?.headers['webhook-id']);
    expect(event.id).toBe(tested.body.delivery.eventId);
    await expect(
      verified(request as never, `whsec_${Buffer.alloc(32, 7).toString('base64')}`),
    ).rejects.toThrow();
    const after = await shop.owner.get(`/v1/admin/webhooks/endpoints/${endpoint.id}`);
    expect(after.body.verifiedAt).not.toBeNull();

    // A failed test is reported and logged, without counting against the endpoint.
    receiver.answer({ status: 503, body: 'maintenance' });
    const failed = await shop.owner.post(`/v1/admin/webhooks/endpoints/${endpoint.id}/test`);
    expect(failed.body).toMatchObject({
      verified: false,
      attempt: { outcome: 'http_error', statusCode: 503, responseExcerpt: 'maintenance' },
      delivery: { status: 'failed', attempts: 1, nextAttemptAt: null },
    });
    const health = await shop.owner.get(`/v1/admin/webhooks/endpoints/${endpoint.id}`);
    expect(health.body.health.consecutiveFailures).toBe(0);
  });
});

describe('a test event', () => {
  it('is sent once, even when the delivery worker runs while the endpoint is slow to answer', async () => {
    receiver.reset();
    let answerNow = () => {};
    const slow = new Promise<void>((resolve) => {
      answerNow = resolve;
    });
    receiver.answer({ status: 503, body: 'slow', wait: slow });
    const tested = shop.owner.post(`/v1/admin/webhooks/endpoints/${endpoint.id}/test`);
    // The test's own request waits at the endpoint while the worker looks for deliveries due.
    await expect.poll(() => receiver.at(hookPath).length).toBe(1);
    await dispatch();
    answerNow();
    const result = await tested;
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({
      attempt: { statusCode: 503 },
      delivery: { status: 'failed', attempts: 1, nextAttemptAt: null },
    });
    await dispatch();
    expect(receiver.at(hookPath).map((request) => request.json.type)).toEqual(['webhook.test']);
  });
});

describe('events from conversations', () => {
  let conversationId: string;

  it('sends what the customer saw, and never internal notes', async () => {
    receiver.reset();
    const started = await customerStarts(slice, shop, 'Where is my order HV-1042?');
    conversationId = started.conversationId;
    await settle();
    const note = await shop.owner.post(`/v1/conversations/${conversationId}/messages`, {
      clientMessageId: randomUUID(),
      text: 'INTERNAL-ONLY courier lost parcel 77',
      visibility: 'internal',
    });
    expect(note.status, JSON.stringify(note.body)).toBe(202);
    await settle();

    const requests = receiver.at(hookPath);
    const events = await Promise.all(
      requests.map((r) => verified(r as never, endpoint.signingSecret)),
    );
    const types = events.map((e) => e.type);
    expect(types).toContain('conversation.created');
    const messages = events.filter((e) => e.type === 'message.created');
    expect(messages.map((e) => (e.data as any).message.sender.kind)).toEqual(
      expect.arrayContaining(['customer', 'ai_agent']),
    );
    expect(
      messages.find((e) => (e.data as any).message.sender.kind === 'customer')?.data,
    ).toMatchObject({
      conversationId,
      message: {
        visibility: 'public',
        parts: [{ type: 'text', text: 'Where is my order HV-1042?' }],
      },
    });
    expect(JSON.stringify(requests)).not.toContain('INTERNAL-ONLY');
    // Each event once, under its own id; the webhook-id header is the event id.
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    for (const request of requests) {
      expect(request.headers['webhook-id']).toBe(request.json.id);
    }
  });

  it('announces handoffs when a person takes over and hands back', async () => {
    receiver.reset();
    const takeover = await shop.owner.post(`/v1/conversations/${conversationId}/takeover`, {});
    expect(takeover.status, JSON.stringify(takeover.body)).toBe(200);
    await settle();
    const back = await shop.owner.post(`/v1/conversations/${conversationId}/return-to-ai`, {});
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    await settle();
    const handoffs = receiver
      .at(hookPath)
      .map((r) => r.json)
      .filter((e) => e.type.startsWith('handoff.'));
    expect(handoffs.map((e) => [e.type, e.data.from, e.data.to])).toEqual([
      ['handoff.accepted', 'ai', 'person'],
      ['handoff.returned', 'person', 'ai'],
    ]);
    expect(handoffs[0]?.data.staffId).toMatch(/^stf_/);
    expect(handoffs[0]?.data.reason).toBe('staff_takeover');
  });
});

describe('retries, turning off and replays', () => {
  it('retries a failed delivery later with the same event id and body', async () => {
    receiver.reset();
    receiver.answer({ status: 500, body: `crash whsec_${'Q'.repeat(40)} token` });
    await customerStarts(slice, shop, 'Second question');
    await slice.drain();
    // Only the first request fails; the others in the batch succeed.
    await slice.worker.get(WebhookDispatcher).drainOnce();
    const failed = await withTenant(slice.app, { tenantId: tenantId() }, (tx) =>
      tx
        .select()
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.status, 'pending')),
    );
    expect(failed).toHaveLength(1);
    const delivery = failed[0] as (typeof failed)[number];
    expect(delivery.attempts).toBe(1);
    expect(delivery.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now());
    const logged = await shop.owner.get(`/v1/admin/webhooks/deliveries?status=pending`);
    const pending = logged.body.items[0];
    expect(pending).toMatchObject({ attempts: 1, lastStatusCode: 500, lastOutcome: 'http_error' });
    const info = await shop.owner.get(`/v1/admin/webhooks/deliveries/${pending.id}`);
    expect(info.body.attemptLog[0].responseExcerpt).toContain('crash');
    expect(info.body.attemptLog[0].responseExcerpt).not.toContain('whsec_');

    const firstRequest = receiver.requests[0] as (typeof receiver.requests)[number];
    await forceDue();
    await dispatch();
    const again = receiver.requests.filter(
      (r) => r.headers['webhook-id'] === firstRequest.headers['webhook-id'],
    );
    expect(again).toHaveLength(2);
    expect(again[1]?.body).toBe(firstRequest.body);
    const done = await shop.owner.get(`/v1/admin/webhooks/deliveries/${pending.id}`);
    expect(done.body).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(done.body.attemptLog.map((a: { outcome: string }) => a.outcome)).toEqual([
      'http_error',
      'succeeded',
    ]);
  });

  it('turns an endpoint off after failing long enough, then replays what failed', async () => {
    receiver.reset();
    const since = new Date().toISOString();
    // Everything fails until the endpoint is turned off (3 failures in a row, over 0 hours here).
    receiver.answer(...Array.from({ length: 30 }, () => ({ status: 500 })));
    await customerStarts(slice, shop, 'Third question');
    await slice.drain();
    await slice.worker.get(WebhookDispatcher).drainOnce();
    for (let i = 0; i < 4; i += 1) {
      await forceDue();
      await slice.worker.get(WebhookDispatcher).drainOnce();
    }
    receiver.reset();
    const off = await shop.owner.get(`/v1/admin/webhooks/endpoints/${endpoint.id}`);
    expect(off.body).toMatchObject({ status: 'disabled', disabledReason: 'failing' });
    expect(off.body.health.consecutiveFailures).toBeGreaterThanOrEqual(3);
    const audit = await shop.owner.get('/v1/admin/audit?action=webhook.endpoint_disabled');
    expect(audit.body.items[0]).toMatchObject({
      actor: { type: 'system' },
      data: { reason: 'failing' },
    });
    const cancelled = await shop.owner.get('/v1/admin/webhooks/deliveries?status=cancelled');
    const failedOnes = await shop.owner.get('/v1/admin/webhooks/deliveries?status=failed');
    expect(cancelled.body.items.length + failedOnes.body.items.length).toBeGreaterThan(0);
    expect(
      (await shop.owner.get('/v1/admin/webhooks/deliveries?status=pending')).body.items,
    ).toEqual([]);

    // While off, nothing is queued for it.
    receiver.reset();
    await customerStarts(slice, shop, 'While the endpoint is off');
    await settle();
    expect(receiver.requests).toHaveLength(0);

    // Replaying needs the endpoint on.
    const early = await shop.owner.post(
      `/v1/admin/webhooks/endpoints/${endpoint.id}/replay-failed`,
      {
        since,
      },
    );
    expect(early.status).toBe(422);
    const on = await shop.owner.patch(`/v1/admin/webhooks/endpoints/${endpoint.id}`, {
      status: 'active',
      version: off.body.version,
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ status: 'active', health: { consecutiveFailures: 0 } });
    const stale = await shop.owner.patch(`/v1/admin/webhooks/endpoints/${endpoint.id}`, {
      status: 'disabled',
      version: off.body.version,
    });
    expect(stale.status).toBe(409);

    const replayed = await shop.owner.post(
      `/v1/admin/webhooks/endpoints/${endpoint.id}/replay-failed`,
      { since },
    );
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
    expect(replayed.body.replayed).toBeGreaterThan(0);
    expect(replayed.body.expired).toBe(0);
    await dispatch();
    const ids = receiver.requests.map((r) => r.headers['webhook-id']);
    expect(ids.length).toBe(replayed.body.replayed);
    const replays = await shop.owner.get(
      '/v1/admin/webhooks/deliveries?status=succeeded&limit=100',
    );
    const replayRows = replays.body.items.filter((d: { replayOf: string | null }) => d.replayOf);
    expect(replayRows.length).toBeGreaterThanOrEqual(replayed.body.replayed);
    // A replay repeats the event: same id as the delivery it replays.
    for (const row of replayRows.slice(0, replayed.body.replayed)) {
      expect(ids).toContain(row.eventId);
    }
  });

  it('replays one delivery on request, with the same webhook-id', async () => {
    const list = await shop.owner.get('/v1/admin/webhooks/deliveries?status=succeeded&limit=1');
    const original = list.body.items[0];
    receiver.reset();
    const replay = await shop.owner.post(`/v1/admin/webhooks/deliveries/${original.id}/replay`);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body).toMatchObject({
      status: 'pending',
      eventId: original.eventId,
      replayOf: original.replayOf ?? original.id,
    });
    await dispatch();
    expect(receiver.requests.map((r) => r.headers['webhook-id'])).toEqual([original.eventId]);
    const audit = await shop.owner.get('/v1/admin/audit?action=webhook.delivery_replayed');
    expect(audit.body.items[0].target.id).toBe(original.id);
  });

  it('turns an endpoint off at once when it answers 410 Gone', async () => {
    // Only the new endpoint receives this event: the main one is off meanwhile.
    const main = await shop.owner.get(`/v1/admin/webhooks/endpoints/${endpoint.id}`);
    const paused = await shop.owner.patch(`/v1/admin/webhooks/endpoints/${endpoint.id}`, {
      status: 'disabled',
      version: main.body.version,
    });
    expect(paused.body).toMatchObject({ status: 'disabled', disabledReason: 'manual' });
    const gone = await shop.owner.post('/v1/admin/webhooks/endpoints', {
      url: `${receiver.origin}/gone`,
      eventTypes: ['conversation.created'],
    });
    receiver.reset();
    receiver.answer({ status: 410, body: 'endpoint removed' });
    await customerStarts(slice, shop, 'Gone question');
    await settle();
    expect(receiver.requests.map((r) => r.path)).toEqual(['/gone']);
    const after = await shop.owner.get(`/v1/admin/webhooks/endpoints/${gone.body.id}`);
    expect(after.body).toMatchObject({ status: 'disabled', disabledReason: 'gone' });
    const log = await shop.owner.get(`/v1/admin/webhooks/deliveries?endpointId=${gone.body.id}`);
    expect(log.body.items[0]).toMatchObject({ status: 'failed', attempts: 1, lastStatusCode: 410 });
    await shop.owner.delete(`/v1/admin/webhooks/endpoints/${gone.body.id}`);
    const resumed = await shop.owner.patch(`/v1/admin/webhooks/endpoints/${endpoint.id}`, {
      status: 'active',
      version: paused.body.version,
    });
    expect(resumed.body.status).toBe('active');
  });
});

describe('signing secret rotation', () => {
  it('signs with both secrets during the overlap, then with the new one only', async () => {
    const before = endpoint.signingSecret;
    const rotated = await shop.owner.post(
      `/v1/admin/webhooks/endpoints/${endpoint.id}/rotate-secret`,
      {
        overlapHours: 24,
      },
    );
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    const after = rotated.body.signingSecret as string;
    expect(after).not.toBe(before);
    expect(rotated.body.endpoint.secret.previousValidUntil).not.toBeNull();
    receiver.reset();
    await shop.owner.post(`/v1/admin/webhooks/endpoints/${endpoint.id}/test`);
    const [request] = receiver.at(hookPath);
    expect(String(request?.headers['webhook-signature']).split(' ')).toHaveLength(2);
    await expect(verified(request as never, before)).resolves.toBeTruthy();
    await expect(verified(request as never, after)).resolves.toBeTruthy();

    const now = await shop.owner.post(`/v1/admin/webhooks/endpoints/${endpoint.id}/rotate-secret`, {
      overlapHours: 0,
    });
    receiver.reset();
    await shop.owner.post(`/v1/admin/webhooks/endpoints/${endpoint.id}/test`);
    const [single] = receiver.at(hookPath);
    expect(String(single?.headers['webhook-signature']).split(' ')).toHaveLength(1);
    await expect(verified(single as never, now.body.signingSecret)).resolves.toBeTruthy();
    await expect(verified(single as never, after)).rejects.toThrow();
    await expect(verified(single as never, before)).rejects.toThrow();
    endpoint.signingSecret = now.body.signingSecret;
    const audit = await shop.owner.get('/v1/admin/audit?action=webhook.secret_rotated');
    expect(JSON.stringify(audit.body)).not.toContain(now.body.signingSecret.slice(6, 30));
  });
});

describe('network safety', () => {
  it('never follows a redirect, wherever it points', async () => {
    const created = await shop.owner.post('/v1/admin/webhooks/endpoints', {
      url: `${receiver.origin}/redirect`,
      eventTypes: ['order.created'],
    });
    receiver.reset();
    receiver.answer({ status: 302, headers: { location: `${trap.origin}/stolen` } });
    const tested = await shop.owner.post(`/v1/admin/webhooks/endpoints/${created.body.id}/test`);
    expect(tested.body.attempt).toMatchObject({ outcome: 'redirect', statusCode: 302 });
    expect(trap.requests).toHaveLength(0);
    await shop.owner.delete(`/v1/admin/webhooks/endpoints/${created.body.id}`);
  });

  it('refuses a host that resolves to a private address when the request is made', async () => {
    const created = await shop.owner.post('/v1/admin/webhooks/endpoints', {
      url: 'https://hooks.partner.example/hv',
      eventTypes: ['order.created'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // DNS now answers with a private address (rebinding).
    dns['hooks.partner.example'] = ['127.0.0.1'];
    const tested = await shop.owner.post(`/v1/admin/webhooks/endpoints/${created.body.id}/test`);
    expect(tested.body.attempt).toMatchObject({ outcome: 'blocked', statusCode: null });
    expect(tested.body.attempt.error).toMatch(/private/i);
    dns['hooks.partner.example'] = ['93.184.216.34'];
  });

  it('applies the workspace allowlist to endpoints and their deliveries', async () => {
    const empty = await shop.owner.get('/v1/admin/network/egress');
    expect(empty.body).toMatchObject({ mode: 'any_public_host', hosts: [], version: 0 });
    const set = await shop.owner.put('/v1/admin/network/egress', {
      hosts: [{ pattern: 'HOOKS.Example.com', note: 'Orders' }, { pattern: '*.example.net' }],
      version: 0,
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.mode).toBe('allowlist');
    expect(set.body.hosts.map((h: { pattern: string }) => h.pattern)).toEqual([
      'hooks.example.com',
      '*.example.net',
    ]);
    // The partner endpoint is no longer allowed; the administrator's trusted receiver still is.
    expect(set.body.blockedEndpoints.map((e: { url: string }) => e.url)).toEqual([
      'https://hooks.partner.example/hv',
    ]);
    const partner = (await shop.owner.get('/v1/admin/webhooks/endpoints')).body.items.find(
      (e: { url: string }) => e.url === 'https://hooks.partner.example/hv',
    );
    expect(partner.blockedByAllowlist).toBe(true);
    const tested = await shop.owner.post(`/v1/admin/webhooks/endpoints/${partner.id}/test`);
    expect(tested.body.attempt).toMatchObject({ outcome: 'blocked' });
    const refused = await shop.owner.post('/v1/admin/webhooks/endpoints', {
      url: 'https://hooks.partner.example/other',
      eventTypes: ['order.created'],
    });
    expect(refused.status).toBe(422);
    expect(refused.body.fields[0].message).toMatch(/allowed hosts/);
    const conflict = await shop.owner.put('/v1/admin/network/egress', { hosts: [], version: 0 });
    expect(conflict.status).toBe(409);
    const invalid = await shop.owner.put('/v1/admin/network/egress', {
      hosts: [{ pattern: '10.0.0.1' }, { pattern: 'localhost' }],
      version: 1,
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.fields.map((f: { path: string }) => f.path)).toEqual([
      'hosts.0.pattern',
      'hosts.1.pattern',
    ]);
    const cleared = await shop.owner.put('/v1/admin/network/egress', { hosts: [], version: 1 });
    expect(cleared.body).toMatchObject({ mode: 'any_public_host', blockedEndpoints: [] });
    const audit = await shop.owner.get('/v1/admin/audit?action=network.egress_updated');
    expect(audit.body.items[1].data).toMatchObject({
      added: ['hooks.example.com', '*.example.net'],
      mode: 'allowlist',
    });
    await shop.owner.delete(`/v1/admin/webhooks/endpoints/${partner.id}`);
  });
});

describe('logs and access', () => {
  let reader: Client;
  let key: string;

  it('lets an API key with webhooks.read read the log, with customer text hidden', async () => {
    reader = await withTwoStep(slice.gw.app, shop.owner, 'hooks-owner@example.com');
    const created = await reader.post('/v1/admin/api-keys', {
      name: 'Monitoring',
      permissions: ['webhooks.read'],
      expiresInDays: 7,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    key = created.body.secret;
    const auth = { headers: { authorization: `Bearer ${key}` }, tenant: null };
    const deliveries = await reader.get(
      '/v1/admin/webhooks/deliveries?eventType=message.created&limit=5',
      auth,
    );
    expect(deliveries.status).toBe(200);
    expect(deliveries.body.items.length).toBeGreaterThan(0);
    const detail = await reader.get(
      `/v1/admin/webhooks/deliveries/${deliveries.body.items[0].id}`,
      auth,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.payloadPreview.type).toBe('message.created');
    expect(detail.body.replayable).toBe(true);
    // Every message preview hides what was written and who wrote it.
    const all = await reader.get(
      '/v1/admin/webhooks/deliveries?eventType=message.created&limit=50',
      auth,
    );
    const previews = await Promise.all(
      all.body.items.map(
        async (d: { id: string }) =>
          (await reader.get(`/v1/admin/webhooks/deliveries/${d.id}`, auth)).body.payloadPreview,
      ),
    );
    const customer = previews.filter((p) => p?.data.message.sender.kind === 'customer');
    expect(customer.length).toBeGreaterThan(0);
    for (const preview of previews) {
      expect(preview.data.message.parts[0].text).toBe('[redacted]');
      expect(preview.data.message.sender.displayName).toBe('[redacted]');
      expect(preview.data.message.sender.kind).toMatch(/customer|ai_agent|human_agent/);
    }
    expect(JSON.stringify(previews)).not.toMatch(/HV-1042|Second question|Third question/);
    const events = await reader.get('/v1/admin/webhooks/events?type=message.created&limit=3', auth);
    expect(events.body.items[0].deliveries.total).toBeGreaterThan(0);
    // Paging goes on from the cursor without repeats.
    const page2 = await reader.get(
      `/v1/admin/webhooks/events?type=message.created&limit=3&cursor=${events.body.nextCursor}`,
      auth,
    );
    const firstIds = events.body.items.map((e: { id: string }) => e.id);
    for (const item of page2.body.items) expect(firstIds).not.toContain(item.id);
    // Reading is all a key can do here.
    const replay = await reader.post(
      `/v1/admin/webhooks/deliveries/${deliveries.body.items[0].id}/replay`,
      {},
      auth,
    );
    expect(replay.status).toBe(401);
  });

  it('lists event types with samples that match the published schema', async () => {
    const types = await shop.owner.get('/v1/admin/webhooks/event-types');
    expect(types.body.items.map((t: { type: string }) => t.type)).toEqual(
      expect.arrayContaining([
        'conversation.created',
        'message.created',
        'refund.updated',
        'memory.deleted',
      ]),
    );
    const sample = await shop.owner.get('/v1/admin/webhooks/event-types/order.updated/sample');
    expect(sample.status, JSON.stringify(sample.body)).toBe(200);
    expect(sample.body).toMatchObject({ type: 'order.updated', tenantId: shop.tenantId });
    expect((await shop.owner.get('/v1/admin/webhooks/event-types/nope/sample')).status).toBe(404);
  });

  it('keeps other tenants away from endpoints, deliveries and replays', async () => {
    const other = await connectedTenant(slice, 'hooks-other');
    const deliveries = await shop.owner.get('/v1/admin/webhooks/deliveries?limit=1');
    const deliveryId = deliveries.body.items[0].id;
    expect((await other.owner.get(`/v1/admin/webhooks/endpoints/${endpoint.id}`)).status).toBe(404);
    expect((await other.owner.get(`/v1/admin/webhooks/deliveries/${deliveryId}`)).status).toBe(404);
    expect(
      (
        await other.owner.patch(`/v1/admin/webhooks/endpoints/${endpoint.id}`, {
          status: 'disabled',
          version: 1,
        })
      ).status,
    ).toBe(404);
    expect(
      (await other.owner.post(`/v1/admin/webhooks/deliveries/${deliveryId}/replay`)).status,
    ).toBe(404);
    expect((await other.owner.get('/v1/admin/webhooks/deliveries')).body.items).toEqual([]);
    expect((await other.owner.get('/v1/admin/webhooks/endpoints')).body.items).toEqual([]);
    // A key from the first tenant does not open the second.
    const foreign = await other.owner.get('/v1/admin/webhooks/endpoints', {
      headers: { authorization: `Bearer ${key}`, 'x-hamnivo-tenant': other.tenantId },
      tenant: null,
    });
    expect(foreign.status).toBe(404);
  });

  it('removes an endpoint with its deliveries and revokes its secrets', async () => {
    const removed = await shop.owner.delete(`/v1/admin/webhooks/endpoints/${endpoint.id}`);
    expect(removed.status).toBe(204);
    expect((await shop.owner.get(`/v1/admin/webhooks/endpoints/${endpoint.id}`)).status).toBe(404);
    const secrets = await withTenant(slice.app, { tenantId: tenantId() }, (tx) =>
      tx
        .select({ revokedAt: schema.secrets.revokedAt })
        .from(schema.secrets)
        .where(and(eq(schema.secrets.kind, 'webhook.signing_secret'))),
    );
    expect(secrets.length).toBeGreaterThan(0);
    expect(secrets.every((s) => s.revokedAt !== null)).toBe(true);
    const deliveries = await shop.owner.get(
      `/v1/admin/webhooks/deliveries?endpointId=${endpoint.id}`,
    );
    expect(deliveries.body.items).toEqual([]);
  });
});
