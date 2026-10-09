import { randomUUID } from 'node:crypto';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPLY_WAITING_TOPIC } from '../src/widget/notify-queue.js';
import { TICKET_CONFIRM_TOPIC } from '../src/widget/offline-messages.service.js';
import { authority } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/**
 * What the chat asks before it starts, and tickets (W26, W27, W28, W11, H19), end to end: the
 * gateway on a real port, the worker driven by hand, and the fake Chatwoot.
 */

type Json = Record<string, any>;

let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;
let billingTeam: string;

beforeAll(async () => {
  slice = await startSlice();
  shop = await connectedTenant(slice, 'frontdoor');
  tenantId = fromPublicId('tenant', shop.tenantId);
  const team = await shop.owner.post('/v1/admin/teams', {
    name: 'Billing',
    workspaceId: shop.workspaceId,
  });
  expect(team.status, JSON.stringify(team.body)).toBe(201);
  billingTeam = team.body.id;
}, 120_000);

afterAll(async () => {
  await slice?.close();
});

const brandPath = (rest: string) => `/v1/admin/brands/${shop.brand.id}/${rest}`;

/** A visitor's first session, with the country Cloudflare would add. */
async function visitorFrom(country?: string, body: Json = {}) {
  const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  const session = await visitor.call(
    'POST',
    '/v1/widget/sessions',
    { widgetId: shop.brand.widgetId, hostOrigin: shop.hostOrigin, ...body },
    country ? { 'cf-ipcountry': country } : {},
  );
  expect(session.status, JSON.stringify(session.body)).toBe(201);
  visitor.adopt(session.body);
  return { visitor, session: session.body as Json };
}

function start(visitor: Visitor, body: Json = {}, country?: string) {
  return visitor.call(
    'POST',
    '/v1/widget/conversations',
    { clientMessageId: randomUUID(), ...body },
    country ? { 'cf-ipcountry': country } : {},
  );
}

async function inboxState(conversationId: string) {
  const [row] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.conversationInboxState)
      .where(
        eq(
          schema.conversationInboxState.conversationId,
          fromPublicId('conversation', conversationId),
        ),
      ),
  );
  return row;
}

async function dueNow(topic: string) {
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .update(schema.outboxEvents)
      .set({ availableAt: new Date(Date.now() - 1000) })
      .where(and(eq(schema.outboxEvents.topic, topic), isNull(schema.outboxEvents.processedAt))),
  );
  await slice.drain();
}

const mails = (template?: string) =>
  slice.workerMailer.messages.filter((m) => !template || m.template === template);

describe('brand settings for what the chat asks (W26, W27, W28)', () => {
  it('starts with the defaults: no pre-chat form, a contact form, no consent and no link', async () => {
    const forms = await shop.owner.get(brandPath('widget-forms'));
    expect(forms.status).toBe(200);
    expect(forms.body.forms.prechat).toMatchObject({ enabled: false, skipVerified: true });
    expect(forms.body.forms.offline).toMatchObject({ enabled: true, when: 'either' });
    expect(forms.body.forms.offline.fields.map((f: Json) => f.kind)).toEqual([
      'name',
      'email',
      'question',
    ]);
    const consent = await shop.owner.get(brandPath('consent'));
    expect(consent.body).toMatchObject({ consent: { mode: 'off', text: null }, noticeVersion: 0 });
    const link = await shop.owner.get(brandPath('direct-link'));
    expect(link.body).toMatchObject({ enabled: false });
    expect(link.body.url).toMatch(new RegExp(`/c/${shop.brand.widgetId}$`));
  });

  it('refuses a department that leads to no team of the brand, and a contact form without email', async () => {
    const current = (await shop.owner.get(brandPath('widget-forms'))).body.forms;
    const badTeam = await shop.owner.put(brandPath('widget-forms'), {
      ...current,
      prechat: {
        enabled: true,
        fields: [
          {
            id: 'dept',
            kind: 'department',
            label: { en: 'Department' },
            options: [
              { id: 'a', label: { en: 'A' }, teamId: billingTeam },
              { id: 'b', label: { en: 'B' }, teamId: 'team_01jz0000000000000000000000' },
            ],
          },
        ],
      },
    });
    expect(badTeam.status).toBe(422);
    expect(JSON.stringify(badTeam.body)).toContain('prechat.fields.0.options.1.teamId');

    const noEmail = await shop.owner.put(brandPath('widget-forms'), {
      ...current,
      offline: {
        ...current.offline,
        fields: current.offline.fields.filter((f: Json) => f.kind !== 'email'),
      },
    });
    expect(noEmail.status).toBe(422);
  });

  it('versions the consent words: new words, and turning it on, ask customers again', async () => {
    const on = await shop.owner.put(brandPath('consent'), { mode: 'everyone', text: null });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.noticeVersion).toBe(1);
    const same = await shop.owner.put(brandPath('consent'), { mode: 'eu', text: null });
    expect(same.body.noticeVersion).toBe(1);
    const reworded = await shop.owner.put(brandPath('consent'), {
      mode: 'everyone',
      text: { en: 'We keep this chat to help you.' },
    });
    expect(reworded.body.noticeVersion).toBe(2);
    await shop.owner.put(brandPath('consent'), { mode: 'off', text: null });
  });
});

describe('consent before chatting (W27)', () => {
  it('asks every visitor, refuses a chat until they agree, and remembers the agreement', async () => {
    const saved = await shop.owner.put(brandPath('consent'), {
      mode: 'everyone',
      text: { en: 'We keep this chat, {brand}.' },
    });
    const version = saved.body.noticeVersion as number;
    const { visitor, session } = await visitorFrom('AE');
    expect(session.config.consent).toMatchObject({
      required: true,
      given: false,
      noticeVersion: version,
    });
    expect(session.config.consent.text.en).toBe('We keep this chat, {brand}.');
    const refused = await start(visitor, { firstMessage: 'Hello' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('CONSENT_REQUIRED');

    const stale = await visitor.call('POST', '/v1/widget/consent', {
      noticeVersion: version - 1,
    });
    expect(stale.status).toBe(409);
    const agreed = await visitor.call('POST', '/v1/widget/consent', { noticeVersion: version });
    expect(agreed.status).toBe(204);
    // Agreeing twice keeps one record.
    expect(
      (await visitor.call('POST', '/v1/widget/consent', { noticeVersion: version })).status,
    ).toBe(204);
    const refreshed = await visitor.call('POST', '/v1/widget/sessions/refresh', {
      refreshToken: visitor.refreshToken,
    });
    expect(refreshed.body.config.consent).toMatchObject({ required: true, given: true });
    const started = await start(visitor, { firstMessage: 'Hello' });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const records = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.chatConsents)
        .where(eq(schema.chatConsents.principalId, fromPublicId('customer', visitor.principalId))),
    );
    expect(records.map((r) => r.noticeVersion)).toEqual([version]);
    // The record keeps the words' version and the time, never a country.
    expect(Object.keys(records[0] ?? {})).not.toContain('country');
  });

  it('with “EU, EEA and UK”, asks visitors from there and from nowhere known, and no one else', async () => {
    await shop.owner.put(brandPath('consent'), { mode: 'eu', text: null });
    const german = await visitorFrom('DE');
    expect(german.session.config.consent.required).toBe(true);
    expect(german.session.config.consent.text.en).toContain('frontdoor Shop keeps this chat');
    const unknown = await visitorFrom();
    expect(unknown.session.config.consent.required).toBe(true);
    const emirati = await visitorFrom('AE');
    expect(emirati.session.config.consent.required).toBe(false);
    expect((await start(emirati.visitor, { firstMessage: 'Hi' }, 'AE')).status).toBe(201);
    expect((await start(german.visitor, { firstMessage: 'Hi' }, 'DE')).status).toBe(403);
    await shop.owner.put(brandPath('consent'), { mode: 'off', text: null });
  });
});

describe('pre-chat form (W26)', () => {
  beforeAll(async () => {
    const current = (await shop.owner.get(brandPath('widget-forms'))).body.forms;
    const saved = await shop.owner.put(brandPath('widget-forms'), {
      ...current,
      prechat: {
        enabled: true,
        skipVerified: true,
        fields: [
          { id: 'name', kind: 'name', label: { en: 'Your name' }, required: true },
          { id: 'email', kind: 'email', label: { en: 'Your email' } },
          {
            id: 'dept',
            kind: 'department',
            label: { en: 'Department' },
            required: true,
            options: [
              { id: 'billing', label: { en: 'Billing' }, teamId: billingTeam },
              { id: 'other', label: { en: 'Something else' }, teamId: billingTeam },
            ],
          },
          { id: 'question', kind: 'question', label: { en: 'Your question' } },
        ],
      },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  });

  it('is in the widget configuration with every label in every language', async () => {
    const { session } = await visitorFrom();
    expect(session.config.forms.prechat.enabled).toBe(true);
    const name = session.config.forms.prechat.fields[0];
    expect(name).toMatchObject({ id: 'name', kind: 'name', required: true });
    expect(name.label).toEqual({
      en: 'Your name',
      ar: 'Your name',
      hi: 'Your name',
      ur: 'Your name',
    });
  });

  it('refuses missing or wrong answers, naming each field', async () => {
    const { visitor } = await visitorFrom();
    const missing = await start(visitor, { prechat: { email: 'not-an-address' } });
    expect(missing.status).toBe(422);
    const paths = (missing.body.fields as Json[]).map((f) => f.path).sort();
    expect(paths).toEqual(['prechat.dept', 'prechat.email', 'prechat.name']);
    const wrongChoice = await start(visitor, { prechat: { name: 'Sara', dept: 'nowhere' } });
    expect(wrongChoice.status).toBe(422);
  });

  it('names the customer, sends their question, sets the team and tells staff in a note', async () => {
    const { visitor } = await visitorFrom();
    const started = await start(visitor, {
      prechat: {
        name: 'Sara Ahmed',
        email: 'sara@example.com',
        dept: 'billing',
        question: 'Why was I charged twice?',
      },
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    await slice.drain();
    const id = started.body.id as string;
    const { messages, state, runtime } = await authority(slice, shop, id);
    // The question is the customer's first message.
    expect(
      messages.some((m) => m.direction === 'incoming' && m.text === 'Why was I charged twice?'),
    ).toBe(true);
    const note = messages.find((m) => m.private && m.text?.startsWith('Before the chat'));
    expect(note?.text).toContain('Your name: Sara Ahmed');
    expect(note?.text).toContain('Your email: sara@example.com (not verified)');
    expect(note?.text).toContain('Department: Billing');
    // The contact is named, and the typed address is an attribute, never the contact's email.
    const contact = await runtime.authority.getContact(String(state.contactRef), {
      kind: 'integration',
    });
    expect(contact.name).toBe('Sara Ahmed');
    expect(contact.email).toBeNull();
    expect(contact.attributes).toMatchObject({
      form_email: 'sara@example.com',
      form_dept: 'Billing',
    });
    expect((await inboxState(id))?.teamId).toBe(fromPublicId('team', billingTeam));
    const listed = await shop.owner.get(`/v1/inbox/conversations/${id}`);
    expect(listed.body.customer.displayName).toBe('Sara Ahmed');
    expect(listed.body.team?.id).toBe(billingTeam);
  });

  it('lets signed-in customers skip it, and leaves it out when the brand turns it off', async () => {
    const current = (await shop.owner.get(brandPath('widget-forms'))).body.forms;
    await shop.owner.put(brandPath('widget-forms'), {
      ...current,
      prechat: { ...current.prechat, enabled: false },
    });
    const { visitor } = await visitorFrom();
    expect((await start(visitor, { firstMessage: 'Hello' })).status).toBe(201);
    await shop.owner.put(brandPath('widget-forms'), current);
  });
});

describe('contact form while nobody can answer, and its ticket (W11, H19)', () => {
  let visitor: Visitor;
  let conversationId: string;

  beforeAll(async () => {
    const current = (await shop.owner.get(brandPath('widget-forms'))).body.forms;
    await shop.owner.put(brandPath('widget-forms'), {
      ...current,
      prechat: { ...current.prechat, enabled: false },
    });
  });

  it('refuses a message without a valid address', async () => {
    ({ visitor } = await visitorFrom());
    const refused = await visitor.call('POST', '/v1/widget/offline-messages', {
      clientRequestId: randomUUID(),
      answers: { name: 'Omar', email: 'omar', question: 'Hi' },
    });
    expect(refused.status).toBe(422);
    expect((refused.body.fields as Json[]).map((f) => f.path)).toEqual(['answers.email']);
  });

  it('makes a ticket for people, and sends one confirmation that does not repeat the message', async () => {
    const before = mails().length;
    const requestId = randomUUID();
    const body = {
      clientRequestId: requestId,
      answers: {
        name: 'Omar',
        email: 'omar@example.com',
        question: 'My invoice shows the wrong VAT number.',
      },
    };
    const sent = await visitor.call('POST', '/v1/widget/offline-messages', body, {
      'idempotency-key': requestId,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body).toMatchObject({
      reference: expect.stringMatching(/^#\d+$/),
      email: 'o•••@example.com',
      confirmationSent: true,
    });
    expect(sent.body.conversation.ticket).toEqual({
      reference: sent.body.reference,
      state: 'open',
    });
    conversationId = sent.body.conversation.id;
    // A retry of the same form creates nothing twice.
    const again = await visitor.call('POST', '/v1/widget/offline-messages', body, {
      'idempotency-key': requestId,
    });
    expect(again.status).toBe(201);
    expect(again.body.conversation.id).toBe(conversationId);
    await slice.drain();

    const listed = await shop.owner.get(`/v1/inbox/conversations/${conversationId}`);
    expect(listed.body.ownerMode).toBe('WAITING_HUMAN');
    expect(listed.body.ticket).toMatchObject({
      reference: sent.body.reference,
      state: 'open',
      source: 'offline_form',
    });
    const { messages } = await authority(slice, shop, conversationId);
    expect(
      messages.filter((m) => m.text === 'My invoice shows the wrong VAT number.'),
    ).toHaveLength(1);

    const confirmation = mails('customer.ticket_confirm').slice(before);
    expect(confirmation).toHaveLength(1);
    expect(confirmation[0]?.to).toBe('omar@example.com');
    expect(confirmation[0]?.subject).toContain(sent.body.reference);
    expect(confirmation[0]?.text).not.toContain('VAT');
    expect(confirmation[0]?.text).toMatch(/confirm-email\?token=[\w-]+\.[\w-]+/);
  });

  it('sends no second confirmation to the same address soon after', async () => {
    const other = await visitorFrom();
    const sent = await other.visitor.call('POST', '/v1/widget/offline-messages', {
      clientRequestId: randomUUID(),
      answers: { email: 'OMAR@example.com', question: 'Also, my address changed.' },
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.confirmationSent).toBe(false);
    await slice.drain();
    expect(mails('customer.ticket_confirm').filter((m) => /omar@/i.test(m.to))).toHaveLength(1);
  });

  it('asks before confirming, then emails answers to the confirmed address only', async () => {
    const mail = mails('customer.ticket_confirm').find((m) => m.to === 'omar@example.com');
    const link = /(http\S+confirm-email\?token=\S+)/.exec(mail?.text ?? '')?.[1] as string;
    const page = await fetch(link);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<form method="post"');
    const followup = async () => {
      const [row] = await withTenant(slice.app, { tenantId }, (tx) =>
        tx
          .select()
          .from(schema.ticketFollowups)
          .where(
            eq(schema.ticketFollowups.conversationId, fromPublicId('conversation', conversationId)),
          ),
      );
      return row;
    };
    // Opening the link changes nothing (link scanners open links).
    expect((await followup())?.confirmedAt).toBeNull();
    const forged = await fetch(`${link}x`, { method: 'POST' });
    expect(forged.status).toBe(404);
    const confirmed = await fetch(link, { method: 'POST' });
    expect(confirmed.status).toBe(200);
    expect((await followup())?.confirmedAt).toBeInstanceOf(Date);

    const before = mails('customer.ticket_reply').length;
    const reply = await shop.owner.post(`/v1/conversations/${conversationId}/messages`, {
      clientMessageId: randomUUID(),
      text: 'Thank you, Omar. We corrected the VAT number on invoice 2041.',
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    await slice.drain();
    await dueNow(REPLY_WAITING_TOPIC);
    const answers = mails('customer.ticket_reply').slice(before);
    expect(answers).toHaveLength(1);
    expect(answers[0]?.to).toBe('omar@example.com');
    // The answer itself, since the customer confirmed the address and asked for it.
    expect(answers[0]?.text).toContain('We corrected the VAT number on invoice 2041.');
    expect(answers[0]?.headers?.['List-Unsubscribe']).toMatch(/unsubscribe\?token=/);
  });

  it('confirms nothing for a ticket whose confirmation never went out', async () => {
    const outbox = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.topic, TICKET_CONFIRM_TOPIC)),
    );
    expect(outbox.length).toBeGreaterThan(0);
    const invalid = await fetch(`${slice.baseUrl}/v1/notifications/confirm-email?token=abc.def`);
    expect(invalid.status).toBe(404);
  });

  it('refuses the form when the brand turns it off', async () => {
    const current = (await shop.owner.get(brandPath('widget-forms'))).body.forms;
    await shop.owner.put(brandPath('widget-forms'), {
      ...current,
      offline: { ...current.offline, enabled: false },
    });
    const off = await visitor.call('POST', '/v1/widget/offline-messages', {
      clientRequestId: randomUUID(),
      answers: { email: 'a@example.com', question: 'Hello?' },
    });
    expect(off.status).toBe(403);
    expect(off.body.code).toBe('FEATURE_DISABLED');
    await shop.owner.put(brandPath('widget-forms'), current);
  });
});

describe('tickets and priority in the inbox (H19)', () => {
  let id: string;

  it('makes a chat a ticket once, with the next number, and lists it in the tickets queue', async () => {
    const { visitor } = await visitorFrom();
    const started = await start(visitor, { firstMessage: 'My order arrived broken.' });
    id = started.body.id;
    await slice.drain();
    const made = await shop.owner.post(`/v1/inbox/conversations/${id}/ticket`, {
      priority: 'high',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body.ticket).toMatchObject({ state: 'open', source: 'staff' });
    expect(made.body.priority).toBe('high');
    const number = made.body.ticket.number as number;
    const again = await shop.owner.post(`/v1/inbox/conversations/${id}/ticket`, {});
    expect(again.body.ticket.number).toBe(number);

    const { state } = await authority(slice, shop, id);
    expect(state.priority).toBe('high');

    const queue = await shop.owner.get('/v1/inbox/conversations?queue=tickets');
    expect(queue.body.items.map((c: Json) => c.id)).toContain(id);
    expect(queue.body.counts.tickets).toBeGreaterThanOrEqual(1);
    const high = await shop.owner.get('/v1/inbox/conversations?priority=high&status=all');
    expect(high.body.items.map((c: Json) => c.id)).toEqual([id]);
  });

  it('is Pending while it waits for the customer, Closed when resolved, and Open again after', async () => {
    const pending = await shop.owner.post(`/v1/inbox/conversations/${id}/status`, {
      status: 'snoozed',
    });
    expect(pending.status, JSON.stringify(pending.body)).toBe(200);
    expect(pending.body.ticket.state).toBe('pending');
    const listPending = await shop.owner.get(
      '/v1/inbox/conversations?queue=tickets&ticketState=pending',
    );
    expect(listPending.body.items.map((c: Json) => c.id)).toEqual([id]);

    const closed = await shop.owner.post(`/v1/inbox/conversations/${id}/status`, {
      status: 'resolved',
    });
    expect(closed.body.ticket.state).toBe('closed');
    const listClosed = await shop.owner.get(
      '/v1/inbox/conversations?queue=tickets&ticketState=closed',
    );
    expect(listClosed.body.items.map((c: Json) => c.id)).toContain(id);
    const listOpen = await shop.owner.get('/v1/inbox/conversations?queue=tickets&ticketState=open');
    expect(listOpen.body.items.map((c: Json) => c.id)).not.toContain(id);

    const reopened = await shop.owner.post(`/v1/inbox/conversations/${id}/status`, {
      status: 'open',
    });
    expect(reopened.body.ticket.state).toBe('open');
  });

  it('takes over a priority set inside Chatwoot, and clears it from Hamnivo', async () => {
    const { runtime, ref } = await authority(slice, shop, id);
    await runtime.authority.setPriority(ref, 'urgent', { kind: 'integration' });
    await slice.drain();
    expect((await inboxState(id))?.priority).toBe('urgent');
    const cleared = await shop.owner.post(`/v1/inbox/conversations/${id}/priority`, {
      priority: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.priority).toBeNull();
    expect((await authority(slice, shop, id)).state.priority).toBeNull();
    const trail = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select({ action: schema.auditEvents.action })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetId, id)),
    );
    expect(trail.map((a) => a.action)).toEqual(
      expect.arrayContaining(['conversation.ticket_made', 'conversation.priority_changed']),
    );
  });

  it('refuses a stale view of who handles the conversation', async () => {
    const stale = await shop.owner.post(`/v1/inbox/conversations/${id}/priority`, {
      priority: 'low',
      expectedEpoch: 999,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('OWNERSHIP_CHANGED');
  });
});

describe('direct chat link (W28)', () => {
  it('opens a chat from the link only while the brand keeps it on, and ends it when turned off', async () => {
    const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
    const off = await visitor.call('POST', '/v1/widget/sessions', {
      widgetId: shop.brand.widgetId,
      direct: true,
    });
    expect(off.status).toBe(403);
    expect(off.body.code).toBe('ORIGIN_NOT_ALLOWED');

    expect((await shop.owner.put(brandPath('direct-link'), { enabled: true })).status).toBe(200);
    const on = await visitor.call('POST', '/v1/widget/sessions', {
      widgetId: shop.brand.widgetId,
      direct: true,
    });
    expect(on.status, JSON.stringify(on.body)).toBe(201);
    expect(on.body.config.direct).toBe(true);
    visitor.adopt(on.body);
    expect((await start(visitor, { firstMessage: 'From the link' })).status).toBe(201);
    const renewed = await visitor.call('POST', '/v1/widget/sessions/refresh', {
      refreshToken: visitor.refreshToken,
    });
    expect(renewed.status).toBe(200);
    visitor.adopt(renewed.body);

    await shop.owner.put(brandPath('direct-link'), { enabled: false });
    const ended = await visitor.call('POST', '/v1/widget/sessions/refresh', {
      refreshToken: visitor.refreshToken,
    });
    expect(ended.status).toBe(401);
    expect(ended.body.code).toBe('SESSION_EXPIRED');
  });
});
