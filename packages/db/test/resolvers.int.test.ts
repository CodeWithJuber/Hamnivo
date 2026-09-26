import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimOutbox,
  purgeExpired,
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
    expect(purged).toEqual({ conversation_journal: 1, identity_nonces: 0, idempotency_keys: 0 });
    const remaining = await withTenant(h.app, { tenantId: a.tenantId }, (tx) =>
      tx.select().from(schema.conversationJournal),
    );
    expect(remaining.map((r) => r.seq)).toEqual([1]);
  });
});
