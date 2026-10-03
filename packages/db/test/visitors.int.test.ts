import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, purgeVisitors, schema, type TenantTx, withTenant } from '../src/index.js';
import { type SeededTenant, seedTenant } from '../src/testing/index.js';
import { expectPgError, type Harness, openHarness } from './helpers.js';

let h: Harness;
let a: SeededTenant;
let b: SeededTenant;

const inTenant = <T>(tenant: SeededTenant, work: (tx: TenantTx) => Promise<T>) =>
  withTenant(h.app, { tenantId: tenant.tenantId }, work);

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

/** A visitor with one visit and one page view, last seen `days` ago. */
async function visitor(tenant: SeededTenant, days: number) {
  const visitorId = newId();
  const sessionId = newId();
  await inTenant(tenant, async (tx) => {
    await tx.insert(schema.visitors).values({
      id: visitorId,
      tenantId: tenant.tenantId,
      brandId: tenant.brandId,
      keyHash: randomBytes(32),
      firstSeenAt: daysAgo(days),
      lastSeenAt: daysAgo(days),
    });
    await tx.insert(schema.visitorSessions).values({
      id: sessionId,
      tenantId: tenant.tenantId,
      brandId: tenant.brandId,
      visitorId,
      startedAt: daysAgo(days),
      lastSeenAt: daysAgo(days),
      entryUrl: 'https://shop.example/',
      currentUrl: 'https://shop.example/',
    });
    await tx.insert(schema.visitorPageViews).values({
      tenantId: tenant.tenantId,
      brandId: tenant.brandId,
      visitorId,
      sessionId,
      url: 'https://shop.example/',
      viewedAt: daysAgo(days),
    });
  });
  return { visitorId, sessionId };
}

const counts = (tenant: SeededTenant, visitorId: string) =>
  inTenant(tenant, async (tx) => {
    const count = async (table: string, column: string) => {
      const { rows } = await tx.execute<{ n: string }>(
        sql`select count(*) as n from ${sql.identifier(table)} where ${sql.identifier(column)} = ${visitorId}::uuid`,
      );
      return Number(rows[0]?.n);
    };
    return {
      visitors: await count('visitors', 'id'),
      sessions: await count('visitor_sessions', 'visitor_id'),
      pageViews: await count('visitor_page_views', 'visitor_id'),
    };
  });

beforeAll(async () => {
  h = await openHarness();
  a = await seedTenant(h.app, 'alpha');
  b = await seedTenant(h.app, 'beta');
});

afterAll(async () => {
  await h?.close();
});

describe('visitors (retention and shape)', () => {
  it('removes visitors, visits and page views 30 days after the last sign of life, in every tenant', async () => {
    const stale = await visitor(a, 31);
    const staleB = await visitor(b, 45);
    const recent = await visitor(a, 29);
    const result = await purgeVisitors(h.app);
    expect(result.visitors).toBeGreaterThanOrEqual(2);
    expect(result.sessions).toBeGreaterThanOrEqual(2);
    expect(result.pageViews).toBeGreaterThanOrEqual(2);
    expect(await counts(a, stale.visitorId)).toEqual({ visitors: 0, sessions: 0, pageViews: 0 });
    expect(await counts(b, staleB.visitorId)).toEqual({ visitors: 0, sessions: 0, pageViews: 0 });
    expect(await counts(a, recent.visitorId)).toEqual({ visitors: 1, sessions: 1, pageViews: 1 });
    // The seeded visitor was seen just now: it stays.
    const { rows } = await h.app.execute<{ n: string }>(sql`select count(*) as n from visitors`);
    expect(Number(rows[0]?.n)).toBe(0);
    await inTenant(a, async (tx) => {
      const left = await tx.select({ id: schema.visitors.id }).from(schema.visitors);
      expect(left.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('removes old page views of a visitor who is still around', async () => {
    const { visitorId, sessionId } = await visitor(a, 0);
    await inTenant(a, (tx) =>
      tx.insert(schema.visitorPageViews).values({
        tenantId: a.tenantId,
        brandId: a.brandId,
        visitorId,
        sessionId,
        url: 'https://shop.example/old',
        viewedAt: daysAgo(40),
      }),
    );
    await purgeVisitors(h.app);
    const left = await inTenant(a, (tx) =>
      tx
        .select({ url: schema.visitorPageViews.url })
        .from(schema.visitorPageViews)
        .where(eq(schema.visitorPageViews.visitorId, visitorId)),
    );
    expect(left.map((row) => row.url)).toEqual(['https://shop.example/']);
  });

  it('knows a browser once per brand, and keeps countries as two capital letters', async () => {
    const keyHash = randomBytes(32);
    const insert = () =>
      inTenant(a, (tx) =>
        tx
          .insert(schema.visitors)
          .values({ tenantId: a.tenantId, brandId: a.brandId, keyHash })
          .onConflictDoNothing()
          .returning({ id: schema.visitors.id }),
      );
    expect(await insert()).toHaveLength(1);
    expect(await insert()).toHaveLength(0);
    const { sessionId } = await visitor(a, 0);
    await expectPgError(
      inTenant(a, (tx) =>
        tx.execute(sql`update visitor_sessions set country = 'uae' where id = ${sessionId}::uuid`),
      ),
      '23514',
    );
    await expectPgError(
      inTenant(a, (tx) =>
        tx.execute(
          sql`update visitor_sessions set device_type = 'toaster' where id = ${sessionId}::uuid`,
        ),
      ),
      '23514',
    );
  });

  it('keeps no address of any kind about a visitor', async () => {
    const { rows } = await h.owner.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and table_name in ('visitors', 'visitor_sessions', 'visitor_page_views', 'brand_visitor_settings')
        and (column_name ~* '(^|_)(ip|ipv4|ipv6|addr|address|remote)($|_)' or column_name ~* 'user_?agent')`);
    expect(rows).toEqual([]);
  });
});

describe('staff alert settings and read markers', () => {
  it('start from defaults, stay in range and are kept per staff member and tenant', async () => {
    const [row] = await inTenant(a, (tx) =>
      tx
        .select()
        .from(schema.staffInboxPreferences)
        .where(eq(schema.staffInboxPreferences.staffMemberId, a.staffMemberId)),
    );
    expect(row).toMatchObject({
      soundMuted: false,
      soundVolume: 60,
      soundNewChat: 'chime',
      soundCustomerMessage: 'pop',
      soundAssigned: 'bell',
      desktopEnabled: true,
      desktopPreview: true,
      availability: 'online',
    });
    await expectPgError(
      inTenant(a, (tx) => tx.execute(sql`update staff_inbox_preferences set sound_volume = 101`)),
      '23514',
    );
    await expectPgError(
      inTenant(a, (tx) =>
        tx.execute(sql`update staff_inbox_preferences set availability = 'busy'`),
      ),
      '23514',
    );
  });

  it('records how far a conversation was read, once per person', async () => {
    const readSeq = (seq: number) =>
      inTenant(a, (tx) =>
        tx
          .insert(schema.staffConversationReads)
          .values({
            tenantId: a.tenantId,
            staffMemberId: a.staffMemberId,
            conversationId: a.conversationId,
            readSeq: seq,
          })
          .onConflictDoUpdate({
            target: [
              schema.staffConversationReads.tenantId,
              schema.staffConversationReads.staffMemberId,
              schema.staffConversationReads.conversationId,
            ],
            set: { readSeq: sql`greatest(${schema.staffConversationReads.readSeq}, ${seq})` },
          })
          .returning({ readSeq: schema.staffConversationReads.readSeq }),
      );
    expect((await readSeq(5))[0]?.readSeq).toBe(5);
    expect((await readSeq(3))[0]?.readSeq).toBe(5);
    await expectPgError(
      inTenant(a, (tx) => tx.execute(sql`update staff_conversation_reads set read_seq = -1`)),
      '23514',
    );
  });
});
