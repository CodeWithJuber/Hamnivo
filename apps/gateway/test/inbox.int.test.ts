import { randomUUID } from 'node:crypto';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createMockModel } from '@hamnivo/adapters/models';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import type { Client } from './harness.js';
import { audits, authority, customerStarts, join, type Shop } from './inbox-support.js';
import {
  connectedTenant,
  hookedModel,
  type Slice,
  startSlice,
  type Visitor,
} from './slice-harness.js';

/** The mock model; `answer` makes it reply with fixed text (the copilot's citations). */
function answeringModel() {
  const base = createMockModel();
  const state: { answer: string | null; lastPrompt: string } = { answer: null, lastPrompt: '' };
  const model: LanguageModelV4 = {
    ...base,
    async doGenerate(call) {
      state.lastPrompt = JSON.stringify(call.prompt);
      const result = await base.doGenerate(call);
      return state.answer ? { ...result, content: [{ type: 'text', text: state.answer }] } : result;
    },
  };
  return { model, state };
}

const hooked = hookedModel();
const answering = answeringModel();
let slice: Slice;
let north: Shop;
let outlet: Shop;
let south: Shop;
let amina: { client: Client; staffId: string };
let rayan: { client: Client; staffId: string };
let ana: { client: Client; staffId: string };
/** AI answers it. */
let c1: string;
/** The customer asked for a person. */
let c2: string;
let v2: Visitor;
/** Another brand (and Chatwoot account) of the same tenant. */
let c3: string;

const inbox = (id: string, rest = '') => `/v1/inbox/conversations/${id}${rest}`;
const ids = (body: { items: { id: string }[] }) => body.items.map((i) => i.id);

async function epochOf(client: Client, id: string): Promise<number> {
  const detail = await client.get(inbox(id));
  expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  return detail.body.ownershipEpoch as number;
}

beforeAll(async () => {
  slice = await startSlice({ model: hooked.model, apiModel: answering.model });
  north = await connectedTenant(slice, 'north');
  south = await connectedTenant(slice, 'south');
  // A second brand of the same tenant, connected to its own Chatwoot account.
  const brand = await north.owner.post('/v1/admin/brands', {
    workspaceId: north.workspaceId,
    name: 'north Outlet',
    allowedOrigins: ['https://outlet.example'],
  });
  const connection = await north.owner.post('/v1/admin/authority/connections', {
    brandId: brand.body.id,
  });
  const agents = await north.owner.get('/v1/admin/agents');
  const agentId = agents.body.items.find((a: { brandId: string }) => a.brandId === brand.body.id)
    ?.id as string;
  await north.owner.post(`/v1/admin/agents/${agentId}/publish`, {});
  outlet = {
    ...north,
    agentId,
    brand: brand.body,
    connection: connection.body,
    hostOrigin: 'https://outlet.example',
  };
  amina = await join(slice, north, 'Amina Agent', 'agent', { type: 'brand', id: north.brand.id });
  rayan = await join(slice, north, 'Rayan Lead', 'supervisor');
  ana = await join(slice, north, 'Ana Analyst', 'analyst');

  ({ conversationId: c1 } = await customerStarts(slice, north, 'Where is my order HM-2048?'));
  const second = await customerStarts(slice, north, 'Can I change my delivery address?');
  c2 = second.conversationId;
  v2 = second.visitor;
  const handoff = await v2.call('POST', `/v1/widget/conversations/${c2}/handoff`, {
    clientRequestId: randomUUID(),
    note: 'please, a person',
  });
  expect(handoff.status).toBe(200);
  ({ conversationId: c3 } = await customerStarts(slice, outlet, 'Do you have the olive backpack?'));
  await slice.drain();
});

afterAll(async () => {
  await slice?.close();
});

describe('shared inbox (H01)', () => {
  it('lists the queues a staff member’s grants reach, with counts, filters and paging', async () => {
    const all = await north.owner.get('/v1/inbox/conversations?queue=all');
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(ids(all.body)).toEqual(expect.arrayContaining([c1, c2, c3]));
    expect(all.body.counts).toEqual({
      mine: 0,
      unassigned: 1,
      ai: 2,
      team: 0,
      tickets: 0,
      all: 3,
    });

    const first = all.body.items.find((i: { id: string }) => i.id === c1);
    expect(first).toMatchObject({
      brand: { id: north.brand.id, name: 'north Shop' },
      channel: 'chat',
      status: 'pending',
      ownerMode: 'AI_ACTIVE',
      owner: { kind: 'ai', displayName: expect.any(String) },
      customer: { displayName: 'Visitor', identity: 'anonymous' },
      lastMessage: { from: 'ai' },
      labels: [],
      team: null,
    });
    const waiting = all.body.items.find((i: { id: string }) => i.id === c2);
    expect(waiting).toMatchObject({
      ownerMode: 'WAITING_HUMAN',
      owner: { kind: 'none' },
      ownerReason: 'customer_request',
      customerStatus: 'waiting_for_person',
    });
    expect(waiting.waitingSince).toEqual(expect.any(String));

    expect(ids((await north.owner.get('/v1/inbox/conversations?queue=unassigned')).body)).toEqual([
      c2,
    ]);
    const ai = await north.owner.get('/v1/inbox/conversations?queue=ai');
    expect(ids(ai.body).sort()).toEqual([c1, c3].sort());
    const byBrand = await north.owner.get(`/v1/inbox/conversations?brandId=${outlet.brand.id}`);
    expect(ids(byBrand.body)).toEqual([c3]);
    const resolved = await north.owner.get('/v1/inbox/conversations?status=resolved');
    expect(resolved.body).toMatchObject({ items: [], counts: { all: 0 } });

    // Paging keeps the order without repeating or skipping a conversation.
    const page1 = await north.owner.get('/v1/inbox/conversations?limit=2');
    expect(page1.body.items).toHaveLength(2);
    const page2 = await north.owner.get(
      `/v1/inbox/conversations?limit=2&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body.nextCursor).toBeNull();
    expect(new Set([...ids(page1.body), ...ids(page2.body)])).toEqual(new Set([c1, c2, c3]));

    // A brand-scoped agent sees that brand only; the other brand's conversations do not exist.
    const mine = await amina.client.get('/v1/inbox/conversations');
    expect(ids(mine.body).sort()).toEqual([c1, c2].sort());
    expect(mine.body.counts.all).toBe(2);
    expect((await amina.client.get(inbox(c3))).status).toBe(404);
    expect((await amina.client.get(inbox(c3, '/messages'))).status).toBe(404);
    expect((await ana.client.get('/v1/inbox/conversations')).status).toBe(200);
  });

  it('says what the caller may do in a conversation', async () => {
    const detail = await amina.client.get(inbox(c2));
    expect(detail.body.permissions).toEqual({
      reply: true,
      note: true,
      takeover: true,
      assign: false,
      status: true,
      tag: true,
      review: false,
      bulk: false,
    });
    expect(detail.body.aiAvailable).toBe(true);
    const analyst = await ana.client.get(inbox(c2));
    expect(analyst.body.permissions).toMatchObject({ reply: false, note: false, status: false });
  });
});

describe('assignment and ownership (H02, H08)', () => {
  it('claims atomically: a second claim from a stale view is refused and shows the owner', async () => {
    const epoch = await epochOf(amina.client, c2);
    const claimed = await amina.client.post(inbox(c2, '/assign'), {
      to: { kind: 'me' },
      expectedEpoch: epoch,
    });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(claimed.body).toMatchObject({
      ownerMode: 'HUMAN_ACTIVE',
      ownershipEpoch: epoch + 1,
      owner: { kind: 'staff', staffMemberId: amina.staffId, displayName: 'Amina Agent' },
      ownerReason: 'staff_takeover',
    });
    const late = await rayan.client.post(inbox(c2, '/assign'), {
      to: { kind: 'me' },
      expectedEpoch: epoch,
    });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('OWNERSHIP_CHANGED');
    const seen = await rayan.client.get(inbox(c2));
    expect(seen.body.owner).toMatchObject({ kind: 'staff', displayName: 'Amina Agent' });
    expect(seen.body.ownerChangedAt).toEqual(expect.any(String));

    await slice.drain();
    const { state } = await authority(slice, north, c2);
    expect(state.owner.kind).toBe('user');
    const queue = await amina.client.get('/v1/inbox/conversations?queue=mine');
    expect(ids(queue.body)).toEqual([c2]);
    expect(queue.body.counts.mine).toBe(1);
  });

  it('keeps internal notes out of the customer lane, and shows them to staff as notes', async () => {
    const stream = v2.stream(c2);
    onTestFinished(() => stream.close());
    await stream.ready;
    const note = await amina.client.post(`/v1/conversations/${c2}/messages`, {
      clientMessageId: randomUUID(),
      text: 'Internal: courier delayed on HM-2048',
      visibility: 'internal',
    });
    expect(note.status).toBe(202);
    const reply = await amina.client.post(`/v1/conversations/${c2}/messages`, {
      clientMessageId: randomUUID(),
      text: 'Hi, I am checking your order now.',
      expectedEpoch: await epochOf(amina.client, c2),
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    await slice.drain();
    await stream.until((s) =>
      s.events.some(
        (e) => e.data?.message?.parts?.[0]?.text === 'Hi, I am checking your order now.',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(JSON.stringify(stream.messages)).not.toContain('courier delayed');
    const history = await v2.call('GET', `/v1/widget/conversations/${c2}/messages?limit=50`);
    expect(JSON.stringify(history.body)).not.toContain('courier delayed');

    const staff = await amina.client.get(inbox(c2, '/messages'));
    expect(staff.status).toBe(200);
    const items = staff.body.items as Array<Record<string, any>>;
    expect(
      items.find((m) => m.parts[0].text === 'Internal: courier delayed on HM-2048'),
    ).toMatchObject({
      visibility: 'internal',
      mine: true,
      system: null,
      sender: { kind: 'human_agent', displayName: 'Amina Agent' },
    });
    expect(
      items.find((m) => m.parts[0].text === 'Hi, I am checking your order now.'),
    ).toMatchObject({ visibility: 'public', mine: true });
    // The handoff packet Hamnivo wrote is shown as Hamnivo's note, not as a person's.
    expect(items.find((m) => m.system === 'hamnivo_note')).toMatchObject({
      visibility: 'internal',
      sender: { kind: 'system', displayName: 'Hamnivo' },
    });
    // Newest first.
    const times = items.map((m) => Date.parse(m.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const { messages } = await authority(slice, north, c2);
    expect(messages.find((m) => m.text?.startsWith('Internal: courier'))?.private).toBe(true);
  });

  it('refuses a reply over a colleague and a stale reply; notes stay possible', async () => {
    const over = await rayan.client.post(`/v1/conversations/${c2}/messages`, {
      clientMessageId: randomUUID(),
      text: 'Rayan here, replying over Amina',
    });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('OWNERSHIP_CHANGED');
    const note = await rayan.client.post(`/v1/conversations/${c2}/messages`, {
      clientMessageId: randomUUID(),
      text: 'Supervisor note: VIP customer',
      visibility: 'internal',
    });
    expect(note.status).toBe(202);

    // Amina's view is at this epoch; then a supervisor puts the conversation back in the queue.
    // Nobody owns it now, yet her reply from the older view is refused: it was written for a
    // conversation that has changed hands.
    const seen = await epochOf(amina.client, c2);
    const released = await rayan.client.post(inbox(c2, '/assign'), { to: { kind: 'queue' } });
    expect(released.body).toMatchObject({
      ownerMode: 'WAITING_HUMAN',
      ownerReason: 'staff_release',
    });
    const stale = await amina.client.post(`/v1/conversations/${c2}/messages`, {
      clientMessageId: randomUUID(),
      text: 'A reply written in a stale view',
      expectedEpoch: seen,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('OWNERSHIP_CHANGED');
    expect(stale.body.detail).toContain('Nothing was sent');
    const takeover = await rayan.client.post(inbox(c2, '/assign'), { to: { kind: 'me' } });
    expect(takeover.status, JSON.stringify(takeover.body)).toBe(200);
    expect(takeover.body.owner).toMatchObject({ kind: 'staff', displayName: 'Rayan Lead' });

    // An agent cannot take it from a colleague; she asks for it instead.
    const grab = await amina.client.post(inbox(c2, '/assign'), { to: { kind: 'me' } });
    expect(grab.status).toBe(409);
    const ask = await amina.client.post(inbox(c2, '/transfer-request'), {
      clientRequestId: randomUUID(),
      note: 'I know this customer',
    });
    expect(ask.status).toBe(202);

    // The supervisor gives it back; assigning to someone who cannot reply there is refused.
    const toAna = await rayan.client.post(inbox(c2, '/assign'), {
      to: { kind: 'staff', staffMemberId: ana.staffId },
    });
    expect(toAna.status).toBe(422);
    const back = await rayan.client.post(inbox(c2, '/assign'), {
      to: { kind: 'staff', staffMemberId: amina.staffId },
    });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({
      owner: { kind: 'staff', displayName: 'Amina Agent' },
      ownerReason: 'staff_assign',
    });

    await slice.drain();
    const { messages, state } = await authority(slice, north, c2);
    const texts = messages.map((m) => m.text ?? '');
    expect(texts.some((t) => t.includes('Rayan here'))).toBe(false);
    expect(texts.some((t) => t.includes('stale view'))).toBe(false);
    expect(messages.find((m) => m.text?.includes('asked to take over'))).toMatchObject({
      private: true,
      sender: { kind: 'user', name: 'Amina Agent' },
    });
    expect(state.owner.kind).toBe('user');
    const actions = (await audits(slice, north, c2)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['conversation.owner_changed', 'conversation.transfer_requested']),
    );
  });

  it('fences an AI reply that is being written when staff claim the conversation', async () => {
    const { conversationId: c4 } = await customerStarts(slice, north, 'Is my parcel lost?');
    hooked.state.during = async () => {
      const claimed = await amina.client.post(inbox(c4, '/assign'), { to: { kind: 'me' } });
      expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    };
    await slice.drain();
    expect(hooked.state.during).toBeNull();
    const { messages, control } = await authority(slice, north, c4);
    expect(messages.filter((m) => m.sender.kind === 'bot')).toHaveLength(0);
    expect(control).toMatchObject({ ownerMode: 'HUMAN_ACTIVE', ownerReason: 'staff_takeover' });
    const tenantId = fromPublicId('tenant', north.tenantId);
    const publications = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.conversationId, control.id)),
    );
    expect(publications).toEqual([
      expect.objectContaining({
        state: 'aborted',
        epoch: 0,
        detail: expect.objectContaining({ reason: 'not_ai_owned' }),
      }),
    ]);
    const runs = await withTenant(slice.app, { tenantId }, (tx) =>
      tx.select().from(schema.runs).where(eq(schema.runs.conversationId, control.id)),
    );
    expect(runs.map((r) => r.outcome)).toContain('fenced');
  });

  it('hands a conversation back to the queue and to the AI, as an authorized change', async () => {
    const { conversationId: c5 } = await customerStarts(slice, north, 'Hello, one question');
    await slice.drain();
    await amina.client.post(inbox(c5, '/assign'), { to: { kind: 'me' } });
    const released = await amina.client.post(inbox(c5, '/assign'), { to: { kind: 'queue' } });
    expect(released.body).toMatchObject({
      ownerMode: 'WAITING_HUMAN',
      ownerReason: 'staff_release',
    });
    // An agent moves her own conversations; moving anyone else's (the AI's too) is a supervisor's.
    await amina.client.post(inbox(c5, '/assign'), { to: { kind: 'me' } });
    const toAi = await amina.client.post(inbox(c5, '/assign'), { to: { kind: 'ai' } });
    expect(toAi.status, JSON.stringify(toAi.body)).toBe(200);
    expect(toAi.body).toMatchObject({ ownerMode: 'AI_ACTIVE', ownerReason: 'return_to_ai' });
    const moved = await amina.client.post(inbox(c5, '/assign'), { to: { kind: 'queue' } });
    expect(moved.status).toBe(403);
    await slice.drain();
    const { state } = await authority(slice, north, c5);
    expect(state).toMatchObject({ status: 'pending', owner: { kind: 'bot' } });
  });
});

describe('drafts and failed sends (H09)', () => {
  it('keeps a draft per lane with revisions, and refuses a save from an older revision', async () => {
    const first = await amina.client.put(inbox(c2, '/drafts/public'), { text: 'Hello' });
    expect(first.body).toMatchObject({ lane: 'public', text: 'Hello', revision: 1 });
    const second = await amina.client.put(inbox(c2, '/drafts/public'), {
      text: 'Hello Maya',
      baseRevision: 1,
    });
    expect(second.body.revision).toBe(2);
    const otherTab = await amina.client.put(inbox(c2, '/drafts/public'), {
      text: 'From another tab',
      baseRevision: 1,
    });
    expect(otherTab.status).toBe(409);
    expect(otherTab.body.code).toBe('VERSION_CONFLICT');
    await amina.client.put(inbox(c2, '/drafts/internal'), { text: 'check the courier' });
    const drafts = await amina.client.get(inbox(c2, '/drafts'));
    expect(drafts.body.drafts).toEqual([
      expect.objectContaining({ lane: 'public', text: 'Hello Maya', revision: 2 }),
      expect.objectContaining({ lane: 'internal', text: 'check the courier', revision: 1 }),
    ]);
    // Drafts are personal.
    expect((await rayan.client.get(inbox(c2, '/drafts'))).body.drafts).toEqual([]);
  });

  it('keeps a send that timed out, and a retry with the same id posts nothing twice', async () => {
    const clientMessageId = randomUUID();
    const body = {
      clientMessageId,
      text: 'Your parcel ships today.',
      clearDraft: true,
      expectedEpoch: await epochOf(amina.client, c2),
    };
    // Chatwoot stores the message, then the response is lost.
    slice.fake.setResponseFault((method, url) =>
      method === 'POST' && /\/conversations\/\d+\/messages$/.test(url) ? 504 : null,
    );
    const failed = await amina.client.post(`/v1/conversations/${c2}/messages`, body);
    slice.fake.setResponseFault(null);
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('AUTHORITY_UNAVAILABLE');
    const kept = await amina.client.get(inbox(c2, '/drafts'));
    expect(kept.body.outgoing).toEqual([
      expect.objectContaining({
        clientMessageId,
        lane: 'public',
        text: 'Your parcel ships today.',
        state: 'failed',
        errorCode: 'AUTHORITY_UNAVAILABLE',
      }),
    ]);
    // The reply draft was cleared when the send started; the note draft stays.
    expect(kept.body.drafts.map((d: { lane: string }) => d.lane)).toEqual(['internal']);

    const retried = await amina.client.post(`/v1/conversations/${c2}/messages`, body);
    expect(retried.status, JSON.stringify(retried.body)).toBe(202);
    expect(retried.body.status).toBe('duplicate');
    await slice.drain();
    const { messages } = await authority(slice, north, c2);
    expect(messages.filter((m) => m.text === 'Your parcel ships today.')).toHaveLength(1);
    expect((await amina.client.get(inbox(c2, '/drafts'))).body.outgoing).toEqual([]);

    // A failed send can also be discarded.
    const refused = await rayan.client.post(`/v1/conversations/${c2}/messages`, {
      clientMessageId: randomUUID(),
      text: 'Not mine to send',
    });
    expect(refused.status).toBe(409);
    expect((await rayan.client.get(inbox(c2, '/drafts'))).body.outgoing).toEqual([]);
  });
});

describe('resolve, reopen and snooze (H10)', () => {
  it('changes status as the staff member, tells the customer, and audits every change', async () => {
    expect((await ana.client.post(inbox(c2, '/status'), { status: 'resolved' })).status).toBe(403);
    const stream = v2.stream(c2);
    onTestFinished(() => stream.close());
    await stream.ready;
    const resolved = await amina.client.post(inbox(c2, '/status'), { status: 'resolved' });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body).toMatchObject({ status: 'resolved', customerStatus: 'resolved' });
    await stream.until((s) => s.events.some((e) => e.type === 'conversation.resolved'));
    expect((await authority(slice, north, c2)).state.status).toBe('resolved');
    expect(ids((await amina.client.get('/v1/inbox/conversations?status=resolved')).body)).toContain(
      c2,
    );

    const reopened = await amina.client.post(inbox(c2, '/status'), { status: 'open' });
    expect(reopened.body).toMatchObject({
      status: 'open',
      owner: { kind: 'staff', displayName: 'Amina Agent' },
    });
    await stream.until((s) => s.events.some((e) => e.type === 'conversation.reopened'));

    const past = await amina.client.post(inbox(c2, '/status'), {
      status: 'snoozed',
      snoozedUntil: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(past.status).toBe(422);
    const until = new Date(Date.now() + 3_600_000);
    const snoozed = await amina.client.post(inbox(c2, '/status'), {
      status: 'snoozed',
      snoozedUntil: until.toISOString(),
    });
    expect(snoozed.body.status).toBe('snoozed');
    expect(Math.abs(Date.parse(snoozed.body.snoozedUntil) - until.getTime())).toBeLessThan(1000);
    const list = await amina.client.get('/v1/inbox/conversations?status=snoozed');
    expect(ids(list.body)).toEqual([c2]);
    const { state } = await authority(slice, north, c2);
    expect(state.status).toBe('snoozed');
    expect(Math.abs((state.snoozedUntil?.getTime() ?? 0) - until.getTime())).toBeLessThan(2000);

    const open = await amina.client.post(inbox(c2, '/status'), { status: 'open' });
    expect(open.body).toMatchObject({ status: 'open', snoozedUntil: null });
    await slice.drain();
    const changes = (await audits(slice, north, c2)).filter(
      (a) => a.action === 'conversation.status_changed',
    );
    expect(changes.map((a) => [a.data.from, a.data.to])).toEqual([
      ['open', 'resolved'],
      ['resolved', 'open'],
      ['open', 'snoozed'],
      ['snoozed', 'open'],
    ]);
  });
});

describe('AI copilot (H11)', () => {
  it('suggests a reply with its sources, from customer-visible messages only, and never sends it', async () => {
    const source = await north.owner.post('/v1/admin/knowledge/sources', {
      brandId: north.brand.id,
      name: 'Help centre',
    });
    const added = await north.owner.post(
      `/v1/admin/knowledge/sources/${source.body.id}/documents`,
      {
        title: 'Delivery changes',
        url: 'https://kb.example/delivery',
        content: {
          mediaType: 'text/markdown',
          text: '# Delivery address\n\nYou can change the delivery address before the order is dispatched.',
        },
      },
    );
    expect(added.status, JSON.stringify(added.body)).toBe(202);
    await slice.drain();
    const agent = await north.owner.get(`/v1/admin/agents/${north.agentId}`);
    await north.owner.put(`/v1/admin/agents/${north.agentId}/draft`, {
      config: { ...agent.body.published.config, knowledgeSourceIds: [source.body.id] },
    });
    expect((await north.owner.post(`/v1/admin/agents/${north.agentId}/publish`, {})).status).toBe(
      200,
    );

    const before = await authority(slice, north, c2);
    const tenantId = fromPublicId('tenant', north.tenantId);
    const ledgerBefore = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.messageLedger)
        .where(eq(schema.messageLedger.conversationId, before.control.id)),
    );
    answering.state.answer = 'You can change the address before dispatch [1].';
    const suggestion = await amina.client.post(inbox(c2, '/copilot'), {
      clientRequestId: randomUUID(),
    });
    answering.state.answer = null;
    expect(suggestion.status, JSON.stringify(suggestion.body)).toBe(200);
    expect(suggestion.body).toMatchObject({
      text: 'You can change the address before dispatch [1].',
      agentName: expect.any(String),
      sources: [
        expect.objectContaining({
          type: 'source',
          title: 'Delivery changes',
          url: 'https://kb.example/delivery',
        }),
      ],
    });
    expect(suggestion.body.id).toMatch(/^run_/);
    // Internal notes never reach the model, and the knowledge did.
    expect(answering.state.lastPrompt).toContain('Delivery address');
    expect(answering.state.lastPrompt).not.toContain('courier delayed');
    expect(answering.state.lastPrompt).not.toContain('VIP customer');

    // Nothing was written to the conversation.
    await slice.drain();
    const after = await authority(slice, north, c2);
    expect(after.messages.length).toBe(before.messages.length);
    const ledgerAfter = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.messageLedger)
        .where(eq(schema.messageLedger.conversationId, before.control.id)),
    );
    expect(ledgerAfter.length).toBe(ledgerBefore.length);
    const [run] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, fromPublicId('run', suggestion.body.id))),
    );
    expect(run).toMatchObject({ kind: 'draft', outcome: 'drafted' });

    // "Send as me" is the person's own reply, through the ownership-checked send.
    const sent = await amina.client.post(`/v1/conversations/${c2}/messages`, {
      clientMessageId: randomUUID(),
      text: 'You can change the address before dispatch.',
      suggestionId: suggestion.body.id,
      expectedEpoch: await epochOf(amina.client, c2),
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    expect((await audits(slice, north, c2)).map((a) => a.action)).toContain(
      'conversation.copilot_reply_sent',
    );
    // People who may not reply cannot ask for suggestions either.
    expect(
      (await ana.client.post(inbox(c2, '/copilot'), { clientRequestId: randomUUID() })).status,
    ).toBe(403);
  });
});

describe('tenant isolation', () => {
  it('treats another tenant’s conversation ids as not found on every inbox route', async () => {
    const outsider = south.owner;
    const probes: Array<[string, string, unknown?]> = [
      ['GET', inbox(c1)],
      ['GET', inbox(c1, '/messages')],
      ['GET', inbox(c1, '/assignees')],
      ['GET', inbox(c1, '/tags')],
      ['GET', inbox(c1, '/fields')],
      ['GET', inbox(c1, '/saved-replies')],
      ['GET', inbox(c1, '/customer')],
      ['GET', inbox(c1, '/drafts')],
      ['GET', inbox(c1, '/links')],
      ['GET', inbox(c1, '/reviews')],
      ['POST', inbox(c1, '/assign'), { to: { kind: 'me' } }],
      ['POST', inbox(c1, '/status'), { status: 'resolved' }],
      ['POST', inbox(c1, '/presence'), { state: 'viewing' }],
      ['POST', inbox(c1, '/copilot'), { clientRequestId: randomUUID() }],
      ['POST', inbox(c1, '/transfer-request'), { clientRequestId: randomUUID() }],
      ['PUT', inbox(c1, '/tags'), { labels: [] }],
      ['PUT', inbox(c1, '/drafts/public'), { text: 'x' }],
      ['POST', `/v1/conversations/${c1}/messages`, { clientMessageId: randomUUID(), text: 'x' }],
    ];
    for (const [method, path, body] of probes) {
      const reply = await outsider.request(
        method as 'GET',
        path,
        body === undefined ? {} : { body },
      );
      expect(reply.status, `${method} ${path}`).toBe(404);
    }
    const list = await outsider.get('/v1/inbox/conversations?queue=all');
    expect(ids(list.body)).not.toContain(c1);
    const search = await outsider.get('/v1/inbox/search?q=HM-2048');
    expect(search.body).toMatchObject({ conversations: [], messages: [] });
    const bulk = await outsider.post('/v1/inbox/bulk', {
      conversationIds: [c1],
      action: { type: 'status', status: 'resolved' },
    });
    expect(bulk.body.results).toEqual([
      expect.objectContaining({ conversationId: c1, outcome: 'failed', code: 'NOT_FOUND' }),
    ]);
    expect((await authority(slice, north, c1)).state.status).not.toBe('resolved');
  });
});
