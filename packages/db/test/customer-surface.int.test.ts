import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeWidgetUploads, schema, type TenantTx, withTenant } from '../src/index.js';
import { type SeededTenant, seedTenant } from '../src/testing/index.js';
import { expectPgError, type Harness, openHarness } from './helpers.js';

let h: Harness;
let a: SeededTenant;
let b: SeededTenant;

const inTenant = <T>(tenant: SeededTenant, work: (tx: TenantTx) => Promise<T>) =>
  withTenant(h.app, { tenantId: tenant.tenantId }, work);

function upload(
  tenant: SeededTenant,
  overrides: Partial<typeof schema.widgetUploads.$inferInsert> = {},
): typeof schema.widgetUploads.$inferInsert {
  return {
    tenantId: tenant.tenantId,
    brandId: tenant.brandId,
    conversationId: tenant.conversationId,
    principalId: tenant.principalId,
    name: 'photo.png',
    mimeType: 'image/png',
    sizeBytes: 4,
    sha256: randomBytes(32),
    status: 'available',
    content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  };
}

beforeAll(async () => {
  h = await openHarness();
  a = await seedTenant(h.app, 'alpha');
  b = await seedTenant(h.app, 'beta');
});

afterAll(async () => {
  await h?.close();
});

describe('quarantined uploads (W09)', () => {
  it('keeps bytes only for a file that passed the scanner', async () => {
    await expectPgError(
      inTenant(a, (tx) =>
        tx.insert(schema.widgetUploads).values(upload(a, { status: 'rejected' })),
      ),
      '23514',
    );
    await expectPgError(
      inTenant(a, (tx) => tx.insert(schema.widgetUploads).values(upload(a, { status: 'sent' }))),
      '23514',
    );
    await expectPgError(
      inTenant(a, (tx) =>
        tx.insert(schema.widgetUploads).values(upload(a, { sizeBytes: 10 * 1024 * 1024 + 1 })),
      ),
      '23514',
    );
  });

  it('clears expired quarantine across tenants and removes old records', async () => {
    const [expiredA] = await inTenant(a, (tx) =>
      tx
        .insert(schema.widgetUploads)
        .values(upload(a, { expiresAt: new Date(Date.now() - 1000) }))
        .returning({ id: schema.widgetUploads.id }),
    );
    const [expiredB] = await inTenant(b, (tx) =>
      tx
        .insert(schema.widgetUploads)
        .values(upload(b, { expiresAt: new Date(Date.now() - 1000) }))
        .returning({ id: schema.widgetUploads.id }),
    );
    const [fresh] = await inTenant(a, (tx) =>
      tx.insert(schema.widgetUploads).values(upload(a)).returning({ id: schema.widgetUploads.id }),
    );
    const [old] = await inTenant(a, (tx) =>
      tx
        .insert(schema.widgetUploads)
        .values(
          upload(a, {
            status: 'sent',
            content: null,
            createdAt: new Date(Date.now() - 31 * 86_400_000),
          }),
        )
        .returning({ id: schema.widgetUploads.id }),
    );
    const result = await purgeWidgetUploads(h.app);
    expect(result.expired).toBeGreaterThanOrEqual(2);
    expect(result.removed).toBeGreaterThanOrEqual(1);

    const rowOf = (tenant: SeededTenant, id: string) =>
      inTenant(tenant, async (tx) => {
        const [row] = await tx
          .select({ status: schema.widgetUploads.status, content: schema.widgetUploads.content })
          .from(schema.widgetUploads)
          .where(eq(schema.widgetUploads.id, id));
        return row;
      });
    expect(await rowOf(a, expiredA?.id as string)).toEqual({ status: 'expired', content: null });
    expect(await rowOf(b, expiredB?.id as string)).toEqual({ status: 'expired', content: null });
    expect((await rowOf(a, fresh?.id as string))?.status).toBe('available');
    expect(await rowOf(a, old?.id as string)).toBeUndefined();
  });

  it('keeps the purge out of the application role’s hands otherwise', async () => {
    // Without a tenant the application role sees no uploads at all.
    const { rows } = await h.app.execute<{ n: string }>(
      sql`select count(*) as n from widget_uploads`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

describe('customer emails (W25)', () => {
  it('records each email once and never rewrites the record', async () => {
    const key = `reply:${a.conversationId}:7`;
    const insert = () =>
      inTenant(a, (tx) =>
        tx
          .insert(schema.customerNotifications)
          .values({
            tenantId: a.tenantId,
            principalId: a.principalId,
            conversationId: a.conversationId,
            kind: 'reply_waiting',
            dedupeKey: key,
            status: 'sent',
          })
          .onConflictDoNothing()
          .returning({ id: schema.customerNotifications.id }),
      );
    expect(await insert()).toHaveLength(1);
    expect(await insert()).toHaveLength(0);
    await expectPgError(
      inTenant(a, (tx) =>
        tx.execute(
          sql`update customer_notifications set status = 'skipped' where dedupe_key = ${key}`,
        ),
      ),
      '42501',
    );
    await expectPgError(
      inTenant(a, (tx) =>
        tx.execute(sql`delete from customer_notifications where dedupe_key = ${key}`),
      ),
      '42501',
    );
  });

  it('keeps one preference row per customer', async () => {
    await expectPgError(
      inTenant(a, (tx) =>
        tx.insert(schema.customerNotificationPreferences).values({
          tenantId: a.tenantId,
          brandId: a.brandId,
          principalId: a.principalId,
          replyWaiting: true,
        }),
      ),
      '23505',
    );
  });
});
