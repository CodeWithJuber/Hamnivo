import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimIntegrationInbox,
  claimOutbox,
  claimReconcileCursors,
  closeDb,
  createDb,
  ensureReconcileCursors,
  purgeExpired,
  purgeMigrationFiles,
  resolveApiKey,
  resolveAuthorityConnection,
  resolveStaffMemberships,
  resolveTenantSlug,
  resolveWidget,
  resolveWidgetSession,
  schema,
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

describe('pre-tenant resolvers', () => {
  it('resolves a public widget id to its tenant and brand', async () => {
    const resolved = await resolveWidget(h.app, a.widgetPublicId);
    expect(resolved).toMatchObject({
      tenantId: a.tenantId,
      brandId: a.brandId,
      workspaceId: a.workspaceId,
      brandStatus: 'active',
      tenantStatus: 'active',
      configVersion: 1,
    });
    expect(resolved?.allowedOrigins).toEqual([`https://${a.slug}.example`]);
    expect(await resolveWidget(h.app, 'wid_01j9zk7w3xq8r4t2v6m5n1p0cd')).toBeNull();
  });

  it('resolves API keys, sessions, connections, slugs and staff memberships', async () => {
    const key = await resolveApiKey(h.app, a.apiKeyPrefix);
    expect(key?.tenantId).toBe(a.tenantId);
    expect(Buffer.isBuffer(key?.secretHash)).toBe(true);
    expect(await resolveApiKey(h.app, 'hv_test_missing')).toBeNull();

    expect(await resolveWidgetSession(h.app, b.sessionId)).toBe(b.tenantId);
    expect((await resolveAuthorityConnection(h.app, b.connectionId))?.tenantId).toBe(b.tenantId);
    expect((await resolveTenantSlug(h.app, a.slug.toUpperCase()))?.tenantId).toBe(a.tenantId);

    const memberships = await resolveStaffMemberships(h.app, a.authUserId);
    expect(memberships).toEqual([
      expect.objectContaining({
        tenantId: a.tenantId,
        staffMemberId: a.staffMemberId,
        tenantSlug: a.slug,
      }),
    ]);
  });

  it('is not callable by the platform role', async () => {
    await expectPgError(h.platform.execute(sql`select * from app.resolve_widget('x')`), '42501');
  });
});

describe('worker maintenance', () => {
  it('leases outbox events across tenants exactly once until the lease expires', async () => {
    const first = await claimOutbox(h.app, { limit: 10, leaseSeconds: 60 });
    expect(new Set(first.map((e) => e.tenantId))).toEqual(new Set([a.tenantId, b.tenantId]));
    expect(first.every((e) => e.attempts === 1)).toBe(true);
    expect(await claimOutbox(h.app, { limit: 10, leaseSeconds: 60 })).toEqual([]);

    // Acknowledge inside the owning tenant; another tenant cannot acknowledge it.
    const event = first.find((e) => e.tenantId === a.tenantId);
    if (!event) throw new Error('missing tenant A event');
    const foreign = await withTenant(h.app, { tenantId: b.tenantId }, (tx) =>
      tx.execute(sql`update outbox_events set processed_at = now() where id = ${event.id}::uuid`),
    );
    expect(foreign.rowCount).toBe(0);
    const own = await withTenant(h.app, { tenantId: a.tenantId }, (tx) =>
      tx.execute(sql`update outbox_events set processed_at = now() where id = ${event.id}::uuid`),
    );
    expect(own.rowCount).toBe(1);
  });

  it('leases webhook events across tenants and purges them a week after processing', async () => {
    const first = await claimIntegrationInbox(h.app, { limit: 10, leaseSeconds: 60 });
    expect(new Set(first.map((e) => e.tenantId))).toEqual(new Set([a.tenantId, b.tenantId]));
    expect(first.find((e) => e.tenantId === a.tenantId)).toMatchObject({
      connectionId: a.connectionId,
      attempts: 1,
    });
    expect(await claimIntegrationInbox(h.app, { limit: 10, leaseSeconds: 60 })).toEqual([]);

    const event = first.find((e) => e.tenantId === a.tenantId);
    if (!event) throw new Error('missing tenant A event');
    const processedAt = new Date(Date.now() - 8 * 24 * 3600_000);
    const foreign = await withTenant(h.app, { tenantId: b.tenantId }, (tx) =>
      tx.execute(
        sql`update integration_inbox set processed_at = ${processedAt} where id = ${event.id}::uuid`,
      ),
    );
    expect(foreign.rowCount).toBe(0);
    await withTenant(h.app, { tenantId: a.tenantId }, (tx) =>
      tx.execute(
        sql`update integration_inbox set processed_at = ${processedAt} where id = ${event.id}::uuid`,
      ),
    );
    expect(await purgeExpired(h.app)).toMatchObject({ integration_inbox: 1 });
    const left = await withTenant(h.app, { tenantId: b.tenantId }, (tx) =>
      tx.select().from(schema.integrationInbox),
    );
    expect(left).toHaveLength(1);
  });

  it('purges only expired journal entries, nonces and idempotency keys', async () => {
    await withTenant(h.app, { tenantId: a.tenantId }, async (tx) => {
      await tx.insert(schema.conversationJournal).values({
        tenantId: a.tenantId,
        conversationId: a.conversationId,
        seq: 2,
        lane: 'customer',
        eventType: 'message.created',
        event: { text: 'old' },
        expiresAt: new Date(Date.now() - 60_000),
      });
    });
    const purged = await purgeExpired(h.app);
    expect(purged).toEqual({
      conversation_journal: 1,
      identity_nonces: 0,
      idempotency_keys: 0,
      integration_inbox: 0,
    });
    const remaining = await withTenant(h.app, { tenantId: a.tenantId }, (tx) =>
      tx.select().from(schema.conversationJournal),
    );
    expect(remaining.map((r) => r.seq)).toEqual([1]);
  });

  it('clears uploaded migration exports once their retention has passed, in every tenant', async () => {
    const past = new Date(Date.now() - 60_000);
    await withTenant(h.app, { tenantId: a.tenantId }, (tx) =>
      tx.update(schema.migrationFiles).set({ purgeAfter: past }),
    );
    await withTenant(h.app, { tenantId: b.tenantId }, (tx) =>
      tx.update(schema.migrationFiles).set({ purgeAfter: new Date(Date.now() + 86_400_000) }),
    );
    expect(await purgeMigrationFiles(h.app)).toBe(1);
    const [purged] = await withTenant(h.app, { tenantId: a.tenantId }, (tx) =>
      tx.select().from(schema.migrationFiles),
    );
    expect(purged).toMatchObject({ raw: null, state: 'purged' });
    expect(purged?.purgedAt).toBeInstanceOf(Date);
    const [kept] = await withTenant(h.app, { tenantId: b.tenantId }, (tx) =>
      tx.select().from(schema.migrationFiles),
    );
    expect(kept?.raw).toBeInstanceOf(Buffer);
    expect(await purgeMigrationFiles(h.app)).toBe(0);
  });

  it('leases due reconciler cursors across tenants and follows conversations without one', async () => {
    const first = await claimReconcileCursors(h.app, { limit: 10, leaseSeconds: 60 });
    expect(new Set(first.map((c) => c.tenantId))).toEqual(new Set([a.tenantId, b.tenantId]));
    expect(first.find((c) => c.tenantId === a.tenantId)).toMatchObject({
      connectionId: a.connectionId,
      conversationRef: '11',
      lastExternalId: null,
    });
    expect(await claimReconcileCursors(h.app, { limit: 10, leaseSeconds: 60 })).toEqual([]);

    // Conversations without a cursor are followed from the newest message already journaled.
    await withTenant(h.app, { tenantId: b.tenantId }, async (tx) => {
      await tx.delete(schema.reconcileCursors);
      await tx.update(schema.conversationJournal).set({ authorityId: 41 });
    });
    expect(await ensureReconcileCursors(h.app)).toBe(1);
    const followed = await withTenant(h.app, { tenantId: b.tenantId }, (tx) =>
      tx.select().from(schema.reconcileCursors),
    );
    expect(followed).toEqual([
      expect.objectContaining({ scope: 'conversation', scopeRef: '11', lastExternalId: 41 }),
    ]);
    expect(await ensureReconcileCursors(h.app)).toBe(0);
  });
});

// Runs last: it leases every due event, which the tests above count on finding.
describe('lease order', () => {
  it('hands out events in the order they were recorded, whatever plan the database picks', async () => {
    // The later rows are stored first, so the table's physical order is the reverse of the
    // recorded order. A hash join returns rows in physical order unless they are sorted.
    const earlier = '01800000-0000-7000-8000-000000000001';
    const later = '01800000-0000-7000-8000-000000000002';
    const dueAt = new Date(Date.now() - 60_000);
    for (const id of [later, earlier]) {
      await withTenant(h.app, { tenantId: a.tenantId }, async (tx) => {
        await tx.insert(schema.outboxEvents).values({
          id,
          tenantId: a.tenantId,
          topic: 'test.order',
          aggregateType: 'conversation',
          aggregateId: 'c1',
          payload: {},
          availableAt: dueAt,
        });
        await tx.insert(schema.integrationInbox).values({
          id,
          tenantId: a.tenantId,
          connectionId: a.connectionId,
          source: 'account',
          dedupeKey: `order-test:${id}`,
          eventType: 'test.order',
          payload: {},
          availableAt: dueAt,
        });
      });
    }
    const hashJoins = createDb(
      `${h.database.app}${h.database.app.includes('?') ? '&' : '?'}options=${encodeURIComponent(
        '-c enable_nestloop=off -c enable_mergejoin=off',
      )}`,
      { max: 1 },
    );
    try {
      const outbox = await claimOutbox(hashJoins, { limit: 50, leaseSeconds: 60 });
      expect(outbox.filter((e) => e.topic === 'test.order').map((e) => e.id)).toEqual([
        earlier,
        later,
      ]);
      const inbox = await claimIntegrationInbox(hashJoins, { limit: 50, leaseSeconds: 60 });
      expect(inbox.map((e) => e.id).filter((id) => id === earlier || id === later)).toEqual([
        earlier,
        later,
      ]);
    } finally {
      await closeDb(hashJoins);
    }
  });
});
