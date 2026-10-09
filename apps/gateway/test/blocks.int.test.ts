import { randomUUID } from 'node:crypto';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audits, join } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/**
 * Blocking visitors (H20), end to end: staff block from a chat or from Live visitors; the
 * blocked customer can no longer chat but still reads and makes privacy choices; nobody is told
 * they were blocked; lifting it works at once. No IP address is involved anywhere.
 */

type Json = Record<string, any>;

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;

beforeAll(async () => {
  slice = await startSlice();
  shop = await connectedTenant(slice, 'blocks', { publishAgent: false });
  tenantId = fromPublicId('tenant', shop.tenantId);
}, 120_000);

afterAll(async () => {
  await slice?.close();
});

async function chatting(text = 'Hello') {
  const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  await visitor.open();
  const started = await visitor.call('POST', '/v1/widget/conversations', {
    firstMessage: text,
    clientMessageId: randomUUID(),
  });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  await slice.drain();
  return { visitor, id: started.body.id as string };
}

const send = (visitor: Visitor, id: string, text: string) =>
  visitor.call('POST', `/v1/widget/conversations/${id}/messages`, {
    clientMessageId: randomUUID(),
    parts: [{ type: 'text', text }],
  });

async function visit(key: string) {
  const response = await fetch(`${slice.baseUrl}/v1/widget/visits`, {
    method: 'POST',
    headers: {
      origin: shop.hostOrigin,
      'user-agent': CHROME,
      'content-type': 'text/plain;charset=UTF-8',
    },
    body: JSON.stringify({
      widgetId: shop.brand.widgetId,
      key,
      event: 'view',
      url: `${shop.hostOrigin}/pricing`,
    }),
  });
  return (await response.json()) as Json;
}

describe('blocking from a chat (H20)', () => {
  let blocked: { visitor: Visitor; id: string };
  let blockId: string;

  it('blocks the customer, closes the chat and records who did it and why', async () => {
    blocked = await chatting('You are all useless!!!');
    const made = await shop.owner.post(`/v1/inbox/conversations/${blocked.id}/block`, {
      reason: 'Abusive messages',
      duration: 'week',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({
      id: expect.stringMatching(/^blk_/),
      brandId: shop.brand.id,
      signedIn: false,
      conversationId: blocked.id,
      reason: 'Abusive messages',
      createdBy: { name: 'blocks Owner' },
      liftedAt: null,
      active: true,
    });
    expect(made.body.name).toBeNull();
    expect(made.body.code).toMatch(/^[0-9A-F]{4}$/);
    // Blocking again, or a retry, keeps the one block.
    const twice = await shop.owner.post(`/v1/inbox/conversations/${blocked.id}/block`, {
      reason: 'Again',
      duration: 'day',
      closeChat: false,
    });
    expect(twice.status).toBe(201);
    expect(twice.body.id).toBe(made.body.id);
    const days = (Date.parse(made.body.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    blockId = made.body.id;
    const detail = await shop.owner.get(`/v1/inbox/conversations/${blocked.id}`);
    expect(detail.body.status).toBe('resolved');
    expect((await audits(slice, shop, made.body.id)).map((a) => a.action)).toEqual([
      'visitor.blocked',
    ]);
  });

  it('refuses chatting with words that never say "blocked", and leaves reading open', async () => {
    const refused = await send(blocked.visitor, blocked.id, 'Hello again');
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('CHAT_UNAVAILABLE');
    expect(JSON.stringify(refused.body)).not.toMatch(/block/i);
    // Privacy choices and the browser link stay open.
    expect(
      (
        await blocked.visitor.call('POST', '/v1/widget/visitors/link', {
          visitorKey: 'k'.repeat(32),
        })
      ).status,
    ).toBe(200);
    const again = await blocked.visitor.call('POST', '/v1/widget/conversations', {
      firstMessage: 'New chat',
      clientMessageId: randomUUID(),
    });
    expect(again.status).toBe(403);
    expect(
      (
        await blocked.visitor.call('POST', '/v1/widget/offline-messages', {
          clientRequestId: randomUUID(),
          answers: { name: 'X', email: 'x@example.com', question: 'Hi' },
        })
      ).status,
    ).toBe(403);
    // Reading and privacy choices stay open.
    expect(
      (await blocked.visitor.call('GET', `/v1/widget/conversations/${blocked.id}/messages`)).status,
    ).toBe(200);
    const refreshed = await blocked.visitor.call('POST', '/v1/widget/sessions/refresh', {
      refreshToken: blocked.visitor.refreshToken,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.config.chatAvailable).toBe(false);
    blocked.visitor.adopt(refreshed.body);
  });

  it('leaves everyone else alone', async () => {
    const other = await chatting('A normal question');
    expect((await send(other.visitor, other.id, 'Thanks')).status).toBe(202);
    const session = await new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin).open();
    expect(session.config.chatAvailable).toBe(true);
  });

  it('lists active blocks, and unblocks at once', async () => {
    const list = await shop.owner.get('/v1/visitors/blocks');
    expect(list.status).toBe(200);
    expect(list.body.items.map((b: Json) => b.id)).toEqual([blockId]);
    const lifted = await shop.owner.delete(`/v1/visitors/blocks/${blockId}`);
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);
    expect(lifted.body).toMatchObject({ active: false, liftedBy: { name: 'blocks Owner' } });
    expect((await shop.owner.get('/v1/visitors/blocks')).body.items).toEqual([]);
    const history = await shop.owner.get('/v1/visitors/blocks?status=all');
    expect(history.body.items.map((b: Json) => b.id)).toEqual([blockId]);
    // Lifting twice changes nothing.
    expect((await shop.owner.delete(`/v1/visitors/blocks/${blockId}`)).status).toBe(200);
    expect((await audits(slice, shop, blockId)).map((a) => a.action)).toEqual([
      'visitor.blocked',
      'visitor.unblocked',
    ]);
    const reopened = await blocked.visitor.call('POST', '/v1/widget/conversations', {
      firstMessage: 'Sorry about earlier.',
      clientMessageId: randomUUID(),
    });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(201);
  });

  it('ends by itself when its time is up', async () => {
    const chat = await chatting('Spam spam spam');
    const made = await shop.owner.post(`/v1/inbox/conversations/${chat.id}/block`, {
      reason: 'Spam',
      duration: 'day',
      closeChat: false,
    });
    expect(made.status).toBe(201);
    expect((await shop.owner.get(`/v1/inbox/conversations/${chat.id}`)).body.status).not.toBe(
      'resolved',
    );
    expect((await send(chat.visitor, chat.id, 'more spam')).status).toBe(403);
    await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .update(schema.visitorBlocks)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.visitorBlocks.id, fromPublicId('visitorBlock', made.body.id))),
    );
    expect((await send(chat.visitor, chat.id, 'back again')).status).toBe(202);
  });
});

describe('blocking from Live visitors (H20)', () => {
  it('stops following and inviting the browser, and blocks the chat it opens', async () => {
    const key = randomUUID().replaceAll('-', '');
    expect((await visit(key)).tracking).toBe(true);
    const live = await shop.owner.get('/v1/visitors/live');
    const visitorId = live.body.items[0]?.id as string;
    expect(visitorId).toMatch(/^vis_/);
    const made = await shop.owner.post(`/v1/visitors/${visitorId}/block`, {
      reason: 'Scraping the site',
      duration: 'always',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ visitorId, expiresAt: null, conversationId: null });
    expect(await visit(key)).toMatchObject({ tracking: false, invite: null });

    // The same browser opens the chat: it can link itself, but not chat.
    const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
    await visitor.open();
    const linked = await visitor.call('POST', '/v1/widget/visitors/link', { visitorKey: key });
    expect(linked.status).toBe(200);
    const refused = await visitor.call('POST', '/v1/widget/conversations', {
      firstMessage: 'Hi',
      clientMessageId: randomUUID(),
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('CHAT_UNAVAILABLE');
    await shop.owner.delete(`/v1/visitors/blocks/${made.body.id}`);
  });
});

describe('who may block (H20)', () => {
  it('lets supervisors block, and not support agents', async () => {
    const chat = await chatting('Hello there');
    const agent = await join(slice, shop, 'Ayaan Agent', 'agent');
    const refused = await agent.client.post(`/v1/inbox/conversations/${chat.id}/block`, {
      reason: 'Rude',
      duration: 'day',
    });
    expect(refused.status).toBe(403);
    expect((await agent.client.get('/v1/visitors/blocks')).status).toBe(403);
    const supervisor = await join(slice, shop, 'Sana Supervisor', 'supervisor');
    const made = await supervisor.client.post(`/v1/inbox/conversations/${chat.id}/block`, {
      reason: 'Rude',
      duration: 'day',
      closeChat: false,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(
      (await shop.owner.post(`/v1/inbox/conversations/${chat.id}/block`, { duration: 'day' }))
        .status,
    ).toBe(422);
    await shop.owner.delete(`/v1/visitors/blocks/${made.body.id}`);
  });
});
