import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newId,
  purgeOutboxEvents,
  retentionDue,
  retentionOrphans,
  retireConversation,
  retireCustomer,
  schema,
  type TenantTx,
  withTenant,
} from '../src/index.js';
import { type SeededTenant, seedTenant } from '../src/testing/index.js';
import { expectPgError, type Harness, openHarness } from './helpers.js';

let h: Harness;
let a: SeededTenant;
let b: SeededTenant;

beforeAll(async () => {
  h = await openHarness();
  a = await seedTenant(h.app, 'alpha');
  b = await seedTenant(h.app, 'beta');
});

afterAll(async () => {
  await h?.close();
});

const inTenant = <T>(t: SeededTenant, work: (tx: TenantTx) => Promise<T>) =>
  withTenant(h.app, { tenantId: t.tenantId }, work);

async function setPolicy(t: SeededTenant, days: number | null) {
  await inTenant(t, (tx) =>
    tx
      .insert(schema.retentionPolicies)
      .values({ id: newId(), tenantId: t.tenantId, conversationDays: days })
      .onConflictDoUpdate({
        target: schema.retentionPolicies.tenantId,
        set: { conversationDays: days, pendingDays: null, pendingFrom: null },
      }),
  );
}

async function setConversation(
  t: SeededTenant,
  status: 'open' | 'resolved',
  daysAgo: number,
  id = t.conversationId,
) {
  await inTenant(t, (tx) =>
    tx
      .update(schema.conversationControls)
      .set({
        authorityStatus: status,
        lastActivityAt: sql`now() - make_interval(days => ${daysAgo}::int)`,
      })
      .where(eq(schema.conversationControls.id, id)),
  );
}

const count = (t: SeededTenant, table: string, conversationId = t.conversationId) =>
  inTenant(t, async (tx) => {
    const { rows } = await tx.execute<{ n: string }>(
      sql`select count(*) as n from ${sql.identifier(table)} where conversation_id = ${conversationId}::uuid`,
    );
    return Number(rows[0]?.n ?? 0);
  });

describe('retention (A10)', () => {
  it('keeps every conversation while retention is off, and new or open ones when it is on', async () => {
    await setConversation(a, 'resolved', 400);
    expect(await inTenant(a, (tx) => retireConversation(tx, a.conversationId))).toBe(false);

    await setPolicy(a, 90);
    await setConversation(a, 'open', 400);
    expect(await inTenant(a, (tx) => retireConversation(tx, a.conversationId))).toBe(false);
    await setConversation(a, 'resolved', 30);
    expect(await inTenant(a, (tx) => retireConversation(tx, a.conversationId))).toBe(false);
    expect(await count(a, 'conversation_journal')).toBeGreaterThan(0);
  });

  it('applies a change once its grace ends, and lists old resolved conversations per workspace', async () => {
    await setConversation(a, 'resolved', 400);
    await inTenant(a, (tx) =>
      tx
        .update(schema.retentionPolicies)
        .set({
          conversationDays: null,
          pendingDays: 365,
          pendingFrom: sql`now() + interval '1 day'`,
        })
        .where(eq(schema.retentionPolicies.tenantId, a.tenantId)),
    );
    // Still waiting: nothing is due.
    expect((await retentionDue(h.app)).some((d) => d.tenantId === a.tenantId)).toBe(false);

    await inTenant(a, (tx) =>
      tx
        .update(schema.retentionPolicies)
        .set({ pendingFrom: sql`now() - interval '1 minute'` })
        .where(eq(schema.retentionPolicies.tenantId, a.tenantId)),
    );
    const due = (await retentionDue(h.app)).filter((d) => d.tenantId === a.tenantId);
    expect(due.map((d) => d.conversationId)).toEqual([a.conversationId]);
    expect(due[0]?.cutoff.getTime()).toBeLessThan(Date.now() - 364 * 86_400_000);
    const [policy] = await inTenant(a, (tx) => tx.select().from(schema.retentionPolicies));
    expect(policy).toMatchObject({ conversationDays: 365, pendingDays: null, pendingFrom: null });

    // Beta never turned retention on.
    await setConversation(b, 'resolved', 4000);
    expect((await retentionDue(h.app)).some((d) => d.tenantId === b.tenantId)).toBe(false);
  });

  it('refuses without a tenant, and reaches no other tenant', async () => {
    await expectPgError(
      h.app.execute(sql`select app.retire_conversation(${a.conversationId}::uuid)`),
      '42501',
    );
    await setPolicy(b, 90);
    expect(await inTenant(b, (tx) => retireConversation(tx, a.conversationId))).toBe(false);
    expect(await count(a, 'conversation_journal')).toBeGreaterThan(0);
  });

  it('deletes an old resolved conversation and its records, keeping the anonymous report row', async () => {
    await setPolicy(a, 90);
    await setConversation(a, 'resolved', 400);
    const orders = await count(a, 'orders');
    const outcomes = await count(a, 'sla_outcomes');
    const runs = await count(a, 'runs');
    expect(orders).toBeGreaterThan(0);

    expect(await inTenant(a, (tx) => retireConversation(tx, a.conversationId))).toBe(true);

    const [control] = await inTenant(a, (tx) =>
      tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, a.conversationId)),
    );
    expect(control).toBeUndefined();
    for (const table of [
      'conversation_journal',
      'message_ledger',
      'publications',
      'conversation_feedback',
      'conversation_inbox_state',
      'ai_drafts',
      'actions',
      'handoff_packets',
      'decision_records',
      'decision_checks',
      'staff_drafts',
      'widget_uploads',
      'conversation_read_state',
      'customer_notifications',
      'ticket_followups',
    ]) {
      expect(await count(a, table), table).toBe(0);
    }
    // Business records and what reports count stay.
    expect(await count(a, 'orders')).toBe(orders);
    expect(await count(a, 'sla_outcomes')).toBe(outcomes);
    expect(await count(a, 'runs')).toBe(runs);
    const [metrics] = await inTenant(a, (tx) =>
      tx
        .select()
        .from(schema.conversationMetrics)
        .where(eq(schema.conversationMetrics.id, a.conversationId)),
    );
    expect(metrics?.retiredAt).toBeInstanceOf(Date);
    expect(metrics).toMatchObject({
      teamId: a.teamId,
      priority: 'high',
      ticketNumber: 1,
      ticketSource: 'offline_form',
      ratingCount: 1,
      ratingSum: 5,
    });

    // Gone means gone: a second call does nothing.
    expect(await inTenant(a, (tx) => retireConversation(tx, a.conversationId))).toBe(false);
    // The other tenant is untouched.
    expect(await count(b, 'conversation_journal')).toBeGreaterThan(0);
  });

  it('removes a customer left with nothing, but not one with orders or a live session', async () => {
    const lonely = newId();
    await inTenant(a, (tx) =>
      tx.insert(schema.customerPrincipals).values({
        id: lonely,
        tenantId: a.tenantId,
        brandId: a.brandId,
        kind: 'anonymous',
        createdAt: new Date(Date.now() - 500 * 86_400_000),
        lastSeenAt: new Date(Date.now() - 400 * 86_400_000),
      }),
    );
    const orphans = await inTenant(a, (tx) => retentionOrphans(tx));
    expect(orphans.map((o) => o.principalId)).toContain(lonely);
    // The seeded customer has an order, which keeps them.
    expect(orphans.map((o) => o.principalId)).not.toContain(a.principalId);
    expect(await inTenant(a, (tx) => retireCustomer(tx, a.principalId))).toBe(false);

    expect(await inTenant(a, (tx) => retireCustomer(tx, lonely))).toBe(true);
    const left = await inTenant(a, (tx) =>
      tx
        .select()
        .from(schema.customerPrincipals)
        .where(
          and(
            eq(schema.customerPrincipals.tenantId, a.tenantId),
            eq(schema.customerPrincipals.id, lonely),
          ),
        ),
    );
    expect(left).toEqual([]);
  });

  it('removes handled outbox events after 30 days', async () => {
    const old = newId();
    const recent = newId();
    await inTenant(a, (tx) =>
      tx.insert(schema.outboxEvents).values([
        {
          id: old,
          tenantId: a.tenantId,
          topic: 'test.event',
          aggregateType: 'test',
          aggregateId: 'x',
          payload: { text: 'old' },
          processedAt: new Date(Date.now() - 31 * 86_400_000),
        },
        {
          id: recent,
          tenantId: a.tenantId,
          topic: 'test.event',
          aggregateType: 'test',
          aggregateId: 'x',
          payload: { text: 'recent' },
          processedAt: new Date(Date.now() - 86_400_000),
        },
      ]),
    );
    expect(await purgeOutboxEvents(h.app)).toBeGreaterThanOrEqual(1);
    const ids = (
      await inTenant(a, (tx) => tx.select({ id: schema.outboxEvents.id }).from(schema.outboxEvents))
    ).map((row) => row.id);
    expect(ids).not.toContain(old);
    expect(ids).toContain(recent);
  });
});
