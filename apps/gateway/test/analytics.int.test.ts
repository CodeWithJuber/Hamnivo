import { fromPublicId, newId, schema, toPublicId, withTenant } from '@hamnivo/db';
import { seedTenant as seedTenantFixture } from '@hamnivo/db/testing';
import type { ServiceAccountPrincipal } from '@hamnivo/policy';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalyticsService } from '../src/analytics/analytics.service.js';
import type { AppConfig } from '../src/config.js';
import { withTwoStep } from './developer-support.js';
import { join, type Shop } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

let slice: Slice;
let shop: Shop;
let tenantId: string;
let brand1: string;
let brand2: string;
let teamA: string;

const RANGE = 'from=2026-09-01&to=2026-09-07';

interface Planned {
  at: string;
  brand?: 'brand2';
  handoff?: string;
  frt?: number;
  resolution?: number;
  resolvedBy?: 'ai' | 'person';
  team?: 'A' | 'B';
  rating?: number;
}

/** Nine conversations of brand 1 in the range, three the week before, one of brand 2. */
const PLAN: Planned[] = [
  {
    at: '2026-09-01T10:00:00Z',
    handoff: 'customer_request',
    frt: 10,
    resolution: 60,
    resolvedBy: 'person',
    team: 'A',
    rating: 4,
  },
  {
    at: '2026-09-01T11:00:00Z',
    handoff: 'customer_request',
    frt: 20,
    resolution: 120,
    resolvedBy: 'person',
    team: 'A',
    rating: 5,
  },
  {
    at: '2026-09-01T12:00:00Z',
    handoff: 'customer_request',
    frt: 30,
    resolution: 180,
    resolvedBy: 'person',
    team: 'A',
  },
  { at: '2026-09-01T13:00:00Z', handoff: 'customer_request', frt: 40, team: 'A' },
  { at: '2026-09-02T10:00:00Z', handoff: 'ai_limit', frt: 50, team: 'A' },
  { at: '2026-09-02T11:00:00Z', resolution: 240, resolvedBy: 'ai', team: 'B' },
  { at: '2026-09-03T10:00:00Z', resolution: 300, resolvedBy: 'ai', team: 'B' },
  { at: '2026-09-03T11:00:00Z', resolution: 360, resolvedBy: 'ai' },
  { at: '2026-09-03T12:00:00Z', handoff: 'ai_unavailable' },
  { at: '2026-08-26T10:00:00Z' },
  { at: '2026-08-26T11:00:00Z' },
  { at: '2026-08-26T12:00:00Z' },
  { at: '2026-09-07T22:00:00Z', brand: 'brand2' },
];

const plus = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000);

async function seedConversations(visitorPrincipal: string) {
  const connectionId = fromPublicId('connection', shop.connection.id);
  await withTenant(slice.app, { tenantId }, async (tx) => {
    const [inbox] = await tx
      .select({ id: schema.authorityInboxes.id })
      .from(schema.authorityInboxes)
      .where(eq(schema.authorityInboxes.brandId, brand1));
    if (!inbox) throw new Error('no inbox');
    const teams = { A: newId(), B: newId() };
    teamA = teams.A;
    await tx.insert(schema.teams).values([
      { id: teams.A, tenantId, name: '=SUM(1+1)' },
      { id: teams.B, tenantId, name: 'Returns' },
    ]);
    let n = 0;
    for (const planned of PLAN) {
      n += 1;
      const id = newId();
      await tx.insert(schema.conversationControls).values({
        id,
        tenantId,
        connectionId,
        inboxId: inbox.id,
        brandId: planned.brand === 'brand2' ? brand2 : brand1,
        principalId: visitorPrincipal,
        externalConversationId: 90_000 + n,
        ownerMode: 'AI_ACTIVE',
        authorityStatus: 'open',
        createdAt: new Date(planned.at),
      });
      const m = schema.conversationMetrics;
      await tx
        .update(m)
        .set({
          firstCustomerMessageAt: planned.frt !== undefined ? new Date(planned.at) : null,
          firstResponseAt: planned.frt !== undefined ? plus(planned.at, planned.frt) : null,
          handedOffAt: planned.handoff ? plus(planned.at, 5) : null,
          handoffReason: planned.handoff ?? null,
          humanInvolved: planned.resolvedBy === 'person',
          firstResolvedAt:
            planned.resolution !== undefined ? plus(planned.at, planned.resolution) : null,
          resolvedBy: planned.resolvedBy ?? null,
        })
        .where(eq(m.id, id));
      if (planned.team) {
        await tx
          .insert(schema.conversationInboxState)
          .values({ tenantId, conversationId: id, teamId: teams[planned.team] });
      }
      if (planned.rating) {
        await tx.insert(schema.conversationFeedback).values({
          tenantId,
          conversationId: id,
          principalId: visitorPrincipal,
          rating: planned.rating,
        });
      }
    }
    await tx.insert(schema.cacheMetricsDaily).values({
      tenantId,
      brandId: brand1,
      day: '2026-09-02',
      tier: 'exact_answer',
      hits: 6,
      misses: 4,
    });
  });
}

beforeAll(async () => {
  slice = await startSlice({ env: { ANALYTICS_MIN_GROUP_SIZE: '3' } });
  shop = await connectedTenant(slice, 'stats');
  tenantId = fromPublicId('tenant', shop.tenantId);
  brand1 = fromPublicId('brand', shop.brand.id);
  const second = await shop.owner.post('/v1/admin/brands', {
    workspaceId: shop.workspaceId,
    name: 'Stats Outlet',
    allowedOrigins: ['https://outlet.example'],
  });
  expect(second.status, JSON.stringify(second.body)).toBe(201);
  brand2 = fromPublicId('brand', second.body.id);
  const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  await visitor.open();
  await seedConversations(fromPublicId('customer', visitor.principalId));
});

afterAll(async () => {
  await slice?.close();
});

describe('service quality', () => {
  it('reports counts, rates and medians, withholding what stands on too few', async () => {
    const res = await shop.owner.get(
      `/v1/admin/analytics/overview?${RANGE}&brandId=${shop.brand.id}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const o = res.body;
    expect(o).toMatchObject({
      range: { from: '2026-09-01', to: '2026-09-07', timezone: 'UTC', days: 7 },
      previousRange: { from: '2026-08-25', to: '2026-08-31' },
      minimumGroupSize: 3,
    });
    expect(o.totals.conversations).toEqual({ value: 9, previous: 3 });
    expect(o.totals.handedOff).toMatchObject({ value: 6, sample: 9, suppressed: false });
    expect(o.totals.handedOff.rate).toBeCloseTo(6 / 9, 3);
    expect(o.totals.resolved).toMatchObject({ value: 6, sample: 9 });
    expect(o.totals.aiResolved).toMatchObject({ value: 3, suppressed: false });
    expect(o.totals.aiResolved.rate).toBeCloseTo(3 / 9, 3);
    expect(o.totals.firstResponseMedianSeconds).toEqual({
      value: 30,
      suppressed: false,
      sample: 5,
    });
    expect(o.totals.resolutionMedianSeconds).toEqual({ value: 210, suppressed: false, sample: 6 });
    // Two ratings are fewer than three: the average is withheld.
    expect(o.totals.csatAverage).toEqual({ value: null, suppressed: true, sample: 2 });
    expect(o.ai.limitHandoffs).toBeNull();
  });

  it('withholds a rate whose count is withheld', async () => {
    const o = (
      await shop.owner.get(
        `/v1/admin/analytics/overview?from=2026-09-02&to=2026-09-03&brandId=${shop.brand.id}`,
      )
    ).body;
    expect(o.totals.conversations.value).toBe(5);
    // Two handoffs out of five: the count is withheld, and so is the rate that would reveal it.
    expect(o.totals.handedOff).toEqual({ value: null, suppressed: true, sample: 5, rate: null });
    expect(o.totals.aiResolved).toMatchObject({ value: 3, rate: 0.6 });
  });

  it('withholds small days, and the next smallest too so the total cannot reveal them', async () => {
    const o = (
      await shop.owner.get(`/v1/admin/analytics/overview?${RANGE}&brandId=${shop.brand.id}`)
    ).body;
    expect(
      o.daily.map((d: { date: string; conversations: number | null }) => [d.date, d.conversations]),
    ).toEqual([
      ['2026-09-01', 4],
      ['2026-09-02', null],
      ['2026-09-03', null],
      ['2026-09-04', 0],
      ['2026-09-05', 0],
      ['2026-09-06', 0],
      ['2026-09-07', 0],
    ]);
    expect(o.daily[1]).toMatchObject({ suppressed: true });
    // The week before lines up day by day, with its own withholding (26 August had three).
    expect(o.daily[1].previous).toBe(3);
    expect(o.daily[0].previous).toBe(0);
    expect(o.handoffReasons).toEqual([
      { reason: 'customer_request', count: 4, suppressed: false },
      { reason: 'ai_limit', count: null, suppressed: true },
      { reason: 'ai_unavailable', count: null, suppressed: true },
    ]);
  });

  it('breaks down by team and channel with the same rules', async () => {
    const o = (
      await shop.owner.get(`/v1/admin/analytics/overview?${RANGE}&brandId=${shop.brand.id}`)
    ).body;
    const a = o.teams.find(
      (t: { teamId: string | null }) => t.teamId === toPublicId('team', teamA),
    );
    expect(a).toMatchObject({
      name: '=SUM(1+1)',
      conversations: 5,
      firstResponseMedianSeconds: 30,
      handoffRate: 1,
      csatAverage: null,
      csatResponses: 2,
      suppressed: false,
    });
    const hidden = o.teams.filter((t: { suppressed: boolean }) => t.suppressed);
    expect(hidden).toHaveLength(2);
    for (const team of hidden) {
      expect(team).toMatchObject({
        conversations: null,
        handoffRate: null,
        firstResponseMedianSeconds: null,
      });
    }
    expect(o.channels).toHaveLength(1);
    expect(o.channels[0].conversations).toBe(9);
    expect(o.channels[0].handoffRate).toBeCloseTo(6 / 9, 3);
    expect(o.cache).toEqual({ status: 'measured', hitRate: 0.6 });
    const byTeam = (
      await shop.owner.get(
        `/v1/admin/analytics/overview?${RANGE}&teamId=${toPublicId('team', teamA)}`,
      )
    ).body;
    expect(byTeam.totals.conversations.value).toBe(5);
    expect(byTeam.cache).toEqual({ status: 'not_measured', hitRate: null });
  });

  it('counts days in the requested time zone', async () => {
    const day = 'from=2026-09-08&to=2026-09-08';
    const utc = await shop.owner.get(`/v1/admin/analytics/overview?${day}&timezone=UTC`);
    const dubai = await shop.owner.get(`/v1/admin/analytics/overview?${day}&timezone=Asia/Dubai`);
    expect(utc.body.totals.conversations.value).toBe(0);
    expect(dubai.body.totals.conversations.value).toBe(1);
    const all = await shop.owner.get(`/v1/admin/analytics/overview?${RANGE}`);
    expect(all.body.totals.conversations.value).toBe(10);
  });

  it('rejects ranges and time zones it cannot answer', async () => {
    const bad = [
      'from=2026-09-07&to=2026-09-01',
      'from=2025-01-01&to=2026-09-01',
      `${RANGE}&timezone=Mars/Olympus`,
      'from=2026-13-01&to=2026-13-02',
    ];
    for (const query of bad) {
      const res = await shop.owner.get(`/v1/admin/analytics/overview?${query}`);
      expect(res.status, query).toBe(422);
    }
  });
});

describe('who sees what', () => {
  it('shows a person scoped to a brand only that brand', async () => {
    const analyst = await join(slice, shop, 'Ana Lytic', 'analyst', {
      type: 'brand',
      id: toPublicId('brand', brand2),
    });
    const own = await analyst.client.get(`/v1/admin/analytics/overview?${RANGE}`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.totals.conversations.value).toBe(1);
    const other = await analyst.client.get(
      `/v1/admin/analytics/overview?${RANGE}&brandId=${shop.brand.id}`,
    );
    expect(other.body.totals.conversations.value).toBe(0);
    // Billing stays with billing.read.
    expect((await analyst.client.get('/v1/admin/usage')).status).toBe(403);
  });

  it('accepts an API key with analytics.read and keeps other tenants apart', async () => {
    const admin = await withTwoStep(slice.gw.app, shop.owner, 'stats-owner@example.com');
    const key = await admin.post('/v1/admin/api-keys', {
      name: 'BI export',
      permissions: ['analytics.read'],
      scope: { type: 'workspace', id: shop.workspaceId },
      expiresInDays: 30,
    });
    expect(key.status, JSON.stringify(key.body)).toBe(201);
    const auth = { headers: { authorization: `Bearer ${key.body.secret}` }, tenant: null };
    const read = await admin.get(`/v1/admin/analytics/overview?${RANGE}`, auth);
    expect(read.status).toBe(200);
    expect(read.body.totals.conversations.value).toBe(10);

    const other = await connectedTenant(slice, 'stats-other');
    const theirs = await other.owner.get(`/v1/admin/analytics/overview?${RANGE}`);
    expect(theirs.body.totals.conversations.value).toBe(0);
    expect(theirs.body.cache.status).toBe('not_measured');
  });

  it('exports the same aggregates as CSV, safe to open in a spreadsheet', async () => {
    const res = await shop.owner.get(
      `/v1/admin/analytics/export?${RANGE}&brandId=${shop.brand.id}`,
    );
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/csv');
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    const csv = String(res.body);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('section,key,value,previous_or_rate,withheld,sample');
    expect(lines).toContain('totals,conversations,9,3,false,');
    expect(lines).toContain('daily,2026-09-02,,3,true,');
    expect(lines.some((l) => l.startsWith("team,'=SUM(1+1),5,"))).toBe(true);
    expect(csv).not.toMatch(/^team,=/m);
  });
});

describe('commerce aggregates', () => {
  it('sums captured revenue and succeeded refunds per currency', async () => {
    const seeded = await seedTenantFixture(slice.app, 'statscommerce');
    await withTenant(slice.app, { tenantId: seeded.tenantId }, (tx) =>
      tx
        .update(schema.refunds)
        .set({ state: 'succeeded', succeededAt: new Date() })
        .where(and(eq(schema.refunds.tenantId, seeded.tenantId))),
    );
    const config = { ANALYTICS_MIN_GROUP_SIZE: 1 } as unknown as AppConfig;
    const service = new AnalyticsService(slice.app, config, () => new Date());
    const principal: ServiceAccountPrincipal = {
      kind: 'service_account',
      tenantId: seeded.tenantId,
      serviceAccountId: seeded.serviceAccountId,
      status: 'active',
      keyScopes: ['analytics.read'],
      grants: [
        {
          id: 'g',
          permissions: ['analytics.read'],
          scope: { type: 'tenant' },
          expiresAt: null,
          revokedAt: null,
        },
      ],
    };
    const today = new Date().toISOString().slice(0, 10);
    const o = await service.overview(principal, { from: today, to: today, timezone: 'UTC' });
    expect(o.commerce).toEqual([
      {
        currency: 'AED',
        orders: 1,
        revenueMinor: '4500',
        refunds: 1,
        refundedMinor: '1000',
        suppressed: false,
      },
    ]);
    // With the configured minimum group size, one order is withheld.
    const strict = new AnalyticsService(
      slice.app,
      { ANALYTICS_MIN_GROUP_SIZE: 3 } as unknown as AppConfig,
      () => new Date(),
    );
    const held = await strict.overview(principal, { from: today, to: today, timezone: 'UTC' });
    expect(held.commerce[0]).toMatchObject({ orders: null, revenueMinor: null, suppressed: true });
  });
});
