import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { AuthorityRegistry } from '../src/authority/registry.js';
import type { Client } from './harness.js';
import { customerStarts, join, type Shop, StaffStream } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice } from './slice-harness.js';

let slice: Slice;
let desk: Shop;
/** A second brand of the same tenant, with its own chat account. */
let outlet: Shop;
/** A brand that has not been connected to the chat service. */
let unconnected: { id: string };
let rayan: { client: Client; staffId: string };
let omar: { client: Client; staffId: string };
let amina: { client: Client; staffId: string };
let ana: { client: Client; staffId: string };
/** A customer's conversation on the first brand. */
let chat: string;

const library = (shop: { brand: { id: string } }, rest: string) =>
  `/v1/admin/brands/${shop.brand.id}${rest}`;
const inbox = (id: string, rest = '') => `/v1/inbox/conversations/${id}${rest}`;

beforeAll(async () => {
  slice = await startSlice();
  desk = await connectedTenant(slice, 'desk');
  const brand = await desk.owner.post('/v1/admin/brands', {
    workspaceId: desk.workspaceId,
    name: 'desk Outlet',
    allowedOrigins: ['https://outlet.example'],
  });
  const connection = await desk.owner.post('/v1/admin/authority/connections', {
    brandId: brand.body.id,
  });
  outlet = {
    ...desk,
    brand: brand.body,
    connection: connection.body,
    hostOrigin: 'https://outlet.example',
  };
  const bare = await desk.owner.post('/v1/admin/brands', {
    workspaceId: desk.workspaceId,
    name: 'desk Bare',
    allowedOrigins: ['https://bare.example'],
  });
  unconnected = bare.body;
  // Rayan manages inboxes everywhere, Omar only on the outlet; Amina answers customers and Ana
  // reads, but neither manages inboxes.
  rayan = await join(slice, desk, 'Rayan Lead', 'supervisor');
  omar = await join(slice, desk, 'Omar Outlet', 'supervisor', { type: 'brand', id: brand.body.id });
  amina = await join(slice, desk, 'Amina Agent', 'agent');
  ana = await join(slice, desk, 'Ana Analyst', 'analyst');
  ({ conversationId: chat } = await customerStarts(slice, desk, 'Where is my order?'));
  await slice.drain();
});

afterAll(async () => {
  await slice?.close();
});

async function runtimeOf(shop: Shop) {
  return slice.worker
    .get(AuthorityRegistry)
    .get(fromPublicId('tenant', shop.tenantId), fromPublicId('connection', shop.connection.id));
}

/** The conversations Rayan finds in the queue with this tag. */
async function filtered(label: string): Promise<string[]> {
  const list = await rayan.client.get(`/v1/inbox/conversations?queue=all&label=${label}`);
  return list.body.items.map((item: { id: string }) => item.id);
}

/** The chat account's own number for a conversation. */
async function chatwootRef(conversationId: string): Promise<string> {
  const [control] = await withTenant(
    slice.app,
    { tenantId: fromPublicId('tenant', desk.tenantId) },
    (tx) =>
      tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, fromPublicId('conversation', conversationId))),
  );
  return String(control?.externalConversationId);
}

/** Audit events of one brand's library, oldest first. */
async function libraryAudits(shop: { brand: { id: string } }) {
  return withTenant(slice.app, { tenantId: fromPublicId('tenant', desk.tenantId) }, (tx) =>
    tx
      .select({ action: schema.auditEvents.action, data: schema.auditEvents.data })
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.targetId, shop.brand.id),
          eq(schema.auditEvents.targetType, 'brand'),
        ),
      )
      .orderBy(schema.auditEvents.seq),
  ).then((rows) => rows.filter((row) => row.action.startsWith('inbox.')));
}

const titles = (body: { items: { title: string }[] }) => body.items.map((t) => t.title);
const codes = (body: { items: { shortCode: string }[] }) => body.items.map((r) => r.shortCode);

describe('who may change saved replies and tags', () => {
  it('is for people who manage inboxes, brand by brand', async () => {
    for (const person of [amina, ana]) {
      for (const [method, path, body] of [
        ['GET', '/saved-replies', undefined],
        ['GET', '/tags', undefined],
        ['POST', '/saved-replies', { shortCode: 'x', content: 'x' }],
        ['POST', '/tags', { title: 'x' }],
        ['PATCH', '/tags/x', { color: '#112233' }],
        ['DELETE', '/tags/x', undefined],
      ] as const) {
        const denied = await person.client.request(method, library(desk, path), { body });
        expect(denied.status, `${method} ${path}`).toBe(403);
      }
    }
    expect((await rayan.client.get(library(desk, '/tags'))).status).toBe(200);
    expect((await rayan.client.get(library(outlet, '/saved-replies'))).status).toBe(200);
    // Omar manages the outlet, so the first brand's saved replies and tags are closed to him.
    expect((await omar.client.get(library(outlet, '/tags'))).status).toBe(200);
    expect((await omar.client.get(library(desk, '/tags'))).status).toBe(403);
    expect((await omar.client.post(library(desk, '/tags'), { title: 'sneaky' })).status).toBe(403);
    expect((await omar.client.get(library(desk, '/saved-replies'))).status).toBe(403);
    // Brands of other companies do not exist for anyone here.
    const other = await connectedTenant(slice, 'other');
    expect((await other.owner.get(library(desk, '/tags'))).status).toBe(404);
    expect((await desk.owner.get('/v1/admin/brands/brd_nonsense/tags')).status).toBe(404);
  });

  it('says so plainly when the brand has no chat account yet', async () => {
    const tags = await desk.owner.get(library({ brand: unconnected }, '/tags'));
    expect(tags.status, JSON.stringify(tags.body)).toBe(422);
    expect(JSON.stringify(tags.body)).toContain('Chat is not set up for this brand yet');
    expect(JSON.stringify(tags.body)).toContain('no_chat_account');
    const replies = await desk.owner.post(library({ brand: unconnected }, '/saved-replies'), {
      shortCode: 'hello',
      content: 'Hi',
    });
    expect(replies.status).toBe(422);
  });
});

describe('saved replies', () => {
  it('adds, changes and deletes them in the chat account, once per short code', async () => {
    expect((await rayan.client.get(library(desk, '/saved-replies'))).body.items).toEqual([]);

    const welcome = await rayan.client.post(library(desk, '/saved-replies'), {
      shortCode: 'welcome',
      content: 'Hi {{contact.first_name}}, how can I help?',
    });
    expect(welcome.status, JSON.stringify(welcome.body)).toBe(201);
    expect(welcome.body).toMatchObject({
      shortCode: 'welcome',
      content: 'Hi {{contact.first_name}}, how can I help?',
    });
    expect(welcome.body.id).toMatch(/^srp_/);
    const hours = await rayan.client.post(library(desk, '/saved-replies'), {
      shortCode: 'hours',
      content: 'We are open 9 to 5.',
    });
    expect(hours.status).toBe(201);

    // Listed by short code, and in Chatwoot, where the composer reads them too.
    const listed = await rayan.client.get(library(desk, '/saved-replies'));
    expect(codes(listed.body)).toEqual(['hours', 'welcome']);
    const cw = await runtimeOf(desk);
    expect(
      (await cw.authority.listSavedReplies(undefined, { kind: 'integration' })).map(
        (r) => r.shortCode,
      ),
    ).toEqual(expect.arrayContaining(['hours', 'welcome']));

    // A short code is used once, whatever its case; its form is checked.
    const again = await rayan.client.post(library(desk, '/saved-replies'), {
      shortCode: 'Welcome',
      content: 'Again',
    });
    expect(again.status).toBe(422);
    expect(JSON.stringify(again.body)).toContain(
      'Another saved reply already uses this short code.',
    );
    const spaced = await rayan.client.post(library(desk, '/saved-replies'), {
      shortCode: 'two words',
      content: 'x',
    });
    expect(spaced.status).toBe(422);
    const empty = await rayan.client.post(library(desk, '/saved-replies'), {
      shortCode: 'blank',
      content: '   ',
    });
    expect(empty.status).toBe(422);

    // Changing the text keeps the short code, and the other way round.
    const reworded = await rayan.client.patch(library(desk, `/saved-replies/${welcome.body.id}`), {
      content: 'Hello {{contact.first_name}}! What can I do for you?',
    });
    expect(reworded.status, JSON.stringify(reworded.body)).toBe(200);
    expect(reworded.body).toEqual({
      id: welcome.body.id,
      shortCode: 'welcome',
      content: 'Hello {{contact.first_name}}! What can I do for you?',
    });
    const renamed = await rayan.client.patch(library(desk, `/saved-replies/${welcome.body.id}`), {
      shortCode: 'hello',
    });
    expect(renamed.body).toMatchObject({
      id: welcome.body.id,
      shortCode: 'hello',
      content: 'Hello {{contact.first_name}}! What can I do for you?',
    });
    const clash = await rayan.client.patch(library(desk, `/saved-replies/${welcome.body.id}`), {
      shortCode: 'HOURS',
    });
    expect(clash.status).toBe(422);
    expect(
      (await rayan.client.patch(library(desk, `/saved-replies/${welcome.body.id}`), {})).status,
    ).toBe(422);
    // Saving a reply under the short code it already has is not a clash.
    expect(
      (
        await rayan.client.patch(library(desk, `/saved-replies/${welcome.body.id}`), {
          shortCode: 'hello',
          content: 'Hello again',
        })
      ).status,
    ).toBe(200);

    // The composer in the inbox finds the changed reply under the same id.
    const composer = await rayan.client.get(inbox(chat, '/saved-replies?q=hello'));
    expect(composer.status, JSON.stringify(composer.body)).toBe(200);
    expect(composer.body.items).toEqual([
      expect.objectContaining({ id: welcome.body.id, shortCode: 'hello', content: 'Hello again' }),
    ]);

    // Deleting removes it for everyone; deleting it again, or a stranger's id, finds nothing.
    const removed = await rayan.client.delete(library(desk, `/saved-replies/${welcome.body.id}`));
    expect(removed.status).toBe(204);
    expect(codes((await rayan.client.get(library(desk, '/saved-replies'))).body)).toEqual([
      'hours',
    ]);
    expect(
      (await rayan.client.delete(library(desk, `/saved-replies/${welcome.body.id}`))).status,
    ).toBe(404);
    expect(
      (await rayan.client.patch(library(desk, '/saved-replies/srp_unknown'), { content: 'x' }))
        .status,
    ).toBe(404);
    expect(
      (
        await rayan.client.patch(library(outlet, `/saved-replies/${hours.body.id}`), {
          content: 'x',
        })
      ).status,
    ).toBe(404);
    // The outlet's chat account is its own.
    expect((await rayan.client.get(library(outlet, '/saved-replies'))).body.items).toEqual([]);

    // Who changed what is recorded, without the text of the replies.
    const events = (await libraryAudits(desk)).filter((e) =>
      e.action.startsWith('inbox.saved_reply'),
    );
    expect(events.map((e) => e.action)).toEqual([
      'inbox.saved_reply_created',
      'inbox.saved_reply_created',
      'inbox.saved_reply_updated',
      'inbox.saved_reply_updated',
      'inbox.saved_reply_updated',
      'inbox.saved_reply_deleted',
    ]);
    expect(events[3]?.data).toMatchObject({ shortCode: 'hello', was: 'welcome' });
    expect(JSON.stringify(events)).not.toContain('What can I do for you');
  });
});

describe('tags', () => {
  it('adds tags in lower case, once each, with a colour and a description', async () => {
    const vip = await rayan.client.post(library(desk, '/tags'), {
      title: 'VIP',
      description: 'Top customers',
      color: '#ff8800',
    });
    expect(vip.status, JSON.stringify(vip.body)).toBe(201);
    expect(vip.body).toEqual({ title: 'vip', description: 'Top customers', color: '#ff8800' });
    expect((await rayan.client.post(library(desk, '/tags'), { title: 'refund' })).status).toBe(201);

    expect(titles((await rayan.client.get(library(desk, '/tags'))).body)).toEqual([
      'refund',
      'vip',
    ]);
    // The chat account has them, so the tag picker in a conversation offers them.
    const options = await rayan.client.get(inbox(chat, '/tags'));
    expect(titles({ items: options.body.options }).sort()).toEqual(['refund', 'vip']);

    const same = await rayan.client.post(library(desk, '/tags'), { title: 'Vip' });
    expect(same.status).toBe(422);
    expect(JSON.stringify(same.body)).toContain('A tag with this name already exists.');
    // Chatwoot's rule: two characters or more, starting with a letter or number, no spaces.
    for (const title of ['two words', '', 'x', '-dash', '_under', 'a'.repeat(51)]) {
      expect((await rayan.client.post(library(desk, '/tags'), { title })).status, title).toBe(422);
    }
    expect(
      (await rayan.client.post(library(desk, '/tags'), { title: 'bad', color: 'orange' })).status,
    ).toBe(422);
    // The outlet has its own list.
    expect((await rayan.client.get(library(outlet, '/tags'))).body.items).toEqual([]);
  });

  it('changes the description and colour, and refuses an empty change or an unknown tag', async () => {
    const changed = await rayan.client.patch(library(desk, '/tags/refund'), {
      description: 'Money back',
      color: '#00aa55',
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toEqual({ title: 'refund', description: 'Money back', color: '#00aa55' });
    const cleared = await rayan.client.patch(library(desk, '/tags/refund'), { description: null });
    expect(cleared.body).toEqual({ title: 'refund', description: null, color: '#00aa55' });
    expect((await rayan.client.patch(library(desk, '/tags/refund'), {})).status).toBe(422);
    expect(
      (await rayan.client.patch(library(desk, '/tags/nothing'), { color: '#112233' })).status,
    ).toBe(404);
    expect(
      (await rayan.client.patch(library(desk, '/tags/REFUND'), { color: '#112233' })).status,
    ).toBe(200);
    expect((await rayan.client.delete(library(desk, '/tags/nothing'))).status).toBe(404);
  });

  it('follows a rename onto the conversations, in the queue and in the chat account', async () => {
    const tagged = await rayan.client.put(inbox(chat, '/tags'), { labels: ['vip', 'refund'] });
    expect(tagged.status, JSON.stringify(tagged.body)).toBe(200);
    const stream = new StaffStream(slice.baseUrl, rayan.client);
    onTestFinished(() => stream.close());
    await stream.ready;
    expect(await filtered('vip')).toEqual([chat]);

    // A name that is taken, or not allowed, changes nothing.
    expect((await rayan.client.patch(library(desk, '/tags/vip'), { title: 'refund' })).status).toBe(
      422,
    );
    expect((await rayan.client.patch(library(desk, '/tags/vip'), { title: 'a b' })).status).toBe(
      422,
    );

    const renamed = await rayan.client.patch(library(desk, '/tags/vip'), { title: 'Gold' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body).toMatchObject({ title: 'gold', description: 'Top customers' });
    expect(await filtered('vip')).toEqual([]);
    expect(await filtered('gold')).toEqual([chat]);
    // The place of the tag among the conversation's tags is kept.
    const row = (await rayan.client.get(inbox(chat))).body;
    expect(row.labels).toEqual(['gold', 'refund']);
    const cw = await runtimeOf(desk);
    expect((await cw.authority.getState(await chatwootRef(chat))).labels).toEqual([
      'gold',
      'refund',
    ]);
    // Open inboxes are told to look again.
    await stream.until((s) => s.changed().includes(chat));
    // Hamnivo's record of the change names both tags and counts the conversations.
    const events = await libraryAudits(desk);
    expect(events.find((e) => e.action === 'inbox.tag_renamed')?.data).toEqual({
      from: 'vip',
      to: 'gold',
      conversations: 1,
    });
    // Another brand's conversations are not touched by this brand's tag list.
    expect(titles((await rayan.client.get(library(desk, '/tags'))).body)).toEqual([
      'gold',
      'refund',
    ]);
  });

  it('deletes a tag from the list and from the conversations that carry it', async () => {
    expect(await filtered('gold')).toEqual([chat]);
    const stream = new StaffStream(slice.baseUrl, rayan.client);
    onTestFinished(() => stream.close());
    await stream.ready;
    const seen = stream.changed().length;

    const removed = await rayan.client.delete(library(desk, '/tags/gold'));
    expect(removed.status).toBe(204);
    expect(titles((await rayan.client.get(library(desk, '/tags'))).body)).toEqual(['refund']);
    expect((await rayan.client.delete(library(desk, '/tags/gold'))).status).toBe(404);

    // The chat account took it off the conversation, and so did Hamnivo's copy (which no webhook
    // would have corrected): the queue no longer finds it, and the tag editor does not offer it.
    expect(await filtered('gold')).toEqual([]);
    expect((await rayan.client.get(inbox(chat))).body.labels).toEqual(['refund']);
    const tags = await rayan.client.get(inbox(chat, '/tags'));
    expect(tags.body.labels).toEqual(['refund']);
    expect(titles({ items: tags.body.options })).toEqual(['refund']);
    const cw = await runtimeOf(desk);
    expect((await cw.authority.getState(await chatwootRef(chat))).labels).toEqual(['refund']);
    // Open inboxes are told to look again.
    await stream.until((s) => s.changed().slice(seen).includes(chat));
    // It cannot be put back by name: it is not on the list any more.
    const readded = await rayan.client.put(inbox(chat, '/tags'), { labels: ['refund', 'gold'] });
    expect(readded.status).toBe(422);
    expect(JSON.stringify(readded.body)).toContain('Unknown tag: gold');

    const events = (await libraryAudits(desk)).filter((e) => e.action.startsWith('inbox.tag_'));
    expect(events.map((e) => e.action)).toEqual([
      'inbox.tag_created',
      'inbox.tag_created',
      'inbox.tag_updated',
      'inbox.tag_updated',
      'inbox.tag_updated',
      'inbox.tag_renamed',
      'inbox.tag_deleted',
    ]);
    expect(events.at(-1)?.data).toEqual({ title: 'gold', conversations: 1 });
  });
});
