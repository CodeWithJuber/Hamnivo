import { randomUUID } from 'node:crypto';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityRegistry } from '../src/authority/registry.js';
import { connectedTenant, hookedModel, type Slice, startSlice, Visitor } from './slice-harness.js';

const hooked = hookedModel();
let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;
let visitor: Visitor;

async function runtimeAndRef(conversationPublicId: string) {
  const [control] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.conversationControls)
      .where(
        eq(schema.conversationControls.id, fromPublicId('conversation', conversationPublicId)),
      ),
  );
  if (!control) throw new Error('control missing');
  const runtime = await slice.worker
    .get(AuthorityRegistry)
    .get(tenantId, fromPublicId('connection', shop.connection.id));
  return { runtime, ref: String(control.externalConversationId), control };
}

async function authorityMessages(conversationPublicId: string) {
  const [control] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.conversationControls)
      .where(
        eq(schema.conversationControls.id, fromPublicId('conversation', conversationPublicId)),
      ),
  );
  if (!control) throw new Error('control missing');
  const runtime = await slice.worker
    .get(AuthorityRegistry)
    .get(tenantId, fromPublicId('connection', shop.connection.id));
  return runtime.authority.listMessages(String(control.externalConversationId), {
    view: 'staff',
  });
}

beforeAll(async () => {
  slice = await startSlice({ model: hooked.model });
  shop = await connectedTenant(slice, 'flow');
  tenantId = fromPublicId('tenant', shop.tenantId);
  visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  await visitor.open();
});

afterAll(async () => {
  await slice?.close();
});

describe('one AI reply per burst of messages (R05)', () => {
  it('answers once, after the last message, when the customer writes again mid-reply', async () => {
    const started = await visitor.call('POST', '/v1/widget/conversations', {
      clientMessageId: randomUUID(),
      firstMessage: 'Assalamu alaikum',
    });
    expect(started.status).toBe(201);
    const id = started.body.id as string;
    hooked.state.during = async () => {
      const again = await visitor.call('POST', `/v1/widget/conversations/${id}/messages`, {
        clientMessageId: randomUUID(),
        parts: [{ type: 'text', text: 'Where is my order 1042?' }],
      });
      expect(again.status).toBe(202);
    };
    await slice.drain();

    const messages = await authorityMessages(id);
    const replies = messages.filter((m) => m.sender.kind === 'bot' && !m.private);
    expect(replies).toHaveLength(1);
    const last = messages.filter((m) => !m.private && m.direction !== 'activity').at(-1);
    expect(last?.sender.kind).toBe('bot');

    const runs = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.conversationId, fromPublicId('conversation', id))),
    );
    expect(runs.map((r) => r.outcome).sort()).toEqual(['replied', 'skipped']);
    const skipped = runs.find((r) => r.outcome === 'skipped');
    const steps = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.runSteps)
        .where(eq(schema.runSteps.runId, skipped?.id ?? '')),
    );
    expect(steps.map((s) => s.name)).toContain('superseded');
  });
});

describe('feedback and reopen (W15)', () => {
  it('rates a resolved conversation, shows staff the rating and reopens it', async () => {
    const started = await visitor.call('POST', '/v1/widget/conversations', {
      clientMessageId: randomUUID(),
      firstMessage: 'Can I pay on delivery?',
    });
    const id = started.body.id as string;
    await slice.drain();
    const early = await visitor.call('POST', `/v1/widget/conversations/${id}/feedback`, {
      rating: 5,
    });
    expect(early.status).toBe(422);

    const stream = visitor.stream(id);
    await stream.ready;
    const { runtime, ref } = await runtimeAndRef(id);
    await runtime.authority.setStatus(ref, 'resolved', { kind: 'integration' });
    await slice.drain();
    await stream.until((s) => s.events.some((e) => e.type === 'conversation.resolved'));

    const rated = await visitor.call('POST', `/v1/widget/conversations/${id}/feedback`, {
      rating: 4,
      comment: '  Quick and kind  ',
    });
    expect(rated.status).toBe(204);
    const again = await visitor.call('POST', `/v1/widget/conversations/${id}/feedback`, {
      rating: 5,
    });
    expect(again.status).toBe(204);
    await slice.drain();
    const stored = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.conversationFeedback)
        .where(eq(schema.conversationFeedback.conversationId, fromPublicId('conversation', id))),
    );
    expect(stored).toEqual([expect.objectContaining({ rating: 5, comment: null })]);
    const notes = (await authorityMessages(id)).filter((m) => m.private).map((m) => m.text);
    expect(notes).toContain('Customer rating: 4 out of 5. Comment: “Quick and kind”');
    expect(notes).toContain('Customer rating: 5 out of 5.');

    const stranger = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
    await stranger.open();
    expect(
      (await stranger.call('POST', `/v1/widget/conversations/${id}/feedback`, { rating: 1 }))
        .status,
    ).toBe(404);
    expect((await stranger.call('POST', `/v1/widget/conversations/${id}/reopen`)).status).toBe(404);

    const reopened = await visitor.call('POST', `/v1/widget/conversations/${id}/reopen`);
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ status: 'open', responder: 'ai' });
    expect((await runtime.authority.getState(ref)).status).toBe('pending');
    await stream.until((s) => s.events.some((e) => e.type === 'conversation.reopened'));
    const twice = await visitor.call('POST', `/v1/widget/conversations/${id}/reopen`);
    expect(twice.status).toBe(200);
    await slice.drain();
    expect(stream.events.filter((e) => e.type === 'conversation.reopened')).toHaveLength(1);
    stream.close();
  });
});

describe('honest availability (W11)', () => {
  const allDay = [{ open: '00:00', close: '24:00' }];
  const everyDay = {
    sun: allDay,
    mon: allDay,
    tue: allDay,
    wed: allDay,
    thu: allDay,
    fri: allDay,
    sat: allDay,
  };
  const setHours = (businessHours: unknown) =>
    shop.owner.put(`/v1/admin/brands/${shop.brand.id}/business-hours`, { businessHours });
  const today = () => new Date().toISOString().slice(0, 10);
  const tomorrow = () =>
    `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`;

  it('says when people are away and when they are back, and hands off honestly', async () => {
    const closed = await setHours({ timezone: 'UTC', weekly: everyDay, closedDates: [today()] });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.businessHours).toMatchObject({ timezone: 'UTC', closedDates: [today()] });

    const guest = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
    const session = await guest.open();
    expect(session.config.availability).toEqual({
      humanAvailable: false,
      nextOpenAt: tomorrow(),
      timezone: 'UTC',
      staffOnline: expect.any(Boolean),
      hoursSet: true,
      open: false,
    });
    const started = await guest.call('POST', '/v1/widget/conversations', {
      clientMessageId: randomUUID(),
      firstMessage: 'Is anyone there?',
    });
    await slice.drain();
    const handoff = await guest.call(
      'POST',
      `/v1/widget/conversations/${started.body.id}/handoff`,
      { clientRequestId: randomUUID() },
    );
    expect(handoff.status).toBe(200);
    expect(handoff.body).toMatchObject({
      availability: 'offline',
      followUp: { channel: 'this_chat', expectedBy: tomorrow() },
    });
    expect(handoff.body.message).toMatch(/^Our team is away right now and answers again /);
  });

  it('reports people as available during hours, and nothing when no hours are set', async () => {
    expect((await setHours({ timezone: 'Asia/Karachi', weekly: everyDay })).status).toBe(200);
    const open = await new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin).open();
    expect(open.config.availability).toEqual({
      humanAvailable: true,
      nextOpenAt: null,
      timezone: 'Asia/Karachi',
      staffOnline: expect.any(Boolean),
      hoursSet: true,
      open: true,
    });
    expect((await setHours(null)).body.businessHours).toBeNull();
    const unknown = await new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin).open();
    expect(unknown.config.availability).toEqual({
      humanAvailable: false,
      nextOpenAt: null,
      timezone: 'UTC',
      staffOnline: expect.any(Boolean),
      hoursSet: false,
      open: false,
    });
  });

  it('refuses hours that cannot be right', async () => {
    const week = (day: unknown) => ({ ...everyDay, mon: day });
    for (const bad of [
      { timezone: 'Mars/Olympus', weekly: everyDay },
      { timezone: 'UTC', weekly: week([{ open: '17:00', close: '09:00' }]) },
      { timezone: 'UTC', weekly: week([{ open: '9:00', close: '17:00' }]) },
      {
        timezone: 'UTC',
        weekly: week([
          { open: '09:00', close: '13:00' },
          { open: '12:00', close: '17:00' },
        ]),
      },
      { timezone: 'UTC', weekly: everyDay, closedDates: ['2026-13-01'] },
    ]) {
      expect((await setHours(bad)).status, JSON.stringify(bad)).toBe(422);
    }
  });
});

describe('going back to the assistant (HNV-10-02, HNV-10-05)', () => {
  const start = async (who: Visitor, text: string) => {
    const started = await who.call('POST', '/v1/widget/conversations', {
      clientMessageId: randomUUID(),
      firstMessage: text,
    });
    await slice.drain();
    return started.body.id as string;
  };
  const askForPerson = (who: Visitor, id: string) =>
    who.call('POST', `/v1/widget/conversations/${id}/handoff`, { clientRequestId: randomUUID() });
  const cancel = (who: Visitor, id: string) =>
    who.call('POST', `/v1/widget/conversations/${id}/handoff/cancel`);
  const inbox = (id: string, rest = '') => `/v1/inbox/conversations/${id}${rest}`;

  it('returns the chat to the assistant while nobody has taken it, and tells staff', async () => {
    const id = await start(visitor, 'Where is my parcel?');
    expect((await askForPerson(visitor, id)).status).toBe(200);
    const waiting = await visitor.call('GET', `/v1/widget/conversations/${id}`);
    expect(waiting.body).toMatchObject({
      status: 'waiting_for_person',
      canReturnToAssistant: true,
    });

    const back = await cancel(visitor, id);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body).toMatchObject({
      outcome: 'with_assistant',
      message: 'You’re chatting with the assistant again. You can ask for a person at any time.',
      conversation: { status: 'open', responder: 'ai', canReturnToAssistant: false },
    });
    // Staff see why the chat left their queue.
    await slice.drain();
    const notes = (await authorityMessages(id)).filter((m) => m.private).map((m) => m.text);
    expect(notes).toContainEqual(
      expect.stringContaining(
        'The customer no longer needs a person: they went back to the assistant',
      ),
    );
    const detail = await shop.owner.get(inbox(id));
    expect(detail.body).toMatchObject({ ownerMode: 'AI_ACTIVE', ownerReason: 'return_to_ai' });

    // A second tap (or another tab) changes nothing.
    expect((await cancel(visitor, id)).body.outcome).toBe('with_assistant');
  });

  it('says so when a person took the chat first', async () => {
    const id = await start(visitor, 'I need help with an invoice');
    await askForPerson(visitor, id);
    const claimed = await shop.owner.post(inbox(id, '/assign'), { to: { kind: 'me' } });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect((await visitor.call('GET', `/v1/widget/conversations/${id}`)).body).toMatchObject({
      status: 'with_person',
      canReturnToAssistant: false,
    });
    const late = await cancel(visitor, id);
    expect(late.body).toMatchObject({
      outcome: 'person_joined',
      message: 'A person from our team has already joined this chat.',
      conversation: { status: 'with_person' },
    });
    expect((await shop.owner.get(inbox(id))).body.ownerMode).toBe('HUMAN_ACTIVE');
  });

  it('keeps the chat with people when they, not the customer, put it in the queue', async () => {
    const id = await start(visitor, 'Hello');
    const queued = await shop.owner.post(inbox(id, '/assign'), { to: { kind: 'queue' } });
    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    expect((await visitor.call('GET', `/v1/widget/conversations/${id}`)).body).toMatchObject({
      status: 'waiting_for_person',
      canReturnToAssistant: false,
    });
    const refused = await cancel(visitor, id);
    expect(refused.body).toMatchObject({
      outcome: 'with_people',
      message: 'This chat stays with our team. A person will answer you here.',
      conversation: { status: 'waiting_for_person' },
    });
    expect((await shop.owner.get(inbox(id))).body.ownerMode).toBe('WAITING_HUMAN');
  });

  it('answers in the customer’s language, and only for their own chat', async () => {
    const id = await start(visitor, 'مرحبا');
    await askForPerson(visitor, id);
    const stranger = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
    await stranger.open();
    expect((await cancel(stranger, id)).status).toBe(404);
    const arabic = await visitor.call(
      'POST',
      `/v1/widget/conversations/${id}/handoff/cancel`,
      undefined,
      { 'accept-language': 'ar' },
    );
    expect(arabic.body.message).toBe('أنت تتحدث مع المساعد مرة أخرى. يمكنك طلب شخص في أي وقت.');
  });
});
