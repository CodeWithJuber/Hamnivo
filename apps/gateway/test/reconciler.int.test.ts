import { randomUUID } from 'node:crypto';
import { call, createChatwootClient, provisionStaffUser } from '@hamnivo/chatwoot';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LATE_PUBLICATION_NOTE } from '../src/authority/publications.service.js';
import { ReconcilerService } from '../src/authority/reconciler.service.js';
import { AuthorityRegistry } from '../src/authority/registry.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;
let visitor: Visitor;
let agent: Awaited<ReturnType<typeof provisionStaffUser>>;

/** Starts a conversation the AI answers, with every webhook delivered. */
async function aiConversation(text: string) {
  const started = await visitor.call('POST', '/v1/widget/conversations', {
    clientMessageId: randomUUID(),
    firstMessage: text,
  });
  expect(started.status).toBe(201);
  await slice.drain();
  const id = started.body.id as string;
  return { id, control: await control(id) };
}

async function control(conversationPublicId: string) {
  const [row] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.conversationControls)
      .where(
        eq(schema.conversationControls.id, fromPublicId('conversation', conversationPublicId)),
      ),
  );
  if (!row) throw new Error('control missing');
  return row;
}

async function cursor(externalConversationId: number) {
  const [row] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.reconcileCursors)
      .where(eq(schema.reconcileCursors.scopeRef, String(externalConversationId))),
  );
  return row;
}

/** Makes this tenant's cursors due now, runs one reconciler pass and settles the worker. */
async function reconcile(changes: Partial<typeof schema.reconcileCursors.$inferInsert> = {}) {
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx.update(schema.reconcileCursors).set({ nextPollAt: new Date(Date.now() - 1000), ...changes }),
  );
  const leased = await slice.worker.get(ReconcilerService).drainOnce();
  await slice.drain();
  return leased;
}

/** Chatwoot as the Chatwoot administrator sees it, calling its API directly. */
function asAgent() {
  return createChatwootClient({ baseUrl: slice.fake.url, token: agent.token });
}

async function replyInChatwoot(externalConversationId: number, content: string) {
  await call(
    'reply',
    asAgent().POST('/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages', {
      params: {
        path: {
          account_id: shop.connection.accountId,
          conversation_id: externalConversationId,
        },
      },
      body: { content, message_type: 'outgoing' } as never,
    }) as never,
  );
}

async function journaled(conversationId: string, eventType: string) {
  return withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.conversationJournal)
      .where(
        and(
          eq(schema.conversationJournal.conversationId, conversationId),
          eq(schema.conversationJournal.eventType, eventType),
        ),
      ),
  );
}

beforeAll(async () => {
  slice = await startSlice();
  shop = await connectedTenant(slice, 'recon');
  tenantId = fromPublicId('tenant', shop.tenantId);
  visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  await visitor.open();
  agent = await provisionStaffUser({
    baseUrl: slice.fake.url,
    platformToken: slice.fake.platformToken,
    accountId: shop.connection.accountId,
    name: 'Chatwoot Agent',
    email: `cw-agent-${randomUUID()}@example.com`,
    role: 'administrator',
  });
});

afterEach(() => {
  slice.fake.setChaos({});
  slice.fake.setRequestHook(null);
});

afterAll(async () => {
  await slice?.close();
});

describe('the reconciler', () => {
  it('follows each new conversation from its first message', async () => {
    const { control: row } = await aiConversation('Is the blue scarf in stock?');
    expect(await cursor(row.externalConversationId)).toMatchObject({
      scope: 'conversation',
      lastExternalId: 0,
      intervalSeconds: 15,
    });
  });

  it('recovers a staff reply and the takeover it means when every webhook is lost', async () => {
    const { id, control: before } = await aiConversation('Can someone check my parcel?');
    const stream = visitor.stream(id);
    await stream.ready;
    slice.fake.setChaos({ drop: 1 });
    await replyInChatwoot(before.externalConversationId, 'Hello, Ayesha here. Checking now.');
    await slice.drain();
    expect((await control(id)).ownerMode).toBe('AI_ACTIVE');

    expect(await reconcile()).toBeGreaterThan(0);
    await stream.until((s) =>
      s.events.some((e) => e.data?.message?.parts?.[0]?.text?.startsWith('Hello, Ayesha')),
    );
    const staff = stream.events.find((e) =>
      e.data?.message?.parts?.[0]?.text?.startsWith('Hello, Ayesha'),
    );
    expect(staff?.data.message.sender.kind).toBe('human_agent');
    expect(await control(id)).toMatchObject({
      ownerMode: 'HUMAN_ACTIVE',
      ownerExternalUserId: agent.userId,
      ownershipEpoch: before.ownershipEpoch + 1,
    });
    stream.close();
  });

  it('applies a resolution made in Chatwoot when its webhook is lost', async () => {
    const { id, control: before } = await aiConversation('Thanks, that is all.');
    slice.fake.setChaos({ drop: 1 });
    await call(
      'resolve',
      asAgent().POST(
        '/api/v1/accounts/{account_id}/conversations/{conversation_id}/toggle_status',
        {
          params: {
            path: {
              account_id: shop.connection.accountId,
              conversation_id: before.externalConversationId,
            },
          },
          body: { status: 'resolved' } as never,
        },
      ) as never,
    );
    await slice.drain();
    expect(await journaled(before.id, 'conversation.resolved')).toHaveLength(0);
    await reconcile();
    expect(await journaled(before.id, 'conversation.resolved')).toHaveLength(1);
    expect((await control(id)).authorityStatus).toBe('resolved');
  });

  it('acts on a message once, whichever path brings it', async () => {
    const { id, control: before } = await aiConversation('Do you ship to Quetta?');
    await replyInChatwoot(before.externalConversationId, 'Yes, we ship there in four days.');
    await slice.drain();
    expect((await control(id)).ownerMode).toBe('HUMAN_ACTIVE');
    const back = await shop.owner.post(`/v1/conversations/${id}/return-to-ai`, {});
    expect(back.status).toBe(200);
    await slice.drain();
    const handedBack = await control(id);
    expect(handedBack.ownerMode).toBe('AI_ACTIVE');
    const messagesBefore = await journaled(before.id, 'message.created');

    // Replaying the whole conversation neither repeats messages nor takes it over again.
    await reconcile({ lastExternalId: 0 });
    expect(await journaled(before.id, 'message.created')).toHaveLength(messagesBefore.length);
    expect(await control(id)).toMatchObject({
      ownerMode: 'AI_ACTIVE',
      ownershipEpoch: handedBack.ownershipEpoch,
    });
  });

  it('starts conversations it did not follow from their newest message, without replaying', async () => {
    const { control: row } = await aiConversation('Hello again');
    const messagesBefore = await journaled(row.id, 'message.created');
    await reconcile({ lastExternalId: null });
    const followed = await cursor(row.externalConversationId);
    expect(followed?.lastExternalId).toBeGreaterThan(0);
    expect(await journaled(row.id, 'message.created')).toHaveLength(messagesBefore.length);
  });

  it('backs off while nothing changes and polls soon again after activity', async () => {
    const { control: row } = await aiConversation('What are your opening hours?');
    await reconcile();
    // The first pass applies the conversation's newer version (its last message) and nothing else.
    expect((await cursor(row.externalConversationId))?.intervalSeconds).toBe(30);
    await reconcile();
    expect((await cursor(row.externalConversationId))?.intervalSeconds).toBe(60);
    await reconcile();
    // An AI-handled conversation is checked at least every minute.
    expect((await cursor(row.externalConversationId))?.intervalSeconds).toBe(60);

    slice.fake.setChaos({ drop: 1 });
    await replyInChatwoot(row.externalConversationId, 'We open at ten.');
    await reconcile();
    expect((await cursor(row.externalConversationId))?.intervalSeconds).toBe(15);
  });
});

describe('late publication', () => {
  it('does not post a reply when a takeover lands during the pre-flight check', async () => {
    const { id, control: before } = await aiConversation('Can I change my delivery address?');
    const sent = await visitor.call('POST', `/v1/widget/conversations/${id}/messages`, {
      clientMessageId: randomUUID(),
      parts: [{ type: 'text', text: 'The new one is in Lahore.' }],
    });
    expect(sent.status).toBe(202);
    // Chatwoot still shows the bot (the takeover reaches it later, through the outbox).
    let tookOver = false;
    slice.fake.setRequestHook(async (method, url) => {
      const preflight = `/conversations/${before.externalConversationId}`;
      if (tookOver || method !== 'GET' || !url.endsWith(preflight)) return;
      tookOver = true;
      const takeover = await shop.owner.post(`/v1/conversations/${id}/takeover`, {});
      expect(takeover.status).toBe(200);
    });
    await slice.drain();
    expect(tookOver).toBe(true);
    const publications = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.conversationId, before.id))
        .orderBy(schema.publications.createdAt),
    );
    expect(publications.at(-1)).toMatchObject({
      state: 'aborted',
      detail: { reason: 'not_ai_owned', currentEpoch: before.ownershipEpoch + 1 },
    });
    expect(publications.some((p) => p.state === 'late_publication')).toBe(false);
  });

  it('marks an AI reply that lands after a takeover, keeps it and tells the new owner', async () => {
    const { id, control: before } = await aiConversation('Hi, I need help with a return.');
    const stream = visitor.stream(id);
    await stream.ready;
    const sent = await visitor.call('POST', `/v1/widget/conversations/${id}/messages`, {
      clientMessageId: randomUUID(),
      parts: [{ type: 'text', text: 'It is the green kurta from last week.' }],
    });
    expect(sent.status).toBe(202);

    // A person takes over while the AI's reply is already on its way to Chatwoot.
    let tookOver = false;
    slice.fake.setRequestHook(async (method, url) => {
      if (tookOver || method !== 'POST' || !url.endsWith('/messages')) return;
      tookOver = true;
      const takeover = await shop.owner.post(`/v1/conversations/${id}/takeover`, {});
      expect(takeover.status).toBe(200);
    });
    await slice.drain();
    expect(tookOver).toBe(true);

    const publications = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.conversationId, before.id)),
    );
    const late = publications.filter((p) => p.state === 'late_publication');
    expect(late).toHaveLength(1);
    expect(late[0]?.epoch).toBe(before.ownershipEpoch);

    // The reply stays visible to the customer, after the notice that a person joined.
    await stream.until((s) => s.events.some((e) => e.data?.message?.sender?.kind === 'ai_agent'));
    const kinds = stream.events.map((e) => e.data?.message?.sender?.kind ?? e.type);
    expect(kinds.indexOf('conversation.updated')).toBeLessThan(kinds.indexOf('ai_agent'));
    stream.close();

    const runtime = await slice.worker
      .get(AuthorityRegistry)
      .get(tenantId, fromPublicId('connection', shop.connection.id));
    const staffView = await runtime.authority.listMessages(String(before.externalConversationId), {
      view: 'staff',
    });
    expect(staffView.filter((m) => m.private && m.text === LATE_PUBLICATION_NOTE)).toHaveLength(1);

    const audit = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, 'conversation.late_publication')),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.data).toMatchObject({ publishedAtEpoch: before.ownershipEpoch });
  });
});
