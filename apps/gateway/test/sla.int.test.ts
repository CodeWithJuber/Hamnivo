import { randomUUID } from 'node:crypto';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SLA_DUE_TOPIC } from '../src/inbox/sla.js';
import type { Client } from './harness.js';
import { audits, customerStarts, join, type Shop } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice, type Visitor } from './slice-harness.js';

/**
 * Reply-time targets (H12, HNV-08-02, HNV-08-06): a brand sets how soon people reply per priority;
 * each conversation waiting for a person carries a clock in business time, goes overdue (queue,
 * count, audit) when nobody replied in time, and urgent waiting conversations are listed first.
 * The test moves the gateway's clock; deadlines that come are made due in the outbox by hand.
 */

let offsetMs = 0;
const now = () => new Date(Date.now() + offsetMs);
const later = (minutes: number) => {
  offsetMs += minutes * 60_000;
};

let slice: Slice;
let shop: Shop;
let other: Shop;
let tenantId: string;
let amina: { client: Client; staffId: string };
let rayan: { client: Client; staffId: string };

const policy = {
  enabled: true,
  targets: {
    urgent: { firstReplyMinutes: 2, nextReplyMinutes: 4 },
    high: { firstReplyMinutes: 5, nextReplyMinutes: 10 },
    medium: { firstReplyMinutes: 10, nextReplyMinutes: 20 },
    low: { firstReplyMinutes: null, nextReplyMinutes: null },
  },
};

const inbox = (id: string, rest = '') => `/v1/inbox/conversations/${id}${rest}`;

async function waiting(text: string): Promise<{ visitor: Visitor; id: string }> {
  const { visitor, conversationId } = await customerStarts(slice, shop, text);
  const handoff = await visitor.call('POST', `/v1/widget/conversations/${conversationId}/handoff`, {
    clientRequestId: randomUUID(),
    note: 'a person, please',
  });
  expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
  await slice.drain();
  return { visitor, id: conversationId };
}

async function row(id: string, client: Client = shop.owner) {
  const detail = await client.get(inbox(id));
  expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  return detail.body;
}

/** The deadlines that have come, as the outbox relay would run them. */
async function deadlinesCome() {
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .update(schema.outboxEvents)
      .set({ availableAt: new Date(Date.now() - 1000) })
      .where(
        and(eq(schema.outboxEvents.topic, SLA_DUE_TOPIC), isNull(schema.outboxEvents.processedAt)),
      ),
  );
  await slice.drain();
}

beforeAll(async () => {
  slice = await startSlice({ clock: now });
  shop = await connectedTenant(slice, 'sla');
  other = await connectedTenant(slice, 'sla-other');
  tenantId = fromPublicId('tenant', shop.tenantId);
  amina = await join(slice, shop, 'Amina Agent', 'agent');
  rayan = await join(slice, shop, 'Rayan Lead', 'supervisor');
}, 120_000);

afterAll(async () => {
  await slice?.close();
});

describe('reply-time targets (H12)', () => {
  it('are set per brand by people who configure the inbox', async () => {
    const path = `/v1/admin/brands/${shop.brand.id}/sla-policy`;
    const empty = await shop.owner.get(path);
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(empty.body).toMatchObject({ enabled: false, updatedAt: null });
    expect((await amina.client.put(path, policy)).status).toBe(403);
    const saved = await rayan.client.put(path, policy);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, targets: policy.targets });
    expect((await shop.owner.get(path)).body.targets.urgent.firstReplyMinutes).toBe(2);
    // Out of range, and another tenant's brand.
    const bad = await shop.owner.put(path, {
      ...policy,
      targets: { ...policy.targets, high: { firstReplyMinutes: 0, nextReplyMinutes: 5 } },
    });
    expect(bad.status).toBe(422);
    expect((await other.owner.put(path, policy)).status).toBe(404);
    const trail = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select({ action: schema.auditEvents.action })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, 'brand.sla_policy.updated')),
    );
    expect(trail).toHaveLength(1);
  });

  it('starts a first-reply clock when a customer waits for a person, and goes overdue', async () => {
    const chat = await waiting('My parcel never arrived.');
    const first = await row(chat.id);
    expect(first.sla).toMatchObject({
      kind: 'first_reply',
      state: 'running',
      targetMinutes: 10,
      breached: false,
    });
    expect(first.sla.businessMinutesLeft).toBeGreaterThanOrEqual(9);
    const due = Date.parse(first.sla.dueAt);
    expect(due - now().getTime()).toBeGreaterThan(9 * 60_000);

    later(11);
    await deadlinesCome();
    const overdue = await row(chat.id);
    expect(overdue.sla).toMatchObject({ breached: true });
    expect(overdue.sla.businessMinutesLeft).toBeLessThan(0);
    const list = await shop.owner.get('/v1/inbox/conversations?queue=overdue');
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([chat.id]);
    expect(list.body.counts.overdue).toBe(1);
    expect((await audits(slice, shop, chat.id)).map((a) => a.action)).toContain(
      'conversation.sla_breached',
    );

    // A person's reply ends it; the customer's next message starts a next-reply clock.
    const sent = await amina.client.post(`/v1/conversations/${chat.id}/messages`, {
      clientMessageId: randomUUID(),
      text: 'Sorry about that, checking now.',
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await slice.drain();
    expect((await row(chat.id)).sla).toBeNull();
    expect(
      (await shop.owner.get('/v1/inbox/conversations?queue=overdue')).body.counts.overdue,
    ).toBe(0);
    const again = await chat.visitor.call('POST', `/v1/widget/conversations/${chat.id}/messages`, {
      clientMessageId: randomUUID(),
      parts: [{ type: 'text', text: 'Any news?' }],
    });
    expect(again.status, JSON.stringify(again.body)).toBe(202);
    await slice.drain();
    expect((await row(chat.id)).sla).toMatchObject({ kind: 'next_reply', targetMinutes: 20 });

    // A higher priority has a shorter target.
    const urgent = await amina.client.post(inbox(chat.id, '/priority'), { priority: 'urgent' });
    expect(urgent.status, JSON.stringify(urgent.body)).toBe(200);
    expect((await row(chat.id)).sla).toMatchObject({ kind: 'next_reply', targetMinutes: 4 });

    // Snoozing pauses it; the time snoozed moves the deadline out.
    const before = Date.parse((await row(chat.id)).sla.dueAt);
    const snoozed = await amina.client.post(inbox(chat.id, '/status'), {
      status: 'snoozed',
      snoozedUntil: new Date(now().getTime() + 3_600_000).toISOString(),
    });
    expect(snoozed.status, JSON.stringify(snoozed.body)).toBe(200);
    expect((await row(chat.id)).sla).toMatchObject({ state: 'paused', dueAt: null });
    later(3);
    const reopened = await amina.client.post(inbox(chat.id, '/status'), { status: 'open' });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    const resumed = await row(chat.id);
    expect(resumed.sla.state).toBe('running');
    expect(Date.parse(resumed.sla.dueAt) - before).toBeGreaterThanOrEqual(3 * 60_000 - 1000);

    // Resolving ends it.
    await amina.client.post(inbox(chat.id, '/status'), { status: 'resolved' });
    expect((await row(chat.id)).sla).toBeNull();
  });

  it('waits outside business hours', async () => {
    const closed = {
      timezone: 'UTC',
      weekly: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
      closedDates: [],
    };
    const hours = await shop.owner.put(`/v1/admin/brands/${shop.brand.id}/business-hours`, {
      businessHours: closed,
    });
    expect(hours.status, JSON.stringify(hours.body)).toBe(200);
    const chat = await waiting('Are you open tomorrow?');
    expect((await row(chat.id)).sla).toMatchObject({ state: 'outside_hours', dueAt: null });
    await shop.owner.put(`/v1/admin/brands/${shop.brand.id}/business-hours`, {
      businessHours: null,
    });
    await slice.drain();
    expect((await row(chat.id)).sla).toMatchObject({ state: 'running', breached: false });
    await amina.client.post(inbox(chat.id, '/status'), { status: 'resolved' });
  });
});

describe('unassigned urgent work (HNV-08-02)', () => {
  it('lists urgent conversations waiting for a person, soonest deadline first', async () => {
    const one = await waiting('Payment taken twice!');
    const two = await waiting('Wrong item delivered.');
    const calm = await waiting('Just a question about sizes.');
    for (const chat of [two, one]) {
      const set = await rayan.client.post(inbox(chat.id, '/priority'), { priority: 'urgent' });
      expect(set.status).toBe(200);
      later(1);
    }
    const urgent = await amina.client.get('/v1/inbox/urgent');
    expect(urgent.status, JSON.stringify(urgent.body)).toBe(200);
    const listed = urgent.body.items.map((i: { id: string }) => i.id);
    expect(listed).toEqual([one.id, two.id]);
    expect(listed).not.toContain(calm.id);
    expect(urgent.body.total).toBe(2);
    expect(urgent.body.items[0]).toMatchObject({
      priority: 'urgent',
      ownerReason: 'customer_request',
      sla: { kind: 'first_reply', targetMinutes: 2 },
    });
    // Another tenant sees none of them.
    expect((await other.owner.get('/v1/inbox/urgent')).body).toEqual({ items: [], total: 0 });
  });

  it('a claim that loses says who won', async () => {
    const chat = await waiting('Can someone help me?');
    const epoch = (await row(chat.id, amina.client)).ownershipEpoch;
    const claimed = await rayan.client.post(inbox(chat.id, '/assign'), {
      to: { kind: 'me' },
      expectedEpoch: epoch,
    });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    const late = await amina.client.post(inbox(chat.id, '/assign'), {
      to: { kind: 'me' },
      expectedEpoch: epoch,
    });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({
      code: 'OWNERSHIP_CHANGED',
      currentOwner: { kind: 'staff', displayName: 'Rayan Lead', ownershipEpoch: epoch + 1 },
    });
    // The claim keeps the first-reply clock running; the claimer's reply ends it.
    expect((await row(chat.id)).sla).toMatchObject({ kind: 'first_reply' });
  });
});

describe('the Overdue queue (H12)', () => {
  it('lists the longest overdue first, page after page', async () => {
    const a = await waiting('Order 1 is late.');
    later(1);
    const b = await waiting('Order 2 is late.');
    later(15);
    await deadlinesCome();
    const all = await shop.owner.get('/v1/inbox/conversations?queue=overdue&limit=50');
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const items = all.body.items as { id: string; sla: { dueAt: string; breached: boolean } }[];
    const ids = items.map((i) => i.id);
    expect(ids.indexOf(a.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));
    const due = items.map((i) => Date.parse(i.sla.dueAt));
    expect(due).toEqual([...due].sort((x, y) => x - y));
    expect(items.every((i) => i.sla.breached)).toBe(true);
    expect(all.body.counts.overdue).toBe(ids.length);

    // Two at a time, the pages follow the same order.
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const page = await shop.owner.get(`/v1/inbox/conversations?queue=overdue&limit=2${query}`);
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      paged.push(...page.body.items.map((i: { id: string }) => i.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(paged).toEqual(ids);
  });
});
