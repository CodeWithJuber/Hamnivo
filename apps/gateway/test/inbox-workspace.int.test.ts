import { randomUUID } from 'node:crypto';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createMockModel } from '@hamnivo/adapters/models';
import { fromPublicId, newPublicId, schema, withTenant } from '@hamnivo/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { AuthorityRegistry } from '../src/authority/registry.js';
import type { Client } from './harness.js';
import {
  audits,
  authority,
  customerStarts,
  join,
  type Shop,
  StaffStream,
} from './inbox-support.js';
import { connectedTenant, type Slice, startSlice, type Visitor } from './slice-harness.js';

/** The mock model; `answer` makes it reply with fixed text. */
function answeringModel() {
  const base = createMockModel();
  const state: { answer: string | null } = { answer: null };
  const model: LanguageModelV4 = {
    ...base,
    async doGenerate(call) {
      const result = await base.doGenerate(call);
      return state.answer ? { ...result, content: [{ type: 'text', text: state.answer }] } : result;
    },
  };
  return { model, state };
}

const answering = answeringModel();
let slice: Slice;
let desk: Shop;
let tenantId: string;
let amina: { client: Client; staffId: string };
let rayan: { client: Client; staffId: string };
let ana: { client: Client; staffId: string };
/** A verified customer (Maya Khan). */
let d1: string;
let maya: Visitor;
/** An anonymous visitor who typed an email address nobody verified. */
let d2: string;

const inbox = (id: string, rest = '') => `/v1/inbox/conversations/${id}${rest}`;
const ids = (body: { items: { id: string }[] }) => body.items.map((i) => i.id);

async function runtime() {
  return slice.worker
    .get(AuthorityRegistry)
    .get(tenantId, fromPublicId('connection', desk.connection.id));
}

async function setCustomer(conversationId: string, values: Record<string, unknown>) {
  const { control } = await authority(slice, desk, conversationId);
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .update(schema.customerPrincipals)
      .set(values)
      .where(eq(schema.customerPrincipals.id, control.principalId as string)),
  );
}

beforeAll(async () => {
  slice = await startSlice({ apiModel: answering.model });
  desk = await connectedTenant(slice, 'desk');
  tenantId = fromPublicId('tenant', desk.tenantId);
  amina = await join(slice, desk, 'Amina Agent', 'agent', { type: 'brand', id: desk.brand.id });
  rayan = await join(slice, desk, 'Rayan Lead', 'supervisor');
  ana = await join(slice, desk, 'Ana Analyst', 'analyst');

  const first = await customerStarts(slice, desk, 'I need help with invoice INV-7781');
  d1 = first.conversationId;
  maya = first.visitor;
  ({ conversationId: d2 } = await customerStarts(slice, desk, 'Hola, tengo una pregunta'));
  await slice.drain();
  // What the website verified (and what it did not) is Hamnivo's record of the customer.
  await setCustomer(d1, {
    kind: 'verified',
    externalSubject: 'cust-42',
    displayName: 'Maya Khan',
    email: 'maya@example.com',
    emailVerifiedAt: new Date(),
    locale: 'en',
  });
  await setCustomer(d2, { email: 'typed@example.com', emailVerifiedAt: null, locale: 'es' });

  // The brand's tags and fields, defined in Chatwoot.
  const cw = await runtime();
  await cw.authority.createLabel({ title: 'vip', description: 'Top customers' });
  await cw.authority.createLabel({ title: 'refund' });
  await cw.authority.createFieldDefinition({ key: 'order_ref', name: 'Order', type: 'text' });
  await cw.authority.createFieldDefinition({
    key: 'priority_level',
    name: 'Priority',
    type: 'list',
    options: ['low', 'high'],
  });
  await cw.authority.createFieldDefinition({
    key: 'follow_up',
    name: 'Follow up',
    type: 'checkbox',
  });

  expect((await amina.client.post(inbox(d1, '/assign'), { to: { kind: 'me' } })).status).toBe(200);
  await slice.drain();
});

afterAll(async () => {
  await slice?.close();
});

describe('tags and custom fields (H04)', () => {
  it('accepts only the brand’s tags, in Chatwoot and in the queue', async () => {
    const tags = await amina.client.get(inbox(d1, '/tags'));
    expect(tags.status, JSON.stringify(tags.body)).toBe(200);
    expect(tags.body.labels).toEqual([]);
    expect(tags.body.options.map((o: { title: string }) => o.title).sort()).toEqual([
      'refund',
      'vip',
    ]);
    const unknown = await amina.client.put(inbox(d1, '/tags'), { labels: ['VIP', 'angry'] });
    expect(unknown.status).toBe(422);
    expect(JSON.stringify(unknown.body)).toContain('Unknown tag: angry');
    const set = await amina.client.put(inbox(d1, '/tags'), { labels: ['VIP'] });
    expect(set.body.labels).toEqual(['vip']);
    expect((await authority(slice, desk, d1)).state.labels).toEqual(['vip']);
    expect(ids((await amina.client.get('/v1/inbox/conversations?label=vip')).body)).toEqual([d1]);
    expect((await ana.client.put(inbox(d1, '/tags'), { labels: [] })).status).toBe(403);
    expect(
      (await audits(slice, desk, d1)).find((a) => a.action === 'conversation.tags_changed'),
    ).toMatchObject({ data: { added: ['vip'], removed: [] } });
  });

  it('checks each field against its definition and keeps the other attributes', async () => {
    const wrong = await amina.client.patch(inbox(d1, '/fields'), {
      values: { priority_level: 'urgent', follow_up: 'yes', not_defined: 'x' },
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.fields.map((f: { path: string }) => f.path).sort()).toEqual([
      'values.follow_up',
      'values.not_defined',
      'values.priority_level',
    ]);
    const before = (await authority(slice, desk, d1)).state.attributes;
    const set = await amina.client.patch(inbox(d1, '/fields'), {
      values: { order_ref: 'HM-2048', priority_level: 'high', follow_up: true },
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.values).toEqual({
      order_ref: 'HM-2048',
      priority_level: 'high',
      follow_up: true,
    });
    const cleared = await amina.client.patch(inbox(d1, '/fields'), { values: { order_ref: null } });
    expect(cleared.body.values).toEqual({ priority_level: 'high', follow_up: true });
    const after = (await authority(slice, desk, d1)).state.attributes;
    // Hamnivo's own conversation attributes survive Chatwoot's replace-all write.
    expect(after).toEqual({ ...before, priority_level: 'high', follow_up: true });
    expect(Object.keys(before).length).toBeGreaterThan(0);
  });
});

describe('saved replies (H05)', () => {
  it('fills variables from verified facts only, and only managers add replies', async () => {
    const denied = await amina.client.post(inbox(d1, '/saved-replies'), {
      shortCode: 'thanks',
      content: 'x',
    });
    expect(denied.status).toBe(403);
    const created = await desk.owner.post(inbox(d1, '/saved-replies'), {
      shortCode: 'thanks',
      content:
        'Hi {{contact.first_name}}, this is {{agent.name}}. We will write to {{contact.email}}.',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.id).toMatch(/^srp_/);

    const verified = await amina.client.get(inbox(d1, '/saved-replies?q=thanks'));
    expect(verified.body.items).toEqual([
      expect.objectContaining({
        shortCode: 'thanks',
        preview: 'Hi Maya, this is Amina Agent. We will write to maya@example.com.',
        missingVariables: [],
      }),
    ]);
    // Nobody verified this visitor's address, so it is never put in a reply.
    const anonymous = await amina.client.get(inbox(d2, '/saved-replies?q=thanks'));
    expect(anonymous.body.items[0].preview).toBe(
      'Hi {{contact.first_name}}, this is Amina Agent. We will write to {{contact.email}}.',
    );
    expect(anonymous.body.items[0].missingVariables.sort()).toEqual([
      'contact.email',
      'contact.first_name',
    ]);
    expect(
      (await amina.client.get(inbox(d1, '/saved-replies?q=nothing-like-this'))).body.items,
    ).toEqual([]);
    expect((await ana.client.get(inbox(d1, '/saved-replies'))).status).toBe(403);
  });
});

describe('customer context (H06)', () => {
  it('says who the customer is, what was verified, and their other conversations', async () => {
    const again = await maya.call('POST', '/v1/widget/conversations', {
      firstMessage: 'Also, my last parcel was damaged',
      clientMessageId: randomUUID(),
    });
    expect(again.status).toBe(201);
    await slice.drain();
    const context = await amina.client.get(inbox(d1, '/customer'));
    expect(context.status, JSON.stringify(context.body)).toBe(200);
    expect(context.body).toMatchObject({
      displayName: 'Maya Khan',
      identity: 'verified',
      externalId: 'cust-42',
      email: 'maya@example.com',
      unverifiedEmail: null,
      language: 'en',
      brand: { id: desk.brand.id, name: 'desk Shop' },
      customerSince: expect.any(String),
    });
    expect(context.body.attributes.some((a: { key: string }) => a.key.startsWith('hv_'))).toBe(
      false,
    );
    expect(context.body.previousConversations).toEqual([
      expect.objectContaining({ id: again.body.id, status: expect.any(String) }),
    ]);

    const visitor = await amina.client.get(inbox(d2, '/customer'));
    expect(visitor.body).toMatchObject({
      displayName: 'Visitor',
      identity: 'anonymous',
      externalId: null,
      email: null,
      unverifiedEmail: 'typed@example.com',
      language: 'es',
      previousConversations: [],
    });
    const row = await amina.client.get(`/v1/inbox/conversations?queue=all`);
    expect(row.body.items.find((i: { id: string }) => i.id === d1).customer).toEqual({
      displayName: 'Maya Khan',
      identity: 'verified',
      language: 'en',
    });
  });
});

describe('search (H07)', () => {
  it('finds customers and message text, notes included, only where the grants reach', async () => {
    await amina.client.post(`/v1/conversations/${d1}/messages`, {
      clientMessageId: randomUUID(),
      text: 'Checked INV-7781 with finance',
      visibility: 'internal',
    });
    const byText = await amina.client.get('/v1/inbox/search?q=INV-7781');
    expect(byText.status, JSON.stringify(byText.body)).toBe(200);
    expect(byText.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId: d1,
          visibility: 'public',
          sender: expect.objectContaining({ kind: 'customer' }),
        }),
        expect.objectContaining({
          conversationId: d1,
          visibility: 'internal',
          snippet: expect.stringContaining('INV-7781'),
        }),
      ]),
    );
    const byName = await amina.client.get('/v1/inbox/search?q=maya');
    expect(byName.body.conversations.map((c: { id: string }) => c.id)).toContain(d1);
    const byId = await amina.client.get(`/v1/inbox/search?q=${d2}`);
    expect(byId.body.conversations.map((c: { id: string }) => c.id)).toEqual([d2]);
    expect((await amina.client.get('/v1/inbox/search?q=x')).status).toBe(422);
  });
});

describe('timeline paging', () => {
  it('pages the staff transcript backwards, newest first', async () => {
    for (let i = 1; i <= 22; i += 1) {
      const note = await amina.client.post(`/v1/conversations/${d1}/messages`, {
        clientMessageId: randomUUID(),
        text: `Paging note ${i}`,
        visibility: 'internal',
      });
      expect(note.status).toBe(202);
    }
    const first = await amina.client.get(inbox(d1, '/messages'));
    expect(first.body.items).toHaveLength(20);
    expect(first.body.items[0].parts[0].text).toBe('Paging note 22');
    expect(first.body.olderCursor).toEqual(expect.any(String));
    const older = await amina.client.get(inbox(d1, `/messages?before=${first.body.olderCursor}`));
    expect(older.status).toBe(200);
    const seen = new Set(first.body.items.map((m: { id: string }) => m.id));
    expect(older.body.items.some((m: { id: string }) => seen.has(m.id))).toBe(false);
    expect(older.body.items.map((m: { parts: { text: string }[] }) => m.parts[0]?.text)).toContain(
      'Paging note 1',
    );
    expect((await amina.client.get(inbox(d1, '/messages?before=bm90LWEtcmVm'))).status).toBe(422);
  });
});

describe('presence and live updates (H08)', () => {
  it('shows who else is viewing or typing, and streams changes to people who may see them', async () => {
    const omar = await join(slice, desk, 'Omar Lead', 'supervisor');
    const stream = new StaffStream(slice.baseUrl, omar.client);
    onTestFinished(() => stream.close());
    const response = await stream.ready;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const viewing = await amina.client.post(inbox(d1, '/presence'), { state: 'viewing' });
    expect(viewing.status).toBe(200);
    expect(viewing.body.viewers).toEqual([]);
    await amina.client.post(inbox(d1, '/presence'), { state: 'typing', lane: 'public' });
    await stream.until((s) =>
      s.events('presence').some((e) => e.conversationId === d1 && e.viewers[0]?.state === 'typing'),
    );
    const detail = await omar.client.get(inbox(d1));
    expect(detail.body.presence).toEqual([
      expect.objectContaining({
        staffMemberId: amina.staffId,
        displayName: 'Amina Agent',
        state: 'typing',
        lane: 'public',
      }),
    ]);
    // A person never sees themselves in the list.
    expect((await amina.client.get(inbox(d1))).body.presence).toEqual([]);
    await amina.client.post(inbox(d1, '/presence'), { state: 'left' });
    await stream.until((s) =>
      s.events('presence').some((e) => e.conversationId === d1 && e.viewers.length === 0),
    );

    // A new customer message makes the conversation reload, without the text itself.
    await maya.call('POST', `/v1/widget/conversations/${d1}/messages`, {
      clientMessageId: randomUUID(),
      parts: [{ type: 'text', text: 'Any news on INV-7781?' }],
    });
    await slice.drain();
    await stream.until((s) => s.changed().includes(d1));
    expect(JSON.stringify(stream.messages)).not.toContain('Any news');

    // Signing out ends the stream at the next heartbeat.
    await omar.client.post('/api/auth/sign-out', {});
    await stream.until((s) => s.events('control').some((e) => e.control === 'auth_expired'));
    await stream.until((s) => s.ended);
  });
});

describe('teams (H02)', () => {
  it('puts conversations in team queues, mirrors the team in Chatwoot, and scopes grants to it', async () => {
    const team = await desk.owner.post('/v1/admin/teams', { name: 'Billing' });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    expect((await desk.owner.post('/v1/admin/teams', { name: 'billing' })).status).toBe(422);
    const tariq = await join(slice, desk, 'Tariq Agent', 'agent', {
      type: 'team',
      id: team.body.id,
    });
    const members = await desk.owner.put(`/v1/admin/teams/${team.body.id}/members`, {
      staffMemberIds: [amina.staffId, tariq.staffId],
    });
    expect(members.body.members.map((m: { displayName: string }) => m.displayName).sort()).toEqual([
      'Amina Agent',
      'Tariq Agent',
    ]);
    // Nothing is in the team yet: the team-scoped agent sees an empty inbox.
    expect((await tariq.client.get('/v1/inbox/conversations')).body.items).toEqual([]);
    expect((await tariq.client.get(inbox(d1))).status).toBe(404);

    expect((await amina.client.post(inbox(d2, '/team'), { teamId: team.body.id })).status).toBe(
      403,
    );
    const assigned = await rayan.client.post(inbox(d2, '/team'), { teamId: team.body.id });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(assigned.body.team).toEqual({ id: team.body.id, name: 'Billing' });
    await slice.drain();
    const { state } = await authority(slice, desk, d2);
    expect(state.teamRef).not.toBeNull();
    const [link] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.teamAuthorityLinks)
        .where(eq(schema.teamAuthorityLinks.teamId, fromPublicId('team', team.body.id))),
    );
    expect(String(link?.externalTeamId)).toBe(state.teamRef);
    // The webhook from Chatwoot agrees with Hamnivo's queue.
    expect((await rayan.client.get(inbox(d2))).body.team).toEqual({
      id: team.body.id,
      name: 'Billing',
    });

    const scoped = await tariq.client.get('/v1/inbox/conversations');
    expect(ids(scoped.body)).toEqual([d2]);
    const mine = await amina.client.get('/v1/inbox/conversations?queue=team');
    expect(ids(mine.body)).toEqual([d2]);
    expect(mine.body.counts.team).toBe(1);
    const options = await rayan.client.get(inbox(d2, '/assignees'));
    expect(options.body.teams).toEqual([{ id: team.body.id, name: 'Billing' }]);
    expect(options.body.staff.map((s: { displayName: string }) => s.displayName)).toEqual(
      expect.arrayContaining(['Amina Agent', 'Tariq Agent', 'Rayan Lead']),
    );
    expect(options.body.staff.map((s: { displayName: string }) => s.displayName)).not.toContain(
      'Ana Analyst',
    );

    const removed = await rayan.client.post(inbox(d2, '/team'), { teamId: null });
    expect(removed.body.team).toBeNull();
    await slice.drain();
    expect((await authority(slice, desk, d2)).state.teamRef).toBeNull();
    expect((await tariq.client.get(inbox(d2))).status).toBe(404);
  });
});

describe('bulk changes (H15)', () => {
  it('checks each conversation like a single change and reports each result', async () => {
    expect(
      (
        await amina.client.post('/v1/inbox/bulk', {
          conversationIds: [d1],
          action: { type: 'status', status: 'resolved' },
        })
      ).status,
    ).toBe(403);
    const missing = newPublicId('conversation').publicId;
    const dry = await rayan.client.post('/v1/inbox/bulk', {
      conversationIds: [d1, d2, missing],
      action: { type: 'tags', add: ['refund'] },
      dryRun: true,
    });
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.body.results.map((r: { outcome: string }) => r.outcome)).toEqual([
      'eligible',
      'eligible',
      'failed',
    ]);
    expect((await authority(slice, desk, d2)).state.labels).toEqual([]);

    const applied = await rayan.client.post('/v1/inbox/bulk', {
      conversationIds: [d1, d2, missing],
      action: { type: 'tags', add: ['vip'] },
    });
    expect(applied.body.results).toEqual([
      expect.objectContaining({ conversationId: d1, outcome: 'unchanged' }),
      expect.objectContaining({ conversationId: d2, outcome: 'done' }),
      expect.objectContaining({ conversationId: missing, outcome: 'failed', code: 'NOT_FOUND' }),
    ]);
    expect(applied.body.summary).toEqual({ done: 1, unchanged: 1, eligible: 0, failed: 1 });
    expect((await authority(slice, desk, d2)).state.labels).toEqual(['vip']);
  });
});

describe('supervisor review and linked conversations (H14, H17)', () => {
  it('lets supervisors review a conversation; agents cannot', async () => {
    expect((await amina.client.get(inbox(d1, '/reviews'))).status).toBe(403);
    expect((await rayan.client.post(inbox(d1, '/reviews'), { rating: 6 })).status).toBe(422);
    const review = await rayan.client.post(inbox(d1, '/reviews'), {
      rating: 4,
      note: 'Clear and kind.',
    });
    expect(review.status, JSON.stringify(review.body)).toBe(201);
    expect(review.body).toMatchObject({
      rating: 4,
      note: 'Clear and kind.',
      reviewer: { staffMemberId: rayan.staffId, displayName: 'Rayan Lead' },
      subject: { staffMemberId: amina.staffId, displayName: 'Amina Agent' },
    });
    expect((await rayan.client.get(inbox(d1, '/reviews'))).body.items).toHaveLength(1);
  });

  it('links related conversations without merging them', async () => {
    const link = await amina.client.post(inbox(d1, '/links'), {
      conversationId: d2,
      note: 'Same invoice',
    });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    expect(link.body).toMatchObject({
      conversation: { id: d2 },
      note: 'Same invoice',
      createdBy: { displayName: 'Amina Agent' },
    });
    const again = await amina.client.post(inbox(d2, '/links'), { conversationId: d1 });
    expect(again.body.id).toBe(link.body.id);
    expect((await amina.client.get(inbox(d2, '/links'))).body.items).toEqual([
      expect.objectContaining({
        id: link.body.id,
        conversation: expect.objectContaining({ id: d1 }),
      }),
    ]);
    expect((await amina.client.post(inbox(d1, '/links'), { conversationId: d1 })).status).toBe(422);
    const unknown = newPublicId('conversation').publicId;
    expect((await amina.client.post(inbox(d1, '/links'), { conversationId: unknown })).status).toBe(
      404,
    );
    // Both conversations keep their own messages.
    expect((await authority(slice, desk, d1)).messages.length).toBeGreaterThan(0);
    expect((await amina.client.delete(inbox(d1, `/links/${link.body.id}`))).status).toBe(204);
    expect((await amina.client.get(inbox(d1, '/links'))).body.items).toEqual([]);
    const actions = (await audits(slice, desk, d1)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'conversation.linked',
        'conversation.unlinked',
        'conversation.reviewed',
      ]),
    );
  });
});

describe('translation (H13)', () => {
  it('translates a message on demand, marked as machine translation', async () => {
    const messages = await amina.client.get(inbox(d2, '/messages'));
    const original = messages.body.items.find(
      (m: { sender: { kind: string } }) => m.sender.kind === 'customer',
    );
    answering.state.answer = 'Hello, I have a question';
    const translated = await amina.client.post(inbox(d2, `/messages/${original.id}/translation`), {
      targetLanguage: 'en',
    });
    answering.state.answer = null;
    expect(translated.status, JSON.stringify(translated.body)).toBe(200);
    expect(translated.body).toEqual({
      messageId: original.id,
      targetLanguage: 'en',
      text: 'Hello, I have a question',
      machine: true,
      provider: expect.any(String),
      model: expect.any(String),
    });
    // The original is unchanged in Chatwoot.
    const { messages: stored } = await authority(slice, desk, d2);
    expect(stored.some((m) => m.text === 'Hola, tengo una pregunta')).toBe(true);
    expect(stored.some((m) => m.text === 'Hello, I have a question')).toBe(false);
    const unknown = newPublicId('message').publicId;
    expect(
      (
        await amina.client.post(inbox(d2, `/messages/${unknown}/translation`), {
          targetLanguage: 'en',
        })
      ).status,
    ).toBe(404);
  });
});
