import { randomUUID } from 'node:crypto';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SLA_ALERT_TOPIC, SLA_DUE_TOPIC, SLA_MOVE_TOPIC } from '../src/inbox/sla.js';
import type { Client } from './harness.js';
import { audits, customerStarts, join, type Shop, StaffStream } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice } from './slice-harness.js';

/**
 * Escalating overdue conversations (H12, ADR 0016): the brand alerts the people who can assign an
 * overdue conversation (in Studio, and by email when they are not online) and, when still nobody
 * replies after more working minutes, moves it back to the queue or to a chosen team, as a new
 * hand-off offered to the next person. The test moves the gateway's clock; deadlines and moves
 * that come are made due in the outbox by hand.
 */

let offsetMs = 0;
const now = () => new Date(Date.now() + offsetMs);
const later = (minutes: number) => {
  offsetMs += minutes * 60_000;
};

let slice: Slice;
let shop: Shop;
let tenantId: string;
type Person = { client: Client; staffId: string };
let amina: Person;
let rayan: Person;
let care: string;
let other: Shop;

const OWNER_EMAIL = 'escalate-owner@example.com';
const targets = {
  urgent: { firstReplyMinutes: 2, nextReplyMinutes: 4 },
  high: { firstReplyMinutes: 5, nextReplyMinutes: 10 },
  medium: { firstReplyMinutes: 10, nextReplyMinutes: 20 },
  low: { firstReplyMinutes: null, nextReplyMinutes: null },
};
const policyPath = () => `/v1/admin/brands/${shop.brand.id}/sla-policy`;
const inbox = (id: string, rest = '') => `/v1/inbox/conversations/${id}${rest}`;

async function setPolicy(overdue: object) {
  const saved = await rayan.client.put(policyPath(), { enabled: true, targets, overdue });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
}

async function online(...people: Person[]) {
  for (const person of people) {
    await person.client.put('/v1/inbox/availability', { status: 'online' });
    const ping = await person.client.post('/v1/inbox/availability/ping', { active: true });
    expect(ping.status, JSON.stringify(ping.body)).toBe(200);
  }
}

async function waiting(text: string): Promise<string> {
  const { visitor, conversationId } = await customerStarts(slice, shop, text);
  const handoff = await visitor.call('POST', `/v1/widget/conversations/${conversationId}/handoff`, {
    clientRequestId: randomUUID(),
    note: 'a person, please',
  });
  expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
  await slice.drain();
  return conversationId;
}

async function claimed(person: Person, text: string): Promise<string> {
  const id = await waiting(text);
  const took = await person.client.post(inbox(id, '/assign'), { to: { kind: 'me' } });
  expect(took.status, JSON.stringify(took.body)).toBe(200);
  await slice.drain();
  return id;
}

/** Outbox events of a topic that have not run yet are made due, as the relay would run them. */
async function due(topic: string) {
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .update(schema.outboxEvents)
      .set({ availableAt: new Date(Date.now() - 1000) })
      .where(and(eq(schema.outboxEvents.topic, topic), isNull(schema.outboxEvents.processedAt))),
  );
  await slice.drain();
}
const deadlinesCome = () => due(SLA_DUE_TOPIC);
const movesCome = () => due(SLA_MOVE_TOPIC);

async function row(id: string, client: Client = shop.owner) {
  const detail = await client.get(inbox(id));
  expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  return detail.body;
}

async function pending(topic: string, id: string) {
  return withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select({ id: schema.outboxEvents.id })
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.topic, topic),
          eq(schema.outboxEvents.aggregateId, fromPublicId('conversation', id)),
        ),
      ),
  );
}

const overdueMails = () =>
  slice.workerMailer.messages.filter((m) => m.template === 'inbox.sla_overdue');

beforeAll(async () => {
  slice = await startSlice({ clock: now });
  shop = await connectedTenant(slice, 'escalate');
  tenantId = fromPublicId('tenant', shop.tenantId);
  amina = await join(slice, shop, 'Amina Agent', 'agent');
  rayan = await join(slice, shop, 'Rayan Lead', 'supervisor');
  other = await connectedTenant(slice, 'escalate-other');
  const workspaces = await shop.owner.get('/v1/admin/workspaces');
  const team = await shop.owner.post('/v1/admin/teams', {
    name: 'Care',
    workspaceId: workspaces.body.items[0].id,
  });
  expect(team.status, JSON.stringify(team.body)).toBe(201);
  care = team.body.id;
  const members = await shop.owner.put(`/v1/admin/teams/${care}/members`, {
    staffMemberIds: [amina.staffId],
  });
  expect(members.status, JSON.stringify(members.body)).toBe(200);
  const offering = await shop.owner.patch(`/v1/admin/teams/${care}`, {
    assignmentMode: 'offer',
    offerTimeoutSeconds: 120,
  });
  expect(offering.status, JSON.stringify(offering.body)).toBe(200);
}, 120_000);

afterAll(async () => {
  await slice?.close();
});

describe('what happens to overdue conversations is set per brand (H12)', () => {
  it('is saved by people who configure the inbox, and checked', async () => {
    const empty = await shop.owner.get(policyPath());
    expect(empty.body.overdue).toEqual({
      alertLeads: false,
      moveAfterMinutes: null,
      moveTo: { kind: 'queue' },
    });
    const overdue = {
      alertLeads: true,
      moveAfterMinutes: 15,
      moveTo: { kind: 'team', teamId: care },
    };
    const saved = await rayan.client.put(policyPath(), { enabled: true, targets, overdue });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.overdue).toEqual(overdue);
    // Left out: kept as it is (an older Studio that does not know the setting changes nothing).
    const kept = await rayan.client.put(policyPath(), { enabled: true, targets });
    expect(kept.body.overdue).toEqual(overdue);
    expect((await amina.client.put(policyPath(), { enabled: true, targets, overdue })).status).toBe(
      403,
    );
    const unknown = await rayan.client.put(policyPath(), {
      enabled: true,
      targets,
      overdue: { ...overdue, moveTo: { kind: 'team', teamId: 'team_nonsense' } },
    });
    expect(unknown.status).toBe(422);
    // A team that no longer takes conversations cannot be chosen.
    const archived = await shop.owner.post('/v1/admin/teams', { name: 'Old', workspaceId: null });
    await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .update(schema.teams)
        .set({ status: 'archived' })
        .where(eq(schema.teams.id, fromPublicId('team', archived.body.id))),
    );
    const refused = await rayan.client.put(policyPath(), {
      enabled: true,
      targets,
      overdue: { ...overdue, moveTo: { kind: 'team', teamId: archived.body.id } },
    });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('overdue.moveTo.teamId');
    const tooLong = await rayan.client.put(policyPath(), {
      enabled: true,
      targets,
      overdue: { ...overdue, moveAfterMinutes: 0 },
    });
    expect(tooLong.status).toBe(422);
    // Another tenant cannot see or set it.
    expect((await other.owner.get(policyPath())).status).toBe(404);
  });
});

describe('an overdue conversation (H12, ADR 0016)', () => {
  it('alerts the leads: in Studio, and by email to those not online, then goes back to the queue', async () => {
    await setPolicy({ alertLeads: true, moveAfterMinutes: 5, moveTo: { kind: 'queue' } });
    const id = await claimed(amina, 'My parcel never arrived.');
    const before = await row(id);
    const lead = new StaffStream(slice.baseUrl, rayan.client);
    const own = new StaffStream(slice.baseUrl, amina.client);
    await Promise.all([lead.ready, own.ready]);

    later(11);
    await online(rayan, amina);
    await deadlinesCome();
    const alerts = (stream: StaffStream) =>
      stream.events('alert').filter((alert) => alert.conversationId === id);
    await lead.until((s) => alerts(s).length > 0);
    await own.until((s) => alerts(s).length > 0);
    // Rayan may assign it: he hears it went overdue. Amina has it: her own overdue alert.
    expect(alerts(lead).map((a) => a.kind)).toEqual(['sla_overdue_lead']);
    expect(alerts(own).map((a) => a.kind)).toEqual(['sla_overdue']);
    lead.close();
    own.close();
    // The owner of the workspace may assign it too, but is not online: an email, with the link.
    const mails = overdueMails();
    expect(mails.map((m) => m.to)).toEqual([OWNER_EMAIL]);
    expect(mails[0]?.subject).toContain('past its reply-time target');
    expect(mails[0]?.text).toContain('Amina Agent has it but has not replied yet.');
    expect(mails[0]?.text).toContain('Hamnivo moves it back to the queue');
    expect(mails[0]?.text).toContain(`/inbox/${id}`);

    // Five more working minutes without a reply: back to the queue, as a new hand-off.
    later(5);
    await movesCome();
    const moved = await row(id);
    expect(moved).toMatchObject({ ownerMode: 'WAITING_HUMAN', ownerReason: 'sla_moved' });
    expect(moved.ownershipEpoch).toBe(before.ownershipEpoch + 1);
    // Still overdue, and not alerted as overdue a second time.
    expect(moved.sla).toMatchObject({ breached: true });
    const actions = (await audits(slice, shop, id)).map((a) => a.action);
    expect(actions.filter((a) => a === 'conversation.sla_breached')).toHaveLength(1);
    expect(actions).toContain('conversation.sla_moved');
    const list = await shop.owner.get('/v1/inbox/conversations?queue=overdue');
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(id);
    await amina.client.post(inbox(id, '/status'), { status: 'resolved' });
  });

  it('goes to the chosen team, offered to one of its people', async () => {
    await setPolicy({
      alertLeads: false,
      moveAfterMinutes: 5,
      moveTo: { kind: 'team', teamId: care },
    });
    const id = await claimed(rayan, 'Can I change my delivery address?');
    later(11);
    await deadlinesCome();
    later(5);
    await online(amina);
    await movesCome();
    const moved = await row(id);
    expect(moved).toMatchObject({ ownerMode: 'WAITING_HUMAN', ownerReason: 'sla_moved' });
    expect(moved.team?.id).toBe(care);
    // Care offers chats to one person at a time: Amina is offered it for the new hand-off.
    const offers = await amina.client.get('/v1/inbox/offers');
    expect(offers.body.items.map((i: { id: string }) => i.id)).toContain(id);
    await shop.owner.post(inbox(id, '/status'), { status: 'resolved' });
  });

  it('stays where it is when someone acted in time', async () => {
    await setPolicy({ alertLeads: false, moveAfterMinutes: 5, moveTo: { kind: 'queue' } });
    // Amina replies after it went overdue but before the move.
    const replied = await claimed(amina, 'Is my refund on its way?');
    // Rayan takes over a colleague's chat.
    const reassigned = await claimed(amina, 'Where is my invoice?');
    // Snoozed for later.
    const snoozed = await claimed(amina, 'Call me tomorrow, please.');
    later(11);
    await deadlinesCome();
    const sent = await amina.client.post(`/v1/conversations/${replied}/messages`, {
      clientMessageId: randomUUID(),
      text: 'Checking it now.',
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    const takeover = await rayan.client.post(inbox(reassigned, '/assign'), { to: { kind: 'me' } });
    expect(takeover.status, JSON.stringify(takeover.body)).toBe(200);
    const snooze = await amina.client.post(inbox(snoozed, '/status'), {
      status: 'snoozed',
      snoozedUntil: new Date(now().getTime() + 3_600_000).toISOString(),
    });
    expect(snooze.status, JSON.stringify(snooze.body)).toBe(200);
    await slice.drain();
    // Open again before the move: snoozing for a while was still someone acting on it.
    later(2);
    const reopened = await amina.client.post(inbox(snoozed, '/status'), { status: 'open' });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    await slice.drain();
    later(5);
    await movesCome();
    expect(await row(replied)).toMatchObject({ ownerMode: 'HUMAN_ACTIVE' });
    expect((await row(reassigned)).owner).toMatchObject({ staffMemberId: rayan.staffId });
    expect(await row(snoozed)).toMatchObject({ ownerMode: 'HUMAN_ACTIVE' });
    for (const id of [replied, reassigned, snoozed]) {
      expect((await audits(slice, shop, id)).map((a) => a.action)).not.toContain(
        'conversation.sla_moved',
      );
      await shop.owner.post(inbox(id, '/status'), { status: 'resolved' });
    }
  });

  it('nobody took: alerted only when it is already in the queue, moved when a team is chosen', async () => {
    await setPolicy({ alertLeads: true, moveAfterMinutes: 5, moveTo: { kind: 'queue' } });
    const queued = await waiting('Hello? Anyone there?');
    const epoch = (await row(queued)).ownershipEpoch;
    later(11);
    await deadlinesCome();
    // It is in the queue already, so the email promises no move.
    const told = overdueMails().findLast((m) => m.text.includes(`/inbox/${queued}`));
    expect(told?.text).toContain('Nobody has taken it yet.');
    expect(told?.text).not.toContain('moves it');
    later(5);
    await movesCome();
    expect(await row(queued)).toMatchObject({ ownerMode: 'WAITING_HUMAN', ownershipEpoch: epoch });
    await setPolicy({
      alertLeads: false,
      moveAfterMinutes: 5,
      moveTo: { kind: 'team', teamId: care },
    });
    const toTeam = await waiting('Do you ship abroad?');
    const first = (await row(toTeam)).ownershipEpoch;
    later(11);
    await deadlinesCome();
    later(5);
    await online(amina);
    await movesCome();
    const moved = await row(toTeam);
    expect(moved.team?.id).toBe(care);
    expect(moved.ownershipEpoch).toBe(first + 1);
    for (const id of [queued, toTeam]) {
      await shop.owner.post(inbox(id, '/status'), { status: 'resolved' });
    }
  });

  it('sends one email for many at once, and nothing when the brand does not escalate', async () => {
    await setPolicy({ alertLeads: true, moveAfterMinutes: null, moveTo: { kind: 'queue' } });
    const mailsBefore = overdueMails().length;
    const ids = [await waiting('First question'), await waiting('Second question')];
    later(11);
    await deadlinesCome();
    // Two overdue at once: each lead who is not online gets one email, not two.
    const sent = overdueMails()
      .slice(mailsBefore)
      .map((m) => m.to)
      .sort();
    expect(sent).toEqual([...new Set(sent)]);
    expect(sent).toContain(OWNER_EMAIL);
    for (const id of ids) await shop.owner.post(inbox(id, '/status'), { status: 'resolved' });

    await setPolicy({ alertLeads: false, moveAfterMinutes: null, moveTo: { kind: 'queue' } });
    const quiet = await waiting('A quiet one');
    later(11);
    await deadlinesCome();
    expect(await pending(SLA_ALERT_TOPIC, quiet)).toEqual([]);
    expect(await pending(SLA_MOVE_TOPIC, quiet)).toEqual([]);
    await shop.owner.post(inbox(quiet, '/status'), { status: 'resolved' });
  });

  it('escalates a breach the settings did not cause, even one before they were saved', async () => {
    const id = await claimed(amina, 'Is the shop open on Friday?');
    later(3);
    await setPolicy({ alertLeads: false, moveAfterMinutes: 5, moveTo: { kind: 'queue' } });
    later(2);
    // Urgent gets 2 minutes: overdue at once, with a deadline from before the settings were saved.
    const urgent = await amina.client.post(inbox(id, '/priority'), { priority: 'urgent' });
    expect(urgent.status, JSON.stringify(urgent.body)).toBe(200);
    await slice.drain();
    expect((await row(id)).sla).toMatchObject({ breached: true });
    expect(await pending(SLA_MOVE_TOPIC, id)).toHaveLength(1);
    await shop.owner.post(inbox(id, '/status'), { status: 'resolved' });
  });

  it('does not escalate the backlog when a target is shortened', async () => {
    await setPolicy({ alertLeads: true, moveAfterMinutes: 5, moveTo: { kind: 'queue' } });
    const old = await waiting('Waiting a while');
    later(7);
    // Medium now gets 5 minutes: the conversation is overdue at once, as the change made it.
    await rayan.client.put(policyPath(), {
      enabled: true,
      targets: { ...targets, medium: { firstReplyMinutes: 5, nextReplyMinutes: 20 } },
    });
    await slice.drain();
    expect((await row(old)).sla).toMatchObject({ breached: true });
    expect(await pending(SLA_ALERT_TOPIC, old)).toEqual([]);
    expect(await pending(SLA_MOVE_TOPIC, old)).toEqual([]);
    await shop.owner.post(inbox(old, '/status'), { status: 'resolved' });
    await setPolicy({ alertLeads: false, moveAfterMinutes: null, moveTo: { kind: 'queue' } });
  });

  it('keeps everything to its own tenant', async () => {
    const theirs = await withTenant(
      slice.app,
      { tenantId: fromPublicId('tenant', other.tenantId) },
      (tx) =>
        tx
          .select({ id: schema.outboxEvents.id })
          .from(schema.outboxEvents)
          .where(inArray(schema.outboxEvents.topic, [SLA_ALERT_TOPIC, SLA_MOVE_TOPIC])),
    );
    expect(theirs).toEqual([]);
  });
});
