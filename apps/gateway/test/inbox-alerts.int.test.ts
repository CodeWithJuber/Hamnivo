import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import type { Client } from './harness.js';
import { customerStarts, join, type Shop, StaffStream } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

let slice: Slice;
let desk: Shop;
/** A second brand of the same tenant. */
let outlet: Shop;
let amina: { client: Client; staffId: string };
let rayan: { client: Client; staffId: string };
let ana: { client: Client; staffId: string };

const inbox = (id: string, rest = '') => `/v1/inbox/conversations/${id}${rest}`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const agents = await desk.owner.get('/v1/admin/agents');
  const agentId = agents.body.items.find((a: { brandId: string }) => a.brandId === brand.body.id)
    ?.id as string;
  await desk.owner.post(`/v1/admin/agents/${agentId}/publish`, {});
  outlet = {
    ...desk,
    agentId,
    brand: brand.body,
    connection: connection.body,
    hostOrigin: 'https://outlet.example',
  };
  // Amina answers the first brand only; Rayan answers everywhere; Ana may read but not answer.
  amina = await join(slice, desk, 'Amina Agent', 'agent', { type: 'brand', id: desk.brand.id });
  rayan = await join(slice, desk, 'Rayan Lead', 'supervisor');
  ana = await join(slice, desk, 'Ana Analyst', 'analyst');
});

afterAll(async () => {
  await slice?.close();
});

/** The customer asks for a person; returns what the widget is told. */
async function asksForPerson(visitor: Visitor, conversationId: string) {
  const handoff = await visitor.call('POST', `/v1/widget/conversations/${conversationId}/handoff`, {
    clientRequestId: randomUUID(),
  });
  expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
  return handoff.body as { availability: string; message: string; followUp: unknown };
}

async function writes(visitor: Visitor, conversationId: string, text: string) {
  const sent = await visitor.call('POST', `/v1/widget/conversations/${conversationId}/messages`, {
    clientMessageId: randomUUID(),
    parts: [{ type: 'text', text }],
  });
  expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
}

/** A conversation as one staff member sees it in the queue list. */
async function rowOf(client: Client, conversationId: string) {
  const list = await client.get('/v1/inbox/conversations?queue=all&limit=50');
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  return list.body.items.find((item: { id: string }) => item.id === conversationId);
}

async function unreadChats(client: Client): Promise<number> {
  const unread = await client.get('/v1/inbox/unread');
  expect(unread.status, JSON.stringify(unread.body)).toBe(200);
  return unread.body.chats as number;
}

async function claim(client: Client, conversationId: string) {
  const detail = await client.get(inbox(conversationId));
  const claimed = await client.post(inbox(conversationId, '/assign'), {
    to: { kind: 'me' },
    expectedEpoch: detail.body.ownershipEpoch,
  });
  expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
}

function open(...clients: Client[]): StaffStream[] {
  const streams = clients.map((client) => new StaffStream(slice.baseUrl, client));
  onTestFinished(() => {
    for (const stream of streams) stream.close();
  });
  return streams;
}

describe('sounds and desktop alerts, per person', () => {
  it('starts from sensible defaults and keeps what each person chose', async () => {
    const first = await amina.client.get('/v1/inbox/preferences');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.alerts).toEqual({
      sounds: {
        muted: false,
        volume: 60,
        newChat: 'chime',
        customerMessage: 'pop',
        assigned: 'bell',
      },
      desktop: { enabled: true, showPreview: true },
    });

    const changed = await amina.client.patch('/v1/inbox/preferences', {
      sounds: { volume: 30, muted: true, assigned: 'none' },
      desktop: { showPreview: false },
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.alerts).toEqual({
      sounds: {
        muted: true,
        volume: 30,
        newChat: 'chime',
        customerMessage: 'pop',
        assigned: 'none',
      },
      desktop: { enabled: true, showPreview: false },
    });

    // Kept for next time, and for her only.
    expect((await amina.client.get('/v1/inbox/preferences')).body.alerts.sounds.volume).toBe(30);
    expect((await rayan.client.get('/v1/inbox/preferences')).body.alerts.sounds).toMatchObject({
      muted: false,
      volume: 60,
    });
    // A later change touches only what it names.
    const later = await amina.client.patch('/v1/inbox/preferences', {
      sounds: { newChat: 'drop' },
    });
    expect(later.body.alerts.sounds).toMatchObject({ newChat: 'drop', volume: 30, muted: true });
  });

  it('refuses a change that is empty, out of range or names a sound that does not exist', async () => {
    for (const body of [{}, { sounds: { volume: 101 } }, { sounds: { volume: -1 } }]) {
      const refused = await amina.client.patch('/v1/inbox/preferences', body);
      expect(refused.status, JSON.stringify(body)).toBe(422);
    }
    const unknown = await amina.client.patch('/v1/inbox/preferences', {
      sounds: { newChat: 'siren' },
    });
    expect(unknown.status).toBe(422);
    // Nothing changed.
    expect((await amina.client.get('/v1/inbox/preferences')).body.alerts.sounds.volume).toBe(30);
  });

  it('is open to everyone who can read the inbox, and to nobody else', async () => {
    expect(
      (await ana.client.patch('/v1/inbox/preferences', { sounds: { muted: true } })).status,
    ).toBe(200);
    expect((await ana.client.get('/v1/inbox/preferences')).body.alerts.sounds.muted).toBe(true);
    const outsider = await desk.owner.get('/v1/inbox/preferences', { tenant: null });
    expect(outsider.status).not.toBe(200);
  });
});

describe('online, away and offline', () => {
  it('follows Studio’s signs of life and the person’s own choice', async () => {
    // Nobody has Studio open yet, so nobody is online, whatever they chose.
    expect((await amina.client.get('/v1/inbox/preferences')).body.availability).toEqual({
      choice: 'online',
      effective: 'offline',
    });
    const active = await amina.client.post('/v1/inbox/availability/ping', { active: true });
    expect(active.body).toEqual({ choice: 'online', effective: 'online' });
    // Studio is open but nobody touches it: away.
    const idle = await amina.client.post('/v1/inbox/availability/ping', { active: false });
    expect(idle.body).toEqual({ choice: 'online', effective: 'away' });
    const away = await amina.client.put('/v1/inbox/availability', { status: 'away' });
    expect(away.body).toEqual({ choice: 'away', effective: 'away' });
    const offline = await amina.client.put('/v1/inbox/availability', { status: 'offline' });
    expect(offline.body).toEqual({ choice: 'offline', effective: 'offline' });
    // Choosing online is a sign of life too.
    const back = await amina.client.put('/v1/inbox/availability', { status: 'online' });
    expect(back.body).toEqual({ choice: 'online', effective: 'online' });
    expect((await amina.client.put('/v1/inbox/availability', { status: 'busy' })).status).toBe(422);
    expect((await amina.client.post('/v1/inbox/availability/ping', {})).status).toBe(422);
  });

  it('shows each person’s status when choosing who to assign a chat to', async () => {
    const { conversationId } = await customerStarts(slice, desk, 'Which size is the blue shirt?');
    await slice.drain();
    const options = await rayan.client.get(inbox(conversationId, '/assignees'));
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    const status = (name: string) =>
      options.body.staff.find((person: { displayName: string }) => person.displayName === name)
        ?.status;
    // Amina has Studio open; Rayan has not been heard from.
    expect(status('Amina Agent')).toBe('online');
    expect(status('Rayan Lead')).toBe('offline');
  });
});

describe('telling the customer a person is available', () => {
  it('says so only when someone who can answer that brand is online right now', async () => {
    await amina.client.put('/v1/inbox/availability', { status: 'online' });
    const first = await customerStarts(slice, desk, 'Is anyone there?');
    const online = await asksForPerson(first.visitor, first.conversationId);
    expect(online).toMatchObject({ availability: 'person_available', followUp: null });
    expect(online.message).toContain('online');

    // Amina answers the first brand only: nobody is online for the other one.
    const other = await customerStarts(slice, outlet, 'Hello from the outlet');
    expect(await asksForPerson(other.visitor, other.conversationId)).toMatchObject({
      availability: 'queued',
    });

    // Away or offline is not available.
    for (const status of ['away', 'offline'] as const) {
      await amina.client.put('/v1/inbox/availability', { status });
      const next = await customerStarts(slice, desk, `Still there? (${status})`);
      expect(await asksForPerson(next.visitor, next.conversationId)).toMatchObject({
        availability: 'queued',
      });
    }
    await amina.client.put('/v1/inbox/availability', { status: 'online' });
    await slice.drain();
  });
});

describe('unread chats', () => {
  it('counts customer messages after the person’s own read marker, for chats that need them', async () => {
    const { visitor, conversationId } = await customerStarts(
      slice,
      desk,
      'Where is my order HM-2048?',
    );
    await slice.drain();
    const aminaBefore = await unreadChats(amina.client);
    const rayanBefore = await unreadChats(rayan.client);
    // The AI is answering this chat: nobody has anything to read.
    expect((await rowOf(amina.client, conversationId)).unreadCount).toBe(0);

    await asksForPerson(visitor, conversationId);
    await slice.drain();
    expect((await rowOf(amina.client, conversationId)).unreadCount).toBe(1);
    expect((await rowOf(rayan.client, conversationId)).unreadCount).toBe(1);
    expect((await amina.client.get(inbox(conversationId))).body.unreadCount).toBe(1);
    expect(await unreadChats(amina.client)).toBe(aminaBefore + 1);
    expect(await unreadChats(rayan.client)).toBe(rayanBefore + 1);
    // Someone who may read but not answer has nothing to attend to.
    expect((await rowOf(ana.client, conversationId)).unreadCount).toBe(0);
    expect(await unreadChats(ana.client)).toBe(0);

    // Reading is the person's own: Rayan still has it unread.
    const read = await amina.client.post(inbox(conversationId, '/read'));
    expect(read.status, JSON.stringify(read.body)).toBe(204);
    expect((await rowOf(amina.client, conversationId)).unreadCount).toBe(0);
    expect(await unreadChats(amina.client)).toBe(aminaBefore);
    expect((await rowOf(rayan.client, conversationId)).unreadCount).toBe(1);
    expect(await unreadChats(rayan.client)).toBe(rayanBefore + 1);

    // A new message after the marker is unread again, for both.
    await writes(visitor, conversationId, 'Hello? Anyone?');
    await slice.drain();
    expect((await rowOf(amina.client, conversationId)).unreadCount).toBe(1);
    expect((await rowOf(rayan.client, conversationId)).unreadCount).toBe(2);

    // Reading twice changes nothing; a chat that is a colleague's is not unread for the others.
    await amina.client.post(inbox(conversationId, '/read'));
    await claim(amina.client, conversationId);
    await slice.drain();
    expect((await rowOf(amina.client, conversationId)).unreadCount).toBe(0);
    await writes(visitor, conversationId, 'Thank you');
    await slice.drain();
    expect((await rowOf(amina.client, conversationId)).unreadCount).toBe(1);
    expect((await rowOf(rayan.client, conversationId)).unreadCount).toBe(0);
    expect(await unreadChats(rayan.client)).toBe(rayanBefore);
  });

  it('cannot be marked for a chat the person cannot see', async () => {
    const { conversationId } = await customerStarts(slice, outlet, 'Do you have the olive bag?');
    await slice.drain();
    expect((await amina.client.post(inbox(conversationId, '/read'))).status).toBe(404);
    expect((await rayan.client.post(inbox(conversationId, '/read'))).status).toBe(204);
  });

  it('tells the person’s other windows, and nobody else’s, that a chat was read', async () => {
    const { visitor, conversationId } = await customerStarts(slice, desk, 'Can I pay on delivery?');
    await asksForPerson(visitor, conversationId);
    await slice.drain();
    const [aminaOther, rayanStream] = open(amina.client, rayan.client);
    await Promise.all([aminaOther?.ready, rayanStream?.ready]);
    await amina.client.post(inbox(conversationId, '/read'));
    await aminaOther?.until((s) => s.changed().includes(conversationId));
    await pause(600);
    expect(rayanStream?.changed()).not.toContain(conversationId);
  });
});

describe('alerts on the inbox stream', () => {
  it('reaches the people who can answer the chat, once each, with what the customer wrote', async () => {
    const [aminaStream, rayanStream, anaStream] = open(amina.client, rayan.client, ana.client);
    await Promise.all([aminaStream?.ready, rayanStream?.ready, anaStream?.ready]);
    const alertsFor = (stream: StaffStream | undefined, conversationId: string) =>
      (stream?.events('alert') ?? []).filter((alert) => alert.conversationId === conversationId);

    // A chat the AI is answering alerts nobody.
    const first = await customerStarts(slice, desk, 'Where is my order HM-3001?');
    await slice.drain();
    await aminaStream?.until((s) => s.changed().includes(first.conversationId));
    expect(alertsFor(aminaStream, first.conversationId)).toEqual([]);

    // The customer asks for a person: a chat is waiting.
    await asksForPerson(first.visitor, first.conversationId);
    await slice.drain();
    await aminaStream?.until((s) => alertsFor(s, first.conversationId).length > 0);
    await rayanStream?.until((s) => alertsFor(s, first.conversationId).length > 0);
    expect(alertsFor(aminaStream, first.conversationId)).toEqual([
      {
        type: 'alert',
        kind: 'chat_waiting',
        conversationId: first.conversationId,
        customerName: 'Visitor',
        preview: 'Where is my order HM-3001?',
        at: expect.any(String),
      },
    ]);
    expect(alertsFor(rayanStream, first.conversationId).map((a) => a.kind)).toEqual([
      'chat_waiting',
    ]);
    // Ana may read the chat but not answer it: her inbox updates, she is not alerted.
    await anaStream?.until((s) => s.changed().includes(first.conversationId));
    expect(anaStream?.events('alert')).toEqual([]);

    // Amina takes it: no alert for her own action, none for Rayan (it is hers now).
    await claim(amina.client, first.conversationId);
    await slice.drain();
    const seen = rayanStream?.changed().length ?? 0;
    await rayanStream?.until((s) => s.changed().length > seen);

    // The customer writes: the owner is alerted, a colleague is not.
    await writes(first.visitor, first.conversationId, 'Any news about my parcel?');
    await slice.drain();
    await aminaStream?.until((s) =>
      alertsFor(s, first.conversationId).some((alert) => alert.kind === 'customer_message'),
    );
    expect(alertsFor(aminaStream, first.conversationId).map((a) => a.kind)).toEqual([
      'chat_waiting',
      'customer_message',
    ]);
    expect(
      alertsFor(aminaStream, first.conversationId).find((a) => a.kind === 'customer_message'),
    ).toMatchObject({ preview: 'Any news about my parcel?', customerName: 'Visitor' });
    await pause(600);
    expect(alertsFor(rayanStream, first.conversationId).map((a) => a.kind)).toEqual([
      'chat_waiting',
    ]);

    // Someone else gives Amina a chat that is waiting: only she is told, as an assignment.
    const second = await customerStarts(slice, desk, 'Do you ship to Lahore?');
    await asksForPerson(second.visitor, second.conversationId);
    await slice.drain();
    await rayanStream?.until((s) => alertsFor(s, second.conversationId).length > 0);
    const detail = await rayan.client.get(inbox(second.conversationId));
    const assigned = await rayan.client.post(inbox(second.conversationId, '/assign'), {
      to: { kind: 'staff', staffMemberId: amina.staffId },
      expectedEpoch: detail.body.ownershipEpoch,
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    await slice.drain();
    await aminaStream?.until((s) =>
      alertsFor(s, second.conversationId).some((alert) => alert.kind === 'assigned'),
    );
    expect(alertsFor(aminaStream, second.conversationId).map((a) => a.kind)).toEqual([
      'chat_waiting',
      'assigned',
    ]);
    await pause(600);
    expect(alertsFor(rayanStream, second.conversationId).map((a) => a.kind)).toEqual([
      'chat_waiting',
    ]);

    // Another brand: Amina cannot see it, so she hears nothing; Rayan does.
    const outletChat = await customerStarts(slice, outlet, 'Is the olive bag back in stock?');
    await asksForPerson(outletChat.visitor, outletChat.conversationId);
    await slice.drain();
    await rayanStream?.until((s) => alertsFor(s, outletChat.conversationId).length > 0);
    await pause(600);
    expect(alertsFor(aminaStream, outletChat.conversationId)).toEqual([]);
    expect(aminaStream?.changed()).not.toContain(outletChat.conversationId);

    // However many times a chat changed, each alert came once.
    const kinds = (aminaStream?.events('alert') ?? []).map((a) => `${a.conversationId}:${a.kind}`);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

describe('typing', () => {
  it('shows staff when the customer is typing, and when they stop', async () => {
    const { visitor, conversationId } = await customerStarts(slice, desk, 'Hi there');
    await slice.drain();
    const [aminaStream, rayanStream] = open(amina.client, rayan.client);
    await Promise.all([aminaStream?.ready, rayanStream?.ready]);
    const typing = (stream: StaffStream | undefined) =>
      (stream?.events('customer_typing') ?? []).filter((e) => e.conversationId === conversationId);

    const started = await visitor.call(
      'POST',
      `/v1/widget/conversations/${conversationId}/typing`,
      {
        typing: true,
      },
    );
    expect(started.status, JSON.stringify(started.body)).toBe(204);
    await aminaStream?.until((s) => typing(s).some((e) => e.typing === true));
    await rayanStream?.until((s) => typing(s).some((e) => e.typing === true));
    expect((await amina.client.get(inbox(conversationId))).body.customerTyping).toBe(true);

    // Reporting again before the pause is over changes nothing.
    await visitor.call('POST', `/v1/widget/conversations/${conversationId}/typing`, {
      typing: true,
    });

    const stopped = await visitor.call(
      'POST',
      `/v1/widget/conversations/${conversationId}/typing`,
      {
        typing: false,
      },
    );
    expect(stopped.status).toBe(204);
    await aminaStream?.until((s) => typing(s).some((e) => e.typing === false));
    expect((await amina.client.get(inbox(conversationId))).body.customerTyping).toBe(false);
    expect(typing(aminaStream).map((e) => e.typing)).toEqual([true, false]);
  });

  it('keeps the signal inside the conversation: other customers and other brands never get it', async () => {
    const { visitor, conversationId } = await customerStarts(slice, outlet, 'Hello outlet');
    await slice.drain();
    const [aminaStream, rayanStream] = open(amina.client, rayan.client);
    await Promise.all([aminaStream?.ready, rayanStream?.ready]);
    await visitor.call('POST', `/v1/widget/conversations/${conversationId}/typing`, {
      typing: true,
    });
    await rayanStream?.until((s) =>
      s.events('customer_typing').some((e) => e.conversationId === conversationId),
    );
    await pause(600);
    // Amina cannot see this brand's chats.
    expect(aminaStream?.events('customer_typing')).toEqual([]);

    // Another customer cannot report typing in this conversation; the body must be well formed.
    const stranger = new Visitor(slice.baseUrl, outlet.brand.widgetId, outlet.hostOrigin);
    await stranger.open();
    const denied = await stranger.call(
      'POST',
      `/v1/widget/conversations/${conversationId}/typing`,
      { typing: true },
    );
    expect(denied.status).toBe(404);
    const malformed = await visitor.call(
      'POST',
      `/v1/widget/conversations/${conversationId}/typing`,
      { typing: 'yes' },
    );
    expect(malformed.status).toBe(422);
  });

  it('shows the customer when a person is writing a reply, never for a private note', async () => {
    const { visitor, conversationId } = await customerStarts(slice, desk, 'Is this in stock?');
    await slice.drain();
    await claim(amina.client, conversationId);
    await slice.drain();
    const stream = visitor.stream(conversationId);
    onTestFinished(() => stream.close());
    // The first heartbeat comes once the stream is fully set up.
    await stream.until((s) => s.controls.some((frame) => frame.control === 'heartbeat'));
    const typingEvents = () => stream.events.filter((event) => event.type === 'typing');

    // A private note is not a reply, and Ana cannot reply: the customer hears nothing of either.
    await amina.client.post(inbox(conversationId, '/presence'), {
      state: 'typing',
      lane: 'internal',
    });
    await ana.client.post(inbox(conversationId, '/presence'), { state: 'typing', lane: 'public' });
    await amina.client.post(inbox(conversationId, '/presence'), { state: 'viewing' });

    await amina.client.post(inbox(conversationId, '/presence'), {
      state: 'typing',
      lane: 'public',
    });
    await stream.until(() => typingEvents().length > 0);
    expect(typingEvents()).toHaveLength(1);
    expect(typingEvents()[0]).toMatchObject({
      type: 'typing',
      lane: 'customer',
      sequence: null,
      conversationId,
      data: {
        participantId: expect.stringMatching(/^prt_/),
        displayName: 'Amina Agent',
        typing: true,
      },
    });
    // A live signal: it has no id, so it never moves the customer's place in the conversation.
    const message = stream.messages.find((m) => m.event === 'typing');
    expect(message?.id).toBeUndefined();

    await amina.client.post(inbox(conversationId, '/presence'), { state: 'left' });
    await stream.until(() => typingEvents().length > 1);
    expect(typingEvents().map((event) => event.data.typing)).toEqual([true, false]);
    // Never the staff member's own id.
    expect(JSON.stringify(typingEvents())).not.toContain(amina.staffId);
  });
});
