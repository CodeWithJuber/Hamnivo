import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimCommerceEvents,
  claimCommerceWork,
  newId,
  resolveMerchantConnection,
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

const inTenant =
  (tenant: SeededTenant) =>
  <T>(work: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(h.app, { tenantId: tenant.tenantId }, work);

async function firstOf<T extends keyof typeof schema>(tenant: SeededTenant, table: T) {
  const rows = (await inTenant(tenant)((tx) =>
    tx
      .select()
      .from(schema[table] as never)
      .limit(1),
  )) as Record<string, unknown>[];
  const row = rows[0];
  if (!row) throw new Error(`${String(table)} is not seeded`);
  return row;
}

describe('quotes', () => {
  it('keep every priced value once created; only the status moves', async () => {
    const quote = await firstOf(a, 'quotes');
    const byId = eq(schema.quotes.id, quote.id as string);
    for (const change of [
      { totalMinor: 1n },
      { currency: 'USD' },
      { document: { v: 1, totalMinor: '1' } },
      { hash: randomBytes(32) },
      { expiresAt: new Date(Date.now() + 86_400_000 * 30) },
      { cartRevision: 99 },
      { approver: 'staff' as const },
    ]) {
      await expectPgError(
        inTenant(a)((tx) => tx.update(schema.quotes).set(change).where(byId)),
        '23514',
      );
    }
    await inTenant(a)((tx) => tx.update(schema.quotes).set({ status: 'expired' }).where(byId));
  });
});

describe('financial records', () => {
  it('keeps receipts append-only and money records undeletable', async () => {
    const receipt = await firstOf(a, 'operationReceipts');
    await expectPgError(
      inTenant(a)((tx) =>
        tx
          .update(schema.operationReceipts)
          .set({ outcome: 'failed' })
          .where(eq(schema.operationReceipts.id, receipt.id as string)),
      ),
      '42501',
    );
    for (const table of ['payments', 'refunds', 'orders', 'operations', 'quotes'] as const) {
      await expectPgError(
        inTenant(a)((tx) => tx.execute(sql`delete from ${sql.identifier(table)}`)),
        '42501',
      );
    }
  });

  it('never records more refunded than captured', async () => {
    const payment = await firstOf(a, 'payments');
    await expectPgError(
      inTenant(a)((tx) =>
        tx
          .update(schema.payments)
          .set({ refundedMinor: (payment.capturedMinor as bigint) + 1n })
          .where(eq(schema.payments.id, payment.id as string)),
      ),
      '23514',
    );
  });

  it('keeps business keys unique per tenant, and separate between tenants', async () => {
    const operation = await firstOf(a, 'operations');
    const copy = {
      kind: 'commerce.checkout.create',
      businessKey: operation.businessKey as string,
      requestHash: randomBytes(32),
      actorType: 'system' as const,
      providerIdempotencyKey: 'hv:dup',
    };
    await expectPgError(
      inTenant(a)((tx) => tx.insert(schema.operations).values({ ...copy, tenantId: a.tenantId })),
      '23505',
    );
    await inTenant(b)((tx) =>
      tx.insert(schema.operations).values({ ...copy, tenantId: b.tenantId, id: newId() }),
    );
  });
});

describe('cross-tenant functions', () => {
  it('resolves a merchant webhook to its tenant and nothing else', async () => {
    const merchant = await firstOf(a, 'merchantConnections');
    expect(await resolveMerchantConnection(h.app, merchant.id as string)).toEqual({
      tenantId: a.tenantId,
      provider: 'mock',
      status: 'active',
      tenantStatus: 'active',
    });
    expect(await resolveMerchantConnection(h.app, newId())).toBeNull();
  });

  it('leases pending provider events once until the lease ends', async () => {
    const merchant = await firstOf(a, 'merchantConnections');
    const eventId = newId();
    await inTenant(a)((tx) =>
      tx.insert(schema.commerceEvents).values({
        id: eventId,
        tenantId: a.tenantId,
        merchantConnectionId: merchant.id as string,
        providerEventId: `evt_${randomBytes(4).toString('hex')}`,
        eventType: 'checkout.completed',
        providerType: 'checkout.session.completed',
        payload: {},
        bodyHash: randomBytes(32),
        occurredAt: new Date(),
      }),
    );
    const first = await claimCommerceEvents(h.app, { limit: 50, leaseSeconds: 60 });
    expect(first.find((e) => e.id === eventId)).toMatchObject({
      tenantId: a.tenantId,
      attempts: 1,
    });
    const second = await claimCommerceEvents(h.app, { limit: 50, leaseSeconds: 60 });
    expect(second.find((e) => e.id === eventId)).toBeUndefined();
  });

  it('leases due operations, payments and refunds across tenants', async () => {
    const past = new Date(Date.now() - 1000);
    const payment = await firstOf(b, 'payments');
    const refund = await firstOf(a, 'refunds');
    const operation = await firstOf(a, 'operations');
    await inTenant(b)((tx) =>
      tx
        .update(schema.payments)
        .set({ nextSyncAt: past })
        .where(eq(schema.payments.id, payment.id as string)),
    );
    await inTenant(a)(async (tx) => {
      await tx
        .update(schema.refunds)
        .set({ nextSyncAt: past })
        .where(eq(schema.refunds.id, refund.id as string));
      await tx
        .update(schema.operations)
        .set({ state: 'unknown', nextReconcileAt: past })
        .where(eq(schema.operations.id, operation.id as string));
    });
    const claimed = await claimCommerceWork(h.app, { limit: 50, leaseSeconds: 60 });
    expect(claimed).toEqual(
      expect.arrayContaining([
        { tenantId: b.tenantId, subject: 'payment', id: payment.id },
        { tenantId: a.tenantId, subject: 'refund', id: refund.id },
        { tenantId: a.tenantId, subject: 'operation', id: operation.id },
      ]),
    );
    expect(await claimCommerceWork(h.app, { limit: 50, leaseSeconds: 60 })).toEqual([]);
  });
});
