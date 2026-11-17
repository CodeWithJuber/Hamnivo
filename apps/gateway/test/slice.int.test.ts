import { randomUUID } from 'node:crypto';
import { call, createChatwootClient, provisionStaffUser } from '@hamnivo/chatwoot';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityRegistry } from '../src/authority/registry.js';
import { connectedTenant, hookedModel, type Slice, startSlice, Visitor } from './slice-harness.js';

let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);

const hooked = hookedModel();
let slice: Slice;
let alpha: Awaited<ReturnType<typeof connectedTenant>>;
let visitor: Visitor;
let conversationId: string;

const text = (event: Record<string, any>) =>
  event.data?.message?.parts?.[0]?.text as string | undefined;

async function authorityState(
  tenantId: string,
  connectionPublicId: string,
  conversationPublicId: string,
) {
  const registry = slice.worker.get(AuthorityRegistry);
  const runtime = await registry.get(tenantId, fromPublicId('connection', connectionPublicId));
  const [control] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.conversationControls)
      .where(
        eq(schema.conversationControls.id, fromPublicId('conversation', conversationPublicId)),
      ),
  );
  if (!control) throw new Error('control missing');
  return {
    control,
    state: await runtime.authority.getState(String(control.externalConversationId)),
    messages: await runtime.authority.listMessages(String(control.externalConversationId), {
      view: 'staff',
    }),
  };
}

beforeAll(async () => {
  slice = await startSlice({ clock, model: hooked.model });
  alpha = await connectedTenant(slice, 'alpha');
  alpha.tenantId = fromPublicId('tenant', alpha.tenantId);
  visitor = new Visitor(slice.baseUrl, alpha.brand.widgetId, alpha.hostOrigin);
});

afterAll(async () => {
  await slice?.close();
});

describe('connecting a brand to Chatwoot', () => {
  it('provisions the account, stores credentials encrypted and lists the connection', async () => {
    expect(alpha.connection).toMatchObject({
      kind: 'chatwoot',
      status: 'active',
      accountId: expect.any(Number),
    });
    expect(alpha.connection.inboxes).toHaveLength(1);
    const listed = await alpha.owner.get('/v1/admin/authority/connections');
    expect(listed.body.items.map((c: { id: string }) => c.id)).toEqual([alpha.connection.id]);
    // Connecting again is idempotent per brand.
    const again = await alpha.owner.post('/v1/admin/authority/connections', {
      brandId: alpha.brand.id,
    });
    expect(again.body.id).toBe(alpha.connection.id);
    // The Chatwoot credentials are ordinary secrets: encrypted, and listing them needs MFA.
    const stored = await withTenant(slice.app, { tenantId: alpha.tenantId }, (tx) =>
      tx.select({ kind: schema.secrets.kind, hint: schema.secrets.hint }).from(schema.secrets),
    );
    expect(stored.map((s) => s.kind).sort()).toEqual([
      'chatwoot_bot_token',
      'chatwoot_inbox_hmac',
      'chatwoot_user_token',
      'webhook_signing',
      'webhook_signing',
      'webhook_signing',
    ]);
    const secrets = await alpha.owner.get('/v1/admin/secrets');
    expect(secrets.body.code).toBe('MFA_REQUIRED');
  });
});

describe('widget sessions', () => {
  it('rejects websites that are not allowed and unknown widgets', async () => {
    const foreign = new Visitor(slice.baseUrl, alpha.brand.widgetId, 'https://evil.example');
    await expect(foreign.open()).rejects.toThrow(/403/);
    const unknown = new Visitor(slice.baseUrl, 'wid_01j9zk7w3xq8r4t2v6m5n1p0cd', alpha.hostOrigin);
    await expect(unknown.open()).rejects.toThrow(/404/);
  });

  it('tells the proxy which websites may frame the widget', async () => {
    const policy = await visitor.call(
      'GET',
      `/v1/widget/frame-policy?widgetId=${alpha.brand.widgetId}`,
    );
    expect(policy.status).toBe(200);
    expect(policy.body).toEqual({
      widgetId: alpha.brand.widgetId,
      frameAncestors: [alpha.hostOrigin],
    });
    expect(policy.headers.get('x-hamnivo-frame-ancestors')).toBe(alpha.hostOrigin);
    expect(policy.headers.get('cache-control')).toBe('no-store');
    const unknown = await visitor.call(
      'GET',
      '/v1/widget/frame-policy?widgetId=wid_01j9zk7w3xq8r4t2v6m5n1p0cd',
    );
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('x-hamnivo-frame-ancestors')).toBeNull();
    expect((await visitor.call('GET', '/v1/widget/frame-policy')).status).toBe(422);
  });

  it('opens an anonymous session with the brand configuration and an AI disclosure', async () => {
    const session = await visitor.open();
    expect(session.principal).toMatchObject({ verified: false, displayName: null });
    expect(session.principal.id).toMatch(/^cus_/);
    expect(session.config.copy.en.aiDisclosure).toContain('AI assistant');
    expect(session.config.availability.humanAvailable).toBe(false);
    expect(session.conversations).toEqual([]);
    const denied = await new Visitor(slice.baseUrl, alpha.brand.widgetId, alpha.hostOrigin).call(
      'GET',
      '/v1/widget/conversations',
    );
    expect(denied.status).toBe(401);
  });
});

describe('the vertical slice: widget → Chatwoot → webhook → journal → stream', () => {
  it('starts a conversation, and the AI answers through a fenced publication', async () => {
    const started = await visitor.call('POST', '/v1/widget/conversations', {
      clientMessageId: randomUUID(),
      firstMessage: 'Assalamu alaikum, where is my order?',
    });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ status: 'open', responder: 'ai', latestSequence: 1 });
    conversationId = started.body.id;

    const stream = visitor.stream(conversationId, 0);
    await stream.until((s) => s.events.length >= 1);
    expect(stream.events[0]).toMatchObject({
      type: 'message.created',
      sequence: 1,
      lane: 'customer',
    });
    expect(stream.events[0]?.data.message.sender.kind).toBe('customer');

    await slice.drain();
    await stream.until((s) => s.events.length >= 2);
    const reply = stream.events[1] as Record<string, any>;
    expect(reply).toMatchObject({ type: 'message.created', sequence: 2 });
    expect(reply.data.message.sender).toMatchObject({
      kind: 'ai_agent',
      roleLabel: 'AI assistant',
    });
    expect(text(reply)).toMatch(/^Wa alaikum assalam! /);
    stream.close();

    const { state, messages, control } = await authorityState(
      alpha.tenantId,
      alpha.connection.id,
      conversationId,
    );
    expect(state).toMatchObject({ status: 'pending', owner: { kind: 'bot' } });
    expect(messages.map((m) => [m.direction, m.key?.slice(0, 6)])).toEqual([
      ['incoming', 'hv1:m:'],
      ['outgoing', 'hv1:p:'],
    ]);
    // Webhooks from all three sources arrived and were stored once; nothing was journaled twice.
    expect(control.journalSeq).toBe(2);
    const publications = await withTenant(slice.app, { tenantId: alpha.tenantId }, (tx) =>
      tx
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.conversationId, control.id)),
    );
    expect(publications.map((p) => p.state)).toEqual(['sent']);
  });

  it('deduplicates retried sends and rejects a reused id with a different message', async () => {
    const clientMessageId = randomUUID();
    const body = { clientMessageId, parts: [{ type: 'text', text: 'Order #1042' }] };
    const first = await visitor.call(
      'POST',
      `/v1/widget/conversations/${conversationId}/messages`,
      body,
    );
    expect(first.status).toBe(202);
    expect(first.body.status).toBe('accepted');
    const retry = await visitor.call(
      'POST',
      `/v1/widget/conversations/${conversationId}/messages`,
      body,
    );
    expect(retry.status).toBe(202);
    expect(retry.body).toMatchObject({
      status: 'duplicate',
      message: { id: first.body.message.id, clientMessageId },
    });
    const conflict = await visitor.call(
      'POST',
      `/v1/widget/conversations/${conversationId}/messages`,
      {
        clientMessageId,
        parts: [{ type: 'text', text: 'something else' }],
      },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    await slice.drain();
    const { messages } = await authorityState(alpha.tenantId, alpha.connection.id, conversationId);
    expect(messages.filter((m) => m.text === 'Order #1042')).toHaveLength(1);
  });

  it('resumes a stream after a disconnect without gaps or duplicates', async () => {
    const resumed = visitor.stream(conversationId, 2);
    await resumed.until((s) => s.events.length >= 2);
    expect(resumed.events.map((e) => e.sequence)).toEqual([3, 4]);
    expect(text(resumed.events[0] as Record<string, any>)).toBe('Order #1042');
    resumed.close();

    const history = await visitor.call(
      'GET',
      `/v1/widget/conversations/${conversationId}/messages?limit=10`,
    );
    expect(history.status).toBe(200);
    expect(history.body.latestSequence).toBe(4);
    expect(history.body.items.map((m: any) => m.sender.kind)).toEqual([
      'ai_agent',
      'customer',
      'ai_agent',
      'customer',
    ]);
  });

  it('asks the AI once when a timed-out send is confirmed by the webhook, and the retry is a duplicate', async () => {
    const started = await visitor.call('POST', '/v1/widget/conversations', {});
    const id = started.body.id as string;
    // Chatwoot stores the message and sends its webhooks, but the response never arrives.
    slice.fake.setResponseFault((method, url) =>
      method === 'POST' && url.endsWith('/messages') ? 504 : null,
    );
    const body = {
      clientMessageId: randomUUID(),
      parts: [{ type: 'text', text: 'Did my payment go through?' }],
    };
    const first = await visitor.call('POST', `/v1/widget/conversations/${id}/messages`, body);
    slice.fake.setResponseFault(null);
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ code: 'AUTHORITY_UNAVAILABLE', retryable: true });

    // The webhook confirms the message, and that confirmation asks the AI for its reply.
    await slice.drain();
    let { messages } = await authorityState(alpha.tenantId, alpha.connection.id, id);
    expect(messages.filter((m) => m.text === 'Did my payment go through?')).toHaveLength(1);
    expect(messages.at(-1)?.sender.kind).toBe('bot');

    const retry = await visitor.call('POST', `/v1/widget/conversations/${id}/messages`, body);
    expect(retry.status).toBe(202);
    expect(retry.body).toMatchObject({
      status: 'duplicate',
      message: { clientMessageId: body.clientMessageId },
    });
    await slice.drain();
    ({ messages } = await authorityState(alpha.tenantId, alpha.connection.id, id));
    expect(messages.filter((m) => m.text === 'Did my payment go through?')).toHaveLength(1);
    expect(messages.filter((m) => m.sender.kind === 'bot')).toHaveLength(1);
  });

  it('lets staff take over; a reply already in flight is fenced out and never published', async () => {
    const stream = visitor.stream(conversationId);
    await stream.ready;
    const sent = await visitor.call('POST', `/v1/widget/conversations/${conversationId}/messages`, {
      clientMessageId: randomUUID(),
      parts: [{ type: 'text', text: 'Can a person check it?' }],
    });
    expect(sent.status).toBe(202);
    // The AI reply job is queued, but a person takes over before it runs.
    const takeover = await alpha.owner.post(`/v1/conversations/${conversationId}/takeover`, {});
    expect(takeover.status).toBe(200);
    expect(takeover.body).toMatchObject({
      ownerMode: 'HUMAN_ACTIVE',
      ownershipEpoch: 1,
      owner: { kind: 'staff' },
    });
    await stream.until((s) => s.events.some((e) => e.type === 'conversation.updated'));
    expect(stream.events.find((e) => e.type === 'conversation.updated')?.data).toEqual({
      status: 'with_person',
      responder: 'person',
    });

    await slice.drain();
    const { state, messages, control } = await authorityState(
      alpha.tenantId,
      alpha.connection.id,
      conversationId,
    );
    expect(state.owner.kind).toBe('user');
    expect(state.status).toBe('open');
    expect(control.ownerSyncedEpoch).toBe(1);
    expect(messages.at(-1)?.text).toBe('Can a person check it?');
    const publications = await withTenant(slice.app, { tenantId: alpha.tenantId }, (tx) =>
      tx
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.conversationId, control.id)),
    );
    expect(publications.filter((p) => p.state === 'sent')).toHaveLength(2);
    expect(publications.some((p) => p.state === 'aborted')).toBe(false);
    stream.close();
  });

  it('delivers the staff reply as a person and keeps internal notes out of the customer lane', async () => {
    const stream = visitor.stream(conversationId);
    await stream.ready;
    const reply = await alpha.owner.post(`/v1/conversations/${conversationId}/messages`, {
      clientMessageId: randomUUID(),
      text: 'Wa alaikum assalam, I am checking your order now.',
    });
    expect(reply.status).toBe(202);
    const note = await alpha.owner.post(`/v1/conversations/${conversationId}/messages`, {
      clientMessageId: randomUUID(),
      text: 'Internal: courier delayed',
      visibility: 'internal',
    });
    expect(note.status).toBe(202);
    await slice.drain();
    await stream.until((s) =>
      s.events.some((e) => e.data?.message?.sender?.kind === 'human_agent'),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const human = stream.events.find((e) => e.data?.message?.sender?.kind === 'human_agent');
    // A person, by first name only: the customer never sees a teammate's full name.
    expect(human?.data.message.sender).toMatchObject({
      displayName: 'alpha',
      roleLabel: 'Support agent',
    });
    expect(JSON.stringify(stream.messages)).not.toContain('alpha Owner');
    expect(JSON.stringify(stream.messages)).not.toContain('courier delayed');
    const history = await visitor.call(
      'GET',
      `/v1/widget/conversations/${conversationId}/messages?limit=20`,
    );
    expect(JSON.stringify(history.body)).not.toContain('courier delayed');
    const { messages } = await authorityState(alpha.tenantId, alpha.connection.id, conversationId);
    expect(messages.find((m) => m.text === 'Internal: courier delayed')?.private).toBe(true);
    stream.close();
  });

  it('does not wake the AI while a person owns the conversation, and hands back on request', async () => {
    await visitor.call('POST', `/v1/widget/conversations/${conversationId}/messages`, {
      clientMessageId: randomUUID(),
      parts: [{ type: 'text', text: 'Thank you!' }],
    });
    await slice.drain();
    let { messages } = await authorityState(alpha.tenantId, alpha.connection.id, conversationId);
    expect(messages.at(-1)?.text).toBe('Thank you!');

    const back = await alpha.owner.post(`/v1/conversations/${conversationId}/return-to-ai`, {
      expectedEpoch: 1,
    });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ ownerMode: 'AI_ACTIVE', ownershipEpoch: 2 });
    const stale = await alpha.owner.post(`/v1/conversations/${conversationId}/takeover`, {
      expectedEpoch: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('OWNERSHIP_CHANGED');
    await slice.drain();
    const after = await authorityState(alpha.tenantId, alpha.connection.id, conversationId);
    expect(after.state).toMatchObject({ status: 'pending', owner: { kind: 'bot' } });
    messages = after.messages;
    await visitor.call('POST', `/v1/widget/conversations/${conversationId}/messages`, {
      clientMessageId: randomUUID(),
      parts: [{ type: 'text', text: 'One more question' }],
    });
    await slice.drain();
    ({ messages } = await authorityState(alpha.tenantId, alpha.connection.id, conversationId));
    expect(messages.at(-1)?.sender.kind).toBe('bot');
  });

  it('honours "talk to a person": waiting for a person, bot handoff and a private handoff note', async () => {
    const started = await visitor.call('POST', '/v1/widget/conversations', {});
    const id = started.body.id as string;
    const handoff = await visitor.call('POST', `/v1/widget/conversations/${id}/handoff`, {
      clientRequestId: randomUUID(),
      note: 'refund please',
    });
    expect(handoff.status).toBe(200);
    expect(handoff.body).toMatchObject({ availability: 'queued', followUp: null });
    expect(handoff.body.handoffId).toMatch(/^hnd_/);
    const view = await visitor.call('GET', `/v1/widget/conversations/${id}`);
    expect(view.body).toMatchObject({ status: 'waiting_for_person', responder: 'none' });
    await slice.drain();
    const { state, messages } = await authorityState(alpha.tenantId, alpha.connection.id, id);
    expect(state).toMatchObject({ status: 'open', owner: { kind: 'none' } });
    expect(messages.find((m) => m.private)?.text).toContain('refund please');
    const history = await visitor.call('GET', `/v1/widget/conversations/${id}/messages?limit=10`);
    expect(JSON.stringify(history.body)).not.toContain('refund please');
  });
});

describe('fencing when ownership changes while the AI is still writing', () => {
  it('discards the reply at reservation when staff take over through Hamnivo mid-generation', async () => {
    const started = await visitor.call('POST', '/v1/widget/conversations', {
      clientMessageId: randomUUID(),
      firstMessage: 'Is my parcel lost?',
    });
    const id = started.body.id as string;
    hooked.state.during = async () => {
      const takeover = await alpha.owner.post(`/v1/conversations/${id}/takeover`, {});
      expect(takeover.status).toBe(200);
    };
    await slice.drain();
    const { state, messages, control } = await authorityState(
      alpha.tenantId,
      alpha.connection.id,
      id,
    );
    expect(messages.map((m) => m.direction)).toEqual(['incoming']);
    expect(state.owner.kind).toBe('user');
    const publications = await withTenant(slice.app, { tenantId: alpha.tenantId }, (tx) =>
      tx
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.conversationId, control.id)),
    );
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({
      state: 'aborted',
      epoch: 0,
      detail: { reason: 'not_ai_owned' },
    });
  });

  it('aborts at the pre-flight check when someone takes over inside Chatwoot, then adopts that owner', async () => {
    const started = await visitor.call('POST', '/v1/widget/conversations', {
      clientMessageId: randomUUID(),
      firstMessage: 'Where is my refund?',
    });
    const id = started.body.id as string;
    const agent = await provisionStaffUser({
      baseUrl: slice.fake.url,
      platformToken: slice.fake.platformToken,
      accountId: alpha.connection.accountId,
      name: 'Chatwoot Admin',
      email: `cw-admin-${randomUUID()}@example.com`,
      role: 'administrator',
    });
    const { control: before } = await authorityState(alpha.tenantId, alpha.connection.id, id);
    hooked.state.during = async () => {
      // Assign the conversation to a person directly in Chatwoot (no webhook processed yet).
      const client = createChatwootClient({ baseUrl: slice.fake.url, token: agent.token });
      slice.fake.pauseDeliveries();
      await call(
        'assign',
        client.POST('/api/v1/accounts/{account_id}/conversations/{conversation_id}/assignments', {
          params: {
            path: {
              account_id: alpha.connection.accountId,
              conversation_id: before.externalConversationId,
            },
          },
          body: { assignee_id: agent.userId } as never,
        }) as never,
      );
    };
    const relay = slice.drain();
    await relay.catch(() => undefined);
    let publications = await withTenant(slice.app, { tenantId: alpha.tenantId }, (tx) =>
      tx
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.conversationId, before.id)),
    );
    expect(publications[0]).toMatchObject({
      state: 'aborted',
      detail: { reason: 'preflight_owner_mismatch' },
    });
    // Once the webhooks arrive, Hamnivo adopts the person Chatwoot assigned.
    slice.fake.resumeDeliveries();
    await slice.drain();
    const { control, messages } = await authorityState(alpha.tenantId, alpha.connection.id, id);
    expect(control).toMatchObject({
      ownerMode: 'HUMAN_ACTIVE',
      ownerExternalUserId: agent.userId,
      ownershipEpoch: 1,
    });
    expect(messages.filter((m) => m.direction === 'outgoing')).toHaveLength(0);
    publications = await withTenant(slice.app, { tenantId: alpha.tenantId }, (tx) =>
      tx
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.conversationId, before.id)),
    );
    expect(publications.map((p) => p.state)).toEqual(['aborted']);
    const view = await visitor.call('GET', `/v1/widget/conversations/${id}`);
    expect(view.body).toMatchObject({ status: 'with_person', responder: 'person' });
  });
});

describe('identity, sessions and tenant isolation', () => {
  it('switches identity to a new principal, ends the old session and its stream, and rejects replays', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const kid = `k-${randomUUID().slice(0, 8)}`;
    await withTenant(slice.app, { tenantId: alpha.tenantId }, (tx) =>
      exportJWK(publicKey).then((jwk) =>
        tx.insert(schema.brandIdentityKeys).values({
          tenantId: alpha.tenantId,
          brandId: fromPublicId('brand', alpha.brand.id),
          kid,
          alg: 'ES256',
          publicJwk: jwk,
        }),
      ),
    );
    const assertion = await new SignJWT({
      name: 'Ayesha Khan',
      email: 'ayesha@example.com',
      email_verified: true,
    })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setSubject('customer-42')
      .setAudience(alpha.brand.widgetId)
      .setIssuedAt()
      .setExpirationTime('2m')
      .setJti(randomUUID())
      .sign(privateKey);

    const anonymousToken = visitor.accessToken;
    const stream = visitor.stream(conversationId);
    await stream.ready;
    const identified = await visitor.call('POST', '/v1/widget/identity', { assertion });
    expect(identified.status).toBe(200);
    expect(identified.body.principal).toMatchObject({ verified: true, displayName: 'Ayesha Khan' });
    expect(identified.body.principal.id).not.toBe(visitor.principalId);
    // A different identity is a different principal: the anonymous conversations are not merged.
    expect(identified.body.conversations).toEqual([]);

    await stream.until(
      (s) => s.ended && s.controls.some((c) => c.control === 'auth_expired'),
      5000,
    );
    const old = await visitor.call('GET', '/v1/widget/conversations', undefined, {
      authorization: `Bearer ${anonymousToken}`,
    });
    expect(old.status).toBe(401);
    expect(old.body.code).toBe('SESSION_EXPIRED');

    visitor.adopt(identified.body);
    const replay = await visitor.call('POST', '/v1/widget/identity', { assertion });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('ASSERTION_INVALID');
    const forbidden = await visitor.call('GET', `/v1/widget/conversations/${conversationId}`);
    expect(forbidden.status).toBe(404);
  });

  it('rotates refresh tokens, tolerates a concurrent tab and revokes the session when an old token is reused', async () => {
    const first = visitor.refreshToken;
    const rotated = await visitor.call('POST', '/v1/widget/sessions/refresh', {
      refreshToken: first,
    });
    expect(rotated.status).toBe(200);
    // A second tab refreshing with the same token within the grace window still works.
    const tab = await visitor.call('POST', '/v1/widget/sessions/refresh', { refreshToken: first });
    expect(tab.status).toBe(200);
    offsetMs += 60_000;
    const reused = await visitor.call('POST', '/v1/widget/sessions/refresh', {
      refreshToken: first,
    });
    expect(reused.status).toBe(401);
    // Theft detection revoked the whole session: the newest token no longer works either.
    const latest = await visitor.call('POST', '/v1/widget/sessions/refresh', {
      refreshToken: tab.body.refreshToken,
    });
    expect(latest.status).toBe(401);
    offsetMs = 0;
  });

  it('keeps tenants apart on the widget API, the staff API and webhooks', async () => {
    const beta = await connectedTenant(slice, 'beta');
    const betaVisitor = new Visitor(slice.baseUrl, beta.brand.widgetId, beta.hostOrigin);
    await betaVisitor.open();
    const crossWidget = await betaVisitor.call('GET', `/v1/widget/conversations/${conversationId}`);
    expect(crossWidget.status).toBe(404);
    const crossSend = await betaVisitor.call(
      'POST',
      `/v1/widget/conversations/${conversationId}/messages`,
      {
        clientMessageId: randomUUID(),
        parts: [{ type: 'text', text: 'hi' }],
      },
    );
    expect(crossSend.status).toBe(404);
    const crossStaff = await beta.owner.post(`/v1/conversations/${conversationId}/takeover`, {});
    expect(crossStaff.status).toBe(404);
    // Another tenant's widget cannot be embedded on this tenant's website.
    const wrongSite = new Visitor(slice.baseUrl, beta.brand.widgetId, alpha.hostOrigin);
    await expect(wrongSite.open()).rejects.toThrow(/403/);
  });

  it('accepts only correctly signed webhooks for a known connection', async () => {
    const url = `${slice.baseUrl}/v1/integrations/chatwoot/${alpha.connection.id}/account`;
    const body = JSON.stringify({
      event: 'conversation_updated',
      id: 1,
      account: { id: alpha.connection.accountId },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const unsigned = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(unsigned.status).toBe(401);
    const forged = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-chatwoot-timestamp': ts,
        'x-chatwoot-signature': `sha256=${'0'.repeat(64)}`,
      },
      body,
    });
    expect(forged.status).toBe(401);
    const unknown = await fetch(
      `${slice.baseUrl}/v1/integrations/chatwoot/acn_01j9zk7w3xq8r4t2v6m5n1p0cd/account`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      },
    );
    expect(unknown.status).toBe(404);
    const stored = await withTenant(slice.app, { tenantId: alpha.tenantId }, (tx) =>
      tx
        .select({
          source: schema.integrationInbox.source,
          payload: schema.integrationInbox.payload,
        })
        .from(schema.integrationInbox),
    );
    // Deliveries from all three sources were verified and accepted (each with its own secret)…
    const accepted = slice.fake.deliveries.filter((d) => d.outcome === 'delivered');
    expect(new Set(accepted.map((d) => d.source))).toEqual(new Set(['account', 'inbox', 'bot']));
    // …but each change was stored once, whichever copy arrived first.
    expect(stored.length).toBeLessThan(accepted.length);
    expect(stored.length).toBeGreaterThan(0);
    // Contact-inbox source ids grant customer-API access and are never stored.
    expect(JSON.stringify(stored)).not.toMatch(/"contact_inbox":\{[^}]*"source_id"/);
  });
});
