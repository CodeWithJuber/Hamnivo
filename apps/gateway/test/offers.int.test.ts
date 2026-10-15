import { randomUUID } from 'node:crypto';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OFFER_TIMEOUT_TOPIC } from '../src/inbox/offers.js';
import type { Client } from './harness.js';
import { audits, customerStarts, join, type Shop } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice } from './slice-harness.js';

/**
 * Hand-off offered to one person at a time (HNV-10-03, HNV-10-06, H02). A team in `offer` mode
 * offers each conversation handed to it to the best person who can take it now; they accept or
 * decline with a reason, and a decline or the end of the offer's time offers it to the next
 * person, up to three. An offer is not ownership: colleagues can still claim the conversation.
 * Offer deadlines that come are made due in the outbox by hand.
 */

let slice: Slice;
let shop: Shop;
let other: Shop;
let tenantId: string;
let teamId: string;
type Person = { client: Client; staffId: string };
let amina: Person;
let bilal: Person;
let chen: Person;
let rayan: Person;

const inbox = (id: string, rest = '') => `/v1/inbox/conversations/${id}${rest}`;

async function online(...people: Person[]) {
  for (const person of people) {
    const chosen = await person.client.put('/v1/inbox/availability', { status: 'online' });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    const ping = await person.client.post('/v1/inbox/availability/ping', { active: true });
    expect(ping.status, JSON.stringify(ping.body)).toBe(200);
  }
}

/** A customer asks for a person; the conversation is put in the team (routing would). */
async function handedToTeam(text: string): Promise<string> {
  const { visitor, conversationId } = await customerStarts(slice, shop, text);
  const handoff = await visitor.call('POST', `/v1/widget/conversations/${conversationId}/handoff`, {
    clientRequestId: randomUUID(),
    note: 'a person, please',
  });
  expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
  await slice.drain();
  const team = await shop.owner.post(inbox(conversationId, '/team'), { teamId });
  expect(team.status, JSON.stringify(team.body)).toBe(200);
  await slice.drain();
  return conversationId;
}

async function detail(id: string, client: Client = shop.owner) {
  const found = await client.get(inbox(id));
  expect(found.status, JSON.stringify(found.body)).toBe(200);
  return found.body;
}

async function offersOf(person: Person): Promise<{ id: string; offer: { id: string } }[]> {
  const list = await person.client.get('/v1/inbox/offers');
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  return list.body.items;
}

/** Whom the conversation is offered to now (null: nobody). */
async function offeredTo(id: string): Promise<{ staffMemberId: string; id: string } | null> {
  return (await detail(id)).offer;
}

const byStaff = (staffId: string) => [amina, bilal, chen].find((p) => p.staffId === staffId);

/** The offers' time is up, as the outbox relay would run it. */
async function timeIsUp() {
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .update(schema.outboxEvents)
      .set({ availableAt: new Date(Date.now() - 1000) })
      .where(
        and(
          eq(schema.outboxEvents.topic, OFFER_TIMEOUT_TOPIC),
          isNull(schema.outboxEvents.processedAt),
        ),
      ),
  );
  await slice.drain();
}

async function inboxState(id: string) {
  const [state] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.conversationInboxState)
      .where(eq(schema.conversationInboxState.conversationId, fromPublicId('conversation', id))),
  );
  return state;
}

beforeAll(async () => {
  slice = await startSlice();
  shop = await connectedTenant(slice, 'offers');
  other = await connectedTenant(slice, 'offers-other');
  tenantId = fromPublicId('tenant', shop.tenantId);
  amina = await join(slice, shop, 'Amina Agent', 'agent');
  bilal = await join(slice, shop, 'Bilal Agent', 'agent');
  chen = await join(slice, shop, 'Chen Agent', 'agent');
  rayan = await join(slice, shop, 'Rayan Lead', 'supervisor');
  const team = await shop.owner.post('/v1/admin/teams', {
    name: 'Care',
    workspaceId: shop.workspaceId,
  });
  expect(team.status, JSON.stringify(team.body)).toBe(201);
  teamId = team.body.id;
  const members = await shop.owner.put(`/v1/admin/teams/${teamId}/members`, {
    staffMemberIds: [amina.staffId, bilal.staffId, chen.staffId],
  });
  expect(members.status, JSON.stringify(members.body)).toBe(200);
}, 120_000);

afterAll(async () => {
  await slice?.close();
});

describe('hand-off offered to one person (HNV-10-03, HNV-10-06)', () => {
  it('is set per team and per person by people who manage teams', async () => {
    const created = (await shop.owner.get('/v1/admin/teams')).body.items.find(
      (t: { id: string }) => t.id === teamId,
    );
    expect(created).toMatchObject({ assignmentMode: 'queue', offerTimeoutSeconds: 60 });
    expect(
      (await amina.client.patch(`/v1/admin/teams/${teamId}`, { assignmentMode: 'offer' })).status,
    ).toBe(403);
    expect(
      (await shop.owner.patch(`/v1/admin/teams/${teamId}`, { offerTimeoutSeconds: 5 })).status,
    ).toBe(422);
    const saved = await shop.owner.patch(`/v1/admin/teams/${teamId}`, {
      assignmentMode: 'offer',
      offerTimeoutSeconds: 45,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ assignmentMode: 'offer', offerTimeoutSeconds: 45 });
    expect((await other.owner.patch(`/v1/admin/teams/${teamId}`, { name: 'X' })).status).toBe(404);

    const profile = (staffId: string) => `/v1/admin/routing-profiles/${staffId}`;
    expect(
      (await amina.client.put(profile(amina.staffId), { languages: ['en'], maxOpenChats: 3 }))
        .status,
    ).toBe(403);
    const bad = await shop.owner.put(profile(amina.staffId), {
      languages: ['klingon'],
      maxOpenChats: 3,
    });
    expect(bad.status).toBe(422);
    for (const [person, languages] of [
      [amina, ['ur']],
      [bilal, ['en', 'hi']],
      [chen, []],
    ] as const) {
      const set = await shop.owner.put(profile(person.staffId), {
        languages,
        maxOpenChats: null,
      });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
    }
    const list = await shop.owner.get('/v1/admin/routing-profiles');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(
      list.body.items.find((p: { staffMemberId: string }) => p.staffMemberId === bilal.staffId),
    ).toMatchObject({ displayName: 'Bilal Agent', languages: ['en', 'hi'], maxOpenChats: null });
    expect(
      (await other.owner.put(profile(bilal.staffId), { languages: [], maxOpenChats: null })).status,
    ).toBe(404);
  });

  it('offers a conversation to the teammate who speaks the language, and accepting makes it theirs', async () => {
    await online(amina, bilal, chen);
    const id = await handedToTeam('My parcel never arrived, can someone help?');
    const offer = await offeredTo(id);
    expect(offer).toMatchObject({
      staffMemberId: bilal.staffId,
      displayName: 'Bilal Agent',
      round: 1,
    });
    const row = await detail(id);
    // An offer is not ownership: the conversation still waits in the queue.
    expect(row.ownerMode).toBe('WAITING_HUMAN');
    expect(Date.parse(row.offer.expiresAt) - Date.now()).toBeGreaterThan(30_000);
    expect((await offersOf(bilal)).map((item) => item.id)).toEqual([id]);
    expect(await offersOf(amina)).toEqual([]);

    // Only the person offered can decide; another tenant does not see it at all.
    const offerId = row.offer.id as string;
    expect((await amina.client.post(`/v1/inbox/offers/${offerId}/accept`, {})).status).toBe(404);
    expect((await other.owner.post(`/v1/inbox/offers/${offerId}/accept`, {})).status).toBe(404);

    const accepted = await bilal.client.post(`/v1/inbox/offers/${offerId}/accept`, {});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body).toEqual({ conversationId: id, state: 'accepted' });
    const after = await detail(id);
    expect(after).toMatchObject({
      ownerMode: 'HUMAN_ACTIVE',
      owner: { kind: 'staff', staffMemberId: bilal.staffId },
      ownerReason: 'offer_accepted',
      offer: null,
    });
    // Accepting twice is refused, saying who has it.
    const again = await bilal.client.post(`/v1/inbox/offers/${offerId}/accept`, {});
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'OFFER_CLOSED' });
    expect(again.body.detail).toContain('Bilal Agent');
    expect((await audits(slice, shop, id)).map((a) => a.action)).toEqual(
      expect.arrayContaining(['conversation.offered', 'conversation.offer_accepted']),
    );

    // The assign menu says how busy each person is.
    const assignees = await shop.owner.get(inbox(id, '/assignees'));
    expect(
      assignees.body.staff.find(
        (s: { staffMemberId: string }) => s.staffMemberId === bilal.staffId,
      ),
    ).toMatchObject({ openChats: 1, maxOpenChats: null });
  });

  it('offers it to the next person after a decline or when time is up, and to three people at most', async () => {
    const id = await handedToTeam('Hello, I need to change my order.');
    const first = await offeredTo(id);
    expect(first?.staffMemberId).toBe(bilal.staffId);
    const bad = await bilal.client.post(`/v1/inbox/offers/${first?.id}/decline`, {});
    expect(bad.status).toBe(422);
    const declined = await bilal.client.post(`/v1/inbox/offers/${first?.id}/decline`, {
      reason: 'at_capacity',
      note: 'Two calls at once.',
    });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body).toEqual({ conversationId: id, state: 'declined' });

    const second = await offeredTo(id);
    expect(second).toMatchObject({ round: 2 });
    expect([amina.staffId, chen.staffId]).toContain(second?.staffMemberId);
    const secondPerson = byStaff(second?.staffMemberId ?? '') as Person;
    await timeIsUp();
    const third = await offeredTo(id);
    expect(third).toMatchObject({ round: 3 });
    expect(third?.staffMemberId).not.toBe(second?.staffMemberId);
    expect(third?.staffMemberId).not.toBe(bilal.staffId);

    // Too late: the offer expired and went on.
    const late = await secondPerson.client.post(`/v1/inbox/offers/${second?.id}/accept`, {});
    expect(late.status).toBe(409);
    expect(late.body.detail).toContain('ran out');

    await timeIsUp();
    expect(await offeredTo(id)).toBeNull();
    const row = await detail(id);
    expect(row.ownerMode).toBe('WAITING_HUMAN');
    const state = await inboxState(id);
    expect(state?.offersEndedEpoch).toBe(row.ownershipEpoch);
    const actions = (await audits(slice, shop, id)).map((a) => a.action);
    expect(actions.filter((a) => a === 'conversation.offered')).toHaveLength(3);
    expect(actions).toEqual(
      expect.arrayContaining([
        'conversation.offer_declined',
        'conversation.offer_expired',
        'conversation.offers_ended',
      ]),
    );
    // Anyone in the team can still claim it from the queue.
    const claimed = await amina.client.post(inbox(id, '/assign'), { to: { kind: 'me' } });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
  });

  it('ends the offer when a colleague claims the conversation, and names them', async () => {
    const id = await handedToTeam('Is anyone there? My card was charged twice.');
    const offer = await offeredTo(id);
    expect(offer).not.toBeNull();
    const person = byStaff(offer?.staffMemberId ?? '') as Person;
    const claimed = await rayan.client.post(inbox(id, '/assign'), { to: { kind: 'me' } });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(await offersOf(person)).toEqual([]);
    const accepted = await person.client.post(`/v1/inbox/offers/${offer?.id}/accept`, {});
    expect(accepted.status).toBe(409);
    expect(accepted.body).toMatchObject({
      code: 'OFFER_CLOSED',
      currentOwner: { kind: 'staff', displayName: 'Rayan Lead' },
    });
    expect(accepted.body.detail).toBe('Rayan Lead already has this conversation.');
    const cancelled = (await audits(slice, shop, id)).find(
      (a) => a.action === 'conversation.offer_cancelled',
    );
    expect(cancelled?.data).toMatchObject({ reason: 'owner_changed' });
  });

  it('ends the offer when the conversation is resolved', async () => {
    const id = await handedToTeam('Never mind, all sorted.');
    expect(await offeredTo(id)).not.toBeNull();
    const resolved = await shop.owner.post(inbox(id, '/status'), { status: 'resolved' });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const cancelled = (await audits(slice, shop, id)).find(
      (a) => a.action === 'conversation.offer_cancelled',
    );
    expect(cancelled?.data).toMatchObject({ reason: 'resolved' });
  });

  it('skips people who are away, at their limit or already holding an offer', async () => {
    // Bilal has two chats now and a limit of two; Amina is away.
    const limit = await shop.owner.put(`/v1/admin/routing-profiles/${bilal.staffId}`, {
      languages: ['en'],
      maxOpenChats: 1,
    });
    expect(limit.status, JSON.stringify(limit.body)).toBe(200);
    const away = await amina.client.put('/v1/inbox/availability', { status: 'away' });
    expect(away.status, JSON.stringify(away.body)).toBe(200);

    const first = await handedToTeam('Where can I see my invoice?');
    expect(await offeredTo(first)).toMatchObject({ staffMemberId: chen.staffId, round: 1 });
    // Chen holds that offer; nobody else can take the next one, so it waits in the queue.
    const second = await handedToTeam('Do you ship to Lahore?');
    expect(await offeredTo(second)).toBeNull();
    expect((await inboxState(second))?.offersEndedEpoch).not.toBeNull();

    // Chen goes offline: the offer is declined for them and goes on (to nobody here).
    const offline = await chen.client.put('/v1/inbox/availability', { status: 'offline' });
    expect(offline.status, JSON.stringify(offline.body)).toBe(200);
    await slice.drain();
    expect(await offersOf(chen)).toEqual([]);
    const declined = (await audits(slice, shop, first)).find(
      (a) => a.action === 'conversation.offer_declined',
    );
    expect(declined?.data).toMatchObject({ reason: 'going_offline' });
    expect(await offeredTo(first)).toBeNull();
  });

  it('leaves conversations of a team in queue mode to the queue', async () => {
    const queued = await shop.owner.patch(`/v1/admin/teams/${teamId}`, { assignmentMode: 'queue' });
    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    await online(amina, bilal, chen);
    const id = await handedToTeam('Just a question about sizes.');
    expect(await offeredTo(id)).toBeNull();
    expect((await audits(slice, shop, id)).map((a) => a.action)).not.toContain(
      'conversation.offered',
    );
  });
});
