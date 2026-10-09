import { randomUUID } from 'node:crypto';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_TOPIC } from '../src/automations/events.js';
import { authority, join } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/**
 * Automations (G21), end to end: rules edited, published and versioned through the admin API;
 * website rules handed to the loader; chat rules run by the worker against the fake Chatwoot.
 */

type Json = Record<string, any>;

let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;
let teamId: string;

const waiting = { field: 'owner', op: 'is', value: ['waiting'] };
const notAi = { field: 'owner', op: 'is_not', value: ['ai'] };
const welcome = {
  event: { type: 'chat_started' },
  conditions: [waiting],
  actions: [
    {
      type: 'send_message',
      message: { en: 'Thanks for writing. Someone will reply shortly.', ar: 'شكرًا لرسالتك.' },
    },
  ],
};
const pricingPrompt = {
  event: { type: 'page_view', seconds: 30 },
  conditions: [{ field: 'page_url', op: 'contains', value: '/pricing' }],
  actions: [{ type: 'show_prompt', message: { en: 'Questions about plans?' } }],
};

beforeAll(async () => {
  slice = await startSlice();
  // People answer here (no published agent), so a rule may speak to the customer.
  shop = await connectedTenant(slice, 'rules', { publishAgent: false });
  tenantId = fromPublicId('tenant', shop.tenantId);
  const team = await shop.owner.post('/v1/admin/teams', {
    name: 'Rescue',
    workspaceId: shop.workspaceId,
  });
  expect(team.status, JSON.stringify(team.body)).toBe(201);
  teamId = team.body.id;
  for (const title of ['vip', 'checkout']) {
    const tag = await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/tags`, { title });
    expect(tag.status, JSON.stringify(tag.body)).toBe(201);
  }
}, 120_000);

afterAll(async () => {
  await slice?.close();
});

const list = () => shop.owner.get(`/v1/admin/brands/${shop.brand.id}/automations`);
const create = (name: string, definition: Json, publish = true) =>
  shop.owner.post(`/v1/admin/brands/${shop.brand.id}/automations`, {
    name,
    definition,
    publish,
  });
const remove = (id: string) => shop.owner.delete(`/v1/admin/automations/${id}`);

async function published(name: string, definition: Json): Promise<string> {
  const made = await create(name, definition);
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  expect(made.body.published?.version).toBe(1);
  return made.body.id as string;
}

/** A customer writes their first message in the widget. */
async function customerWrites(text: string) {
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

async function runsOf(automationId: string) {
  const runs = await shop.owner.get(`/v1/admin/automations/${automationId}/runs`);
  expect(runs.status).toBe(200);
  return runs.body.items as Json[];
}

/** Makes the delayed automation events due now and runs the worker. */
async function waitedLong() {
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .update(schema.outboxEvents)
      .set({ availableAt: new Date(Date.now() - 1000) })
      .where(
        and(
          eq(schema.outboxEvents.topic, AUTOMATION_TOPIC),
          isNull(schema.outboxEvents.processedAt),
        ),
      ),
  );
  await slice.drain();
}

const said = (messages: { text: string | null; private: boolean }[], text: string) =>
  messages.filter((m) => m.text === text);

describe('editing automations (G21)', () => {
  it('starts empty, with the brand’s tags and teams to choose from', async () => {
    const empty = await list();
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({
      items: [],
      promptLimits: { maxPerDay: 1, dismissHours: 24 },
    });
    const options = await shop.owner.get(`/v1/admin/brands/${shop.brand.id}/automations/options`);
    expect(options.body.tags).toEqual(['checkout', 'vip']);
    expect(options.body.teams.map((t: Json) => t.id)).toContain(teamId);
  });

  it('keeps a draft as it is, and publishes only what can run', async () => {
    const risky = {
      event: { type: 'chat_started' },
      conditions: [],
      actions: [{ type: 'send_message', message: { en: 'Hi!' } }],
    };
    const draft = await create('Greeting', risky, false);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body).toMatchObject({
      id: expect.stringMatching(/^aut_/),
      kind: 'conversation',
      enabled: true,
      revision: 1,
      published: null,
      unpublishedChanges: true,
      stats: { runsThisWeek: 0, lastRunAt: null },
    });
    const id = draft.body.id as string;
    // A message could interrupt the AI unless the rule rules the AI out.
    const refused = await shop.owner.post(`/v1/admin/automations/${id}/publish`, { revision: 1 });
    expect(refused.status).toBe(422);
    expect(refused.body.fields).toEqual([
      { path: 'definition.actions.0.type', message: expect.stringContaining('AI') },
    ]);

    const saved = await shop.owner.put(`/v1/admin/automations/${id}`, {
      name: 'Greeting',
      definition: { ...risky, conditions: [notAi] },
      revision: 1,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.revision).toBe(2);
    // An editor that opened revision 1 cannot overwrite or publish blindly.
    const stale = await shop.owner.put(`/v1/admin/automations/${id}`, {
      name: 'Old',
      definition: risky,
      revision: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    const old = await shop.owner.post(`/v1/admin/automations/${id}/publish`, { revision: 1 });
    expect(old.status).toBe(409);

    const v1 = await shop.owner.post(`/v1/admin/automations/${id}/publish`, { revision: 2 });
    expect(v1.status, JSON.stringify(v1.body)).toBe(200);
    expect(v1.body.published).toMatchObject({
      version: 1,
      publishedByName: 'rules Owner',
      definition: { conditions: [notAi] },
    });
    expect(v1.body.unpublishedChanges).toBe(false);

    const edited = await shop.owner.put(`/v1/admin/automations/${id}`, {
      name: 'Greeting',
      definition: { ...risky, conditions: [waiting] },
      revision: 2,
    });
    expect(edited.body.unpublishedChanges).toBe(true);
    const v2 = await shop.owner.post(`/v1/admin/automations/${id}/publish`, { revision: 3 });
    expect(v2.body.published.version).toBe(2);

    const versions = await shop.owner.get(`/v1/admin/automations/${id}/versions`);
    expect(versions.body.items.map((v: Json) => v.version)).toEqual([2, 1]);
    const restored = await shop.owner.post(`/v1/admin/automations/${id}/versions/1/restore`, {
      revision: 3,
    });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body.draft.conditions).toEqual([notAi]);
    expect(restored.body.published.version).toBe(2);
    expect(restored.body.unpublishedChanges).toBe(true);

    // A chat rule stays in chats.
    const moved = await shop.owner.put(`/v1/admin/automations/${id}`, {
      name: 'Greeting',
      definition: pricingPrompt,
      revision: 4,
    });
    expect(moved.status).toBe(422);
    expect(moved.body.fields[0].path).toBe('definition.event.type');

    expect((await remove(id)).status).toBe(204);
    expect((await shop.owner.get(`/v1/admin/automations/${id}`)).status).toBe(404);
  });

  it('accepts only the brand’s own tags and teams', async () => {
    const bad = await create('Bad refs', {
      event: { type: 'chat_started' },
      conditions: [{ field: 'team', op: 'is', value: ['team_01j9zk7w3xq8r4t2v6m5n1p0cd'] }],
      actions: [
        { type: 'add_tag', tag: 'gold' },
        { type: 'assign_team', teamId: 'team_01j9zk7w3xq8r4t2v6m5n1p0cd' },
      ],
    });
    expect(bad.status).toBe(422);
    expect((bad.body.fields as Json[]).map((f) => f.path).sort()).toEqual([
      'definition.actions.0.tag',
      'definition.actions.1.teamId',
      'definition.conditions.0.value.0',
    ]);
  });

  it('lets supervisors read automations, and nobody without the permission', async () => {
    const id = await published('Read me', welcome);
    await shop.owner.put(`/v1/admin/automations/${id}/enabled`, { enabled: false });
    const supervisor = await join(slice, shop, 'Sara Supervisor', 'supervisor');
    expect(
      (await supervisor.client.get(`/v1/admin/brands/${shop.brand.id}/automations`)).status,
    ).toBe(200);
    expect(
      (await supervisor.client.put(`/v1/admin/automations/${id}/enabled`, { enabled: true }))
        .status,
    ).toBe(403);
    const agent = await join(slice, shop, 'Adil Agent', 'agent');
    expect((await agent.client.get(`/v1/admin/brands/${shop.brand.id}/automations`)).status).toBe(
      403,
    );
    expect((await remove(id)).status).toBe(204);
  });
});

describe('website rules (G21, W19)', () => {
  const launcher = () =>
    fetch(`${slice.baseUrl}/v1/widget/launcher?widgetId=${shop.brand.widgetId}&locale=en`, {
      headers: { origin: shop.hostOrigin, 'cf-ipcountry': 'AE' },
    }).then(async (r) => ({
      status: r.status,
      cache: r.headers.get('cache-control'),
      body: (await r.json()) as Json,
    }));

  it('reach the loader once published and on, with the brand’s limits', async () => {
    const before = await launcher();
    expect(before.body.proactive).toMatchObject({ enabled: false, rules: [], triggers: [] });
    expect(before.cache).toBe('private, max-age=60');

    const id = await published('Pricing help', {
      ...pricingPrompt,
      conditions: [...pricingPrompt.conditions, { field: 'country', op: 'is', value: ['AE'] }],
    });
    const after = await launcher();
    expect(after.body.version).toBeGreaterThan(before.body.version);
    expect(after.body.proactive).toEqual({
      enabled: true,
      maxPerDay: 1,
      dismissHours: 24,
      triggers: [],
      rules: [
        {
          id,
          seconds: 30,
          any: false,
          when: [['page_url', 'contains', '/pricing']],
          message: 'Questions about plans?',
        },
      ],
    });

    const limits = await shop.owner.put(
      `/v1/admin/brands/${shop.brand.id}/automations/prompt-limits`,
      { maxPerDay: 3, dismissHours: 6 },
    );
    expect(limits.status, JSON.stringify(limits.body)).toBe(200);
    expect(limits.body.promptLimits).toEqual({ maxPerDay: 3, dismissHours: 6 });
    expect((await launcher()).body.proactive).toMatchObject({ maxPerDay: 3, dismissHours: 6 });

    await shop.owner.put(`/v1/admin/automations/${id}/enabled`, { enabled: false });
    expect((await launcher()).body.proactive.rules).toEqual([]);
    expect((await remove(id)).status).toBe(204);
  });
});

describe('chat rules in the worker (G21)', () => {
  it('welcomes a customer waiting for a person, once', async () => {
    const id = await published('Welcome reply', welcome);
    const chat = await customerWrites('Hello, is anyone there?');
    const { messages, control } = await authority(slice, shop, chat.id);
    expect(control.ownerMode).toBe('WAITING_HUMAN');
    const greeting = said(messages, 'Thanks for writing. Someone will reply shortly.');
    expect(greeting).toHaveLength(1);
    expect(greeting[0]).toMatchObject({ private: false, direction: 'outgoing' });

    // Another message is not a new chat.
    const again = await chat.visitor.call('POST', `/v1/widget/conversations/${chat.id}/messages`, {
      clientMessageId: randomUUID(),
      parts: [{ type: 'text', text: 'Still here.' }],
    });
    expect(again.status, JSON.stringify(again.body)).toBe(202);
    await slice.drain();
    const later = await authority(slice, shop, chat.id);
    expect(said(later.messages, 'Thanks for writing. Someone will reply shortly.')).toHaveLength(1);

    const runs = await runsOf(id);
    expect(runs).toEqual([
      expect.objectContaining({
        version: 1,
        conversationId: chat.id,
        event: 'chat_started',
        outcome: 'done',
        actions: ['send_message'],
        reason: null,
      }),
    ]);
    const listed = (await list()).body.items.find((a: Json) => a.id === id);
    expect(listed.stats.runsThisWeek).toBe(1);
    expect((await remove(id)).status).toBe(204);
  });

  it('does nothing when the conditions do not hold', async () => {
    const id = await published('Pricing visitors only', {
      ...welcome,
      conditions: [waiting, { field: 'page_url', op: 'contains', value: '/pricing' }],
    });
    const chat = await customerWrites('A question without a page.');
    const { messages } = await authority(slice, shop, chat.id);
    expect(said(messages, 'Thanks for writing. Someone will reply shortly.')).toEqual([]);
    expect(await runsOf(id)).toEqual([]);
    expect((await remove(id)).status).toBe(204);
  });

  it('rescues a customer nobody answered, and leaves alone one who got a reply', async () => {
    const id = await published('Chat rescue', {
      event: { type: 'customer_waiting', seconds: 90 },
      conditions: [notAi],
      actions: [
        { type: 'send_message', message: { en: 'Sorry for the wait. We will be with you soon.' } },
        { type: 'set_priority', priority: 'high' },
        { type: 'add_note', text: 'Waited 90 seconds without a reply.' },
        { type: 'add_tag', tag: 'vip' },
        { type: 'assign_team', teamId },
      ],
    });
    // Nobody answers.
    const ignored = await customerWrites('Hello? I need help with my order.');
    expect(await runsOf(id)).toEqual([]);
    await waitedLong();
    const after = await authority(slice, shop, ignored.id);
    expect(said(after.messages, 'Sorry for the wait. We will be with you soon.')).toHaveLength(1);
    expect(after.state.priority).toBe('high');
    expect(after.state.labels).toContain('vip');
    expect(
      after.messages.some((m) => m.private && m.text === 'Waited 90 seconds without a reply.'),
    ).toBe(true);
    const detail = await shop.owner.get(`/v1/inbox/conversations/${ignored.id}`);
    expect(detail.body.priority).toBe('high');
    expect(detail.body.team?.id ?? detail.body.teamId).toBe(teamId);
    expect((await runsOf(id)).map((r) => r.actions)).toEqual([
      ['send_message', 'set_priority', 'add_note', 'add_tag', 'assign_team'],
    ]);

    // Someone replies before the time is up: nothing happens.
    const answered = await customerWrites('Hi, quick question.');
    const reply = await shop.owner.post(`/v1/conversations/${answered.id}/messages`, {
      clientMessageId: randomUUID(),
      text: 'Hi! How can I help?',
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    await slice.drain();
    await waitedLong();
    const fine = await authority(slice, shop, answered.id);
    expect(said(fine.messages, 'Sorry for the wait. We will be with you soon.')).toEqual([]);
    expect((await runsOf(id)).map((r) => r.conversationId)).toEqual([ignored.id]);
    expect((await remove(id)).status).toBe(204);
  });

  it('still rescues a chat that only an automation has answered', async () => {
    const greet = await published('Welcome reply', welcome);
    const rescue = await published('Chat rescue', {
      event: { type: 'customer_waiting', seconds: 60 },
      conditions: [notAi],
      actions: [{ type: 'send_message', message: { en: 'Still with you, one moment.' } }],
    });
    const chat = await customerWrites('Anyone?');
    await waitedLong();
    const { messages } = await authority(slice, shop, chat.id);
    expect(said(messages, 'Thanks for writing. Someone will reply shortly.')).toHaveLength(1);
    expect(said(messages, 'Still with you, one moment.')).toHaveLength(1);
    expect((await remove(greet)).status).toBe(204);
    expect((await remove(rescue)).status).toBe(204);
  });

  it('makes a ticket and notes it when a chat closes', async () => {
    const id = await published('Closed chats become tickets', {
      event: { type: 'chat_closed' },
      conditions: [],
      actions: [{ type: 'make_ticket' }, { type: 'add_note', text: 'Closed: kept as a ticket.' }],
    });
    const chat = await customerWrites('Thanks, that is all.');
    const closed = await shop.owner.post(`/v1/inbox/conversations/${chat.id}/status`, {
      status: 'resolved',
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    await slice.drain();
    const detail = await shop.owner.get(`/v1/inbox/conversations/${chat.id}`);
    expect(detail.body.ticket).toMatchObject({ state: 'closed', source: 'automation' });
    const { messages } = await authority(slice, shop, chat.id);
    expect(messages.some((m) => m.private && m.text === 'Closed: kept as a ticket.')).toBe(true);
    expect((await runsOf(id))[0]).toMatchObject({ event: 'chat_closed', outcome: 'done' });
    expect((await remove(id)).status).toBe(204);
  });

  it('tags contact form messages, and does not treat them as a new chat', async () => {
    const tagged = await published('Tag contact form', {
      event: { type: 'offline_message' },
      conditions: [],
      actions: [{ type: 'add_tag', tag: 'checkout' }],
    });
    const welcomeId = await published('Welcome reply', welcome);
    const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
    await visitor.open();
    const requestId = randomUUID();
    const sent = await visitor.call(
      'POST',
      '/v1/widget/offline-messages',
      {
        clientRequestId: requestId,
        answers: { name: 'Lina', email: 'lina@example.com', question: 'Do you ship to Oman?' },
      },
      { 'idempotency-key': requestId },
    );
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    await slice.drain();
    const id = sent.body.conversation.id as string;
    const { state, messages } = await authority(slice, shop, id);
    expect(state.labels).toContain('checkout');
    expect(said(messages, 'Thanks for writing. Someone will reply shortly.')).toEqual([]);
    expect((await runsOf(tagged))[0]).toMatchObject({ event: 'offline_message', outcome: 'done' });
    expect(await runsOf(welcomeId)).toEqual([]);
    expect((await remove(tagged)).status).toBe(204);
    expect((await remove(welcomeId)).status).toBe(204);
  });

  it('never speaks while the AI has the chat', async () => {
    const ai = await connectedTenant(slice, 'airules');
    const made = await ai.owner.post(`/v1/admin/brands/${ai.brand.id}/automations`, {
      name: 'Rescue for people',
      definition: {
        event: { type: 'chat_started' },
        conditions: [notAi],
        actions: [{ type: 'send_message', message: { en: 'A person will reply.' } }],
      },
      publish: true,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const visitor = new Visitor(slice.baseUrl, ai.brand.widgetId, ai.hostOrigin);
    await visitor.open();
    const started = await visitor.call('POST', '/v1/widget/conversations', {
      firstMessage: 'Hello',
      clientMessageId: randomUUID(),
    });
    expect(started.status).toBe(201);
    await slice.drain();
    const { control, messages } = await authority(slice, ai, started.body.id);
    expect(control.ownerMode).toBe('AI_ACTIVE');
    expect(said(messages, 'A person will reply.')).toEqual([]);
  });
});
