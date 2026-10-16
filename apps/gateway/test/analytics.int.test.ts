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

describe('missed chats, contact form messages, reopens and tickets (O04, H19)', () => {
  let brand3: string;
  let brand3Public: string;

  beforeAll(async () => {
    const third = await shop.owner.post('/v1/admin/brands', {
      workspaceId: shop.workspaceId,
      name: 'Stats Desk',
      allowedOrigins: ['https://desk.example'],
    });
    expect(third.status, JSON.stringify(third.body)).toBe(201);
    brand3Public = third.body.id;
    brand3 = fromPublicId('brand', brand3Public);
    const connectionId = fromPublicId('connection', shop.connection.id);
    const at = '2026-09-04T09:00:00Z';
    // c1–c3 got no answer, c4 an answer after two hours, c5 within a minute; c6 never wrote.
    const plan = [
      { response: null, resolved: 600, reopened: true, ticket: true },
      { response: null, resolved: 1200, reopened: true, ticket: true },
      { response: null, resolved: null, reopened: false, ticket: true },
      { response: 7200, resolved: 9000, reopened: true, ticket: false },
      { response: 60, resolved: 300, reopened: false, ticket: false },
      { response: undefined, resolved: 1800, reopened: false, ticket: true },
    ] as const;
    await withTenant(slice.app, { tenantId }, async (tx) => {
      const [inbox] = await tx
        .select({ id: schema.authorityInboxes.id })
        .from(schema.authorityInboxes)
        .where(eq(schema.authorityInboxes.brandId, brand1));
      if (!inbox) throw new Error('no inbox');
      const [principal] = await tx
        .insert(schema.customerPrincipals)
        .values({ tenantId, brandId: brand3, kind: 'anonymous' })
        .returning();
      let n = 0;
      for (const planned of plan) {
        n += 1;
        const id = newId();
        await tx.insert(schema.conversationControls).values({
          id,
          tenantId,
          connectionId,
          inboxId: inbox.id,
          brandId: brand3,
          principalId: principal?.id ?? null,
          externalConversationId: 95_000 + n,
          ownerMode: 'WAITING_HUMAN',
          authorityStatus: planned.resolved === null ? 'open' : 'resolved',
          createdAt: new Date(at),
        });
        await tx
          .update(schema.conversationMetrics)
          .set({
            firstCustomerMessageAt: planned.response === undefined ? null : new Date(at),
            firstResponseAt:
              planned.response === null || planned.response === undefined
                ? null
                : plus(at, planned.response),
            firstResolvedAt: planned.resolved === null ? null : plus(at, planned.resolved),
            lastResolvedAt: planned.resolved === null ? null : plus(at, planned.resolved),
            reopenCount: planned.reopened ? 1 : 0,
          })
          .where(eq(schema.conversationMetrics.id, id));
        if (planned.ticket) {
          await tx.insert(schema.conversationInboxState).values({
            tenantId,
            conversationId: id,
            priority: 'high',
            ticketNumber: 500 + n,
            ticketSource: 'offline_form',
            ticketOpenedAt: new Date(at),
          });
        }
      }
    });
  });

  it('counts missed chats, contact form messages and reopens', async () => {
    const res = await shop.owner.get(
      `/v1/admin/analytics/overview?${RANGE}&brandId=${brand3Public}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { quality } = res.body;
    expect(quality.missed).toMatchObject({ value: 4, sample: 5, suppressed: false });
    expect(quality.missed.rate).toBeCloseTo(0.8, 3);
    expect(quality.offlineMessages).toEqual({ value: 4, sample: 6, suppressed: false });
    expect(quality.reopened).toMatchObject({ value: 3, sample: 5, suppressed: false });
    expect(quality.reopened.rate).toBeCloseTo(0.6, 3);
  });

  it('reports tickets opened, closed and open now, withholding small groups', async () => {
    const { tickets } = (
      await shop.owner.get(`/v1/admin/analytics/overview?${RANGE}&brandId=${brand3Public}`)
    ).body;
    expect(tickets.created).toMatchObject({ value: 4, suppressed: false });
    expect(tickets.closed).toMatchObject({ value: 3, suppressed: false });
    // One open ticket is fewer than three: withheld.
    expect(tickets.openNow).toMatchObject({ value: null, suppressed: true });
    expect(tickets.closeMedianSeconds).toEqual({ value: 1200, suppressed: false, sample: 3 });
    expect(tickets.byPriority).toEqual([{ priority: 'high', count: 4, suppressed: false }]);
    expect(tickets.bySource).toEqual([{ source: 'offline_form', count: 4, suppressed: false }]);
    const csv = await shop.owner.get(`/v1/admin/analytics/export?${RANGE}&brandId=${brand3Public}`);
    const lines = String(csv.body).trim().split('\r\n');
    expect(lines).toContain('quality,missed,4,0.8,false,5');
    expect(lines).toContain('tickets,created,4,,false,');
  });
});

describe('the inbox work queue: reply-time targets, offers and AI drafts (H12, HNV-10-06, HNV-09-05)', () => {
  const WEEK = 'from=2026-09-10&to=2026-09-16';
  let brand4Public: string;

  beforeAll(async () => {
    const fourth = await shop.owner.post('/v1/admin/brands', {
      workspaceId: shop.workspaceId,
      name: 'Stats Queue',
      allowedOrigins: ['https://queue.example'],
    });
    expect(fourth.status, JSON.stringify(fourth.body)).toBe(201);
    brand4Public = fourth.body.id;
    const brand4 = fromPublicId('brand', brand4Public);
    const connectionId = fromPublicId('connection', shop.connection.id);
    await withTenant(slice.app, { tenantId }, async (tx) => {
      const [inbox] = await tx
        .select({ id: schema.authorityInboxes.id })
        .from(schema.authorityInboxes)
        .where(eq(schema.authorityInboxes.brandId, brand1));
      const [staff] = await tx.select({ id: schema.staffMembers.id }).from(schema.staffMembers);
      if (!inbox || !staff) throw new Error('no inbox or staff');
      const conversations: string[] = [];
      for (let n = 1; n <= 6; n += 1) {
        const id = newId();
        conversations.push(id);
        await tx.insert(schema.conversationControls).values({
          id,
          tenantId,
          connectionId,
          inboxId: inbox.id,
          brandId: brand4,
          externalConversationId: 97_000 + n,
          ownerMode: 'WAITING_HUMAN',
          authorityStatus: 'open',
          createdAt: new Date('2026-09-10T08:00:00Z'),
        });
      }
      const conversation = (n: number) => conversations[n - 1] as string;

      // Reply-time clocks: four met, two missed, one stopped without a reply.
      const clock = (
        n: number,
        endedAt: string,
        outcome: 'met' | 'missed' | 'stopped',
        minutes: number,
        more: { kind?: 'first_reply' | 'next_reply'; priority?: 'urgent' | 'high' } = {},
      ) => ({
        tenantId,
        conversationId: conversation(n),
        kind: more.kind ?? ('first_reply' as const),
        priority: more.priority ?? ('medium' as const),
        targetMinutes: 60,
        startedAt: new Date(Date.parse(endedAt) - minutes * 60_000),
        endedAt: new Date(endedAt),
        outcome,
        businessMinutes: minutes,
      });
      await tx
        .insert(schema.slaOutcomes)
        .values([
          clock(1, '2026-09-10T09:00:00Z', 'met', 10),
          clock(2, '2026-09-10T09:00:00Z', 'met', 20),
          clock(3, '2026-09-10T09:00:00Z', 'met', 30),
          clock(4, '2026-09-11T09:00:00Z', 'met', 40),
          clock(5, '2026-09-11T09:00:00Z', 'missed', 90, { priority: 'high' }),
          clock(6, '2026-09-11T09:00:00Z', 'missed', 70, {
            kind: 'next_reply',
            priority: 'urgent',
          }),
          clock(1, '2026-09-12T09:00:00Z', 'stopped', 5, { kind: 'next_reply' }),
          // Before the week: not counted.
          clock(2, '2026-09-09T09:00:00Z', 'missed', 300),
        ]);

      // Offers: three accepted, a hand-off declined twice and offline once before running out,
      // one declined three times, and one cancelled when someone took the chat.
      const offeredAt = Date.parse('2026-09-12T10:00:00Z');
      const offer = (
        n: number,
        round: number,
        state: 'accepted' | 'declined' | 'expired' | 'cancelled',
        seconds: number,
        reason?: 'at_capacity' | 'not_my_area' | 'going_offline',
      ) => ({
        tenantId,
        conversationId: conversation(n),
        teamId: teamA,
        staffMemberId: staff.id,
        handoffEpoch: 1,
        round,
        state,
        declineReason: reason ?? null,
        cancelReason: state === 'cancelled' ? ('owner_changed' as const) : null,
        offeredAt: new Date(offeredAt + round * 1000),
        expiresAt: new Date(offeredAt + round * 1000 + 120_000),
        decidedAt: new Date(offeredAt + round * 1000 + seconds * 1000),
        timeoutSeconds: 120,
      });
      await tx
        .insert(schema.conversationOffers)
        .values([
          offer(1, 1, 'accepted', 30),
          offer(2, 1, 'accepted', 60),
          offer(3, 1, 'accepted', 90),
          offer(4, 1, 'declined', 5, 'not_my_area'),
          offer(4, 2, 'declined', 5, 'not_my_area'),
          offer(4, 3, 'declined', 5, 'going_offline'),
          offer(4, 4, 'expired', 120),
          offer(5, 1, 'declined', 5, 'at_capacity'),
          offer(5, 2, 'declined', 5, 'at_capacity'),
          offer(5, 3, 'declined', 5, 'at_capacity'),
          offer(6, 1, 'cancelled', 10),
        ]);

      // AI drafts: three sent as written, one edited, three rejected as inaccurate, two set aside
      // when the customer wrote again, one still waiting.
      const [asked] = await tx
        .insert(schema.messageLedger)
        .values({
          tenantId,
          conversationId: conversation(1),
          senderKind: 'customer',
          senderId: 'customer',
          clientMessageId: newId(),
          requestHash: Buffer.alloc(32),
          sourceKey: `hv1:m:${newId()}`,
          state: 'committed',
        })
        .returning({ id: schema.messageLedger.id });
      if (!asked) throw new Error('no ledger row');
      const states = [
        'approved',
        'approved',
        'approved',
        'edited',
        'rejected',
        'rejected',
        'rejected',
        'superseded',
        'superseded',
        'pending',
      ] as const;
      for (const [index, state] of states.entries()) {
        const runId = newId();
        const conversationId = conversation((index % 6) + 1);
        await tx.insert(schema.runs).values({
          id: runId,
          tenantId,
          conversationId,
          brandId: brand4,
          triggerRef: `draft:stats:${index}`,
          kind: 'draft',
          state: 'succeeded',
          outcome: 'drafted',
          epoch: 1,
        });
        const decided = state === 'approved' || state === 'edited' || state === 'rejected';
        const draftId = newId();
        await tx.insert(schema.aiDrafts).values({
          id: draftId,
          tenantId,
          conversationId,
          runId,
          triggerLedgerId: asked.id,
          ownerEpoch: 1,
          text: 'Your parcel is on its way.',
          state,
          supersededReason: state === 'superseded' ? 'customer_wrote' : null,
          decidedBy: decided ? staff.id : null,
          decidedAt: state === 'pending' ? null : new Date('2026-09-13T10:05:00Z'),
          createdAt: new Date('2026-09-13T10:00:00Z'),
        });
        if (state === 'rejected') {
          await tx.insert(schema.aiDraftDecisions).values({
            tenantId,
            draftId,
            staffMemberId: staff.id,
            clientRequestId: newId(),
            decision: 'rejected',
            reason: 'inaccurate',
            ownerEpoch: 1,
          });
        }
      }
    });
  });

  it('reports how often reply-time targets were met, from the clocks that ended', async () => {
    const res = await shop.owner.get(
      `/v1/admin/analytics/overview?${WEEK}&brandId=${brand4Public}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const r = res.body.replyTargets;
    expect(r.recordingSince).toBe('2026-09-09T09:00:00.000Z');
    expect(r.met).toMatchObject({ value: 4, sample: 6, suppressed: false });
    expect(r.met.rate).toBeCloseTo(4 / 6, 3);
    // Two misses are fewer than three: withheld, rate too. One stopped clock is withheld.
    expect(r.missed).toEqual({ value: null, suppressed: true, sample: 6, rate: null });
    expect(r.stopped).toEqual({ value: null, suppressed: true, sample: 7 });
    expect(r.firstReplyMedianMinutes).toEqual({ value: 30, suppressed: false, sample: 5 });
    expect(r.byPriority).toEqual([
      { priority: 'urgent', replies: null, metRate: null, suppressed: true },
      { priority: 'high', replies: null, metRate: null, suppressed: true },
      { priority: 'medium', replies: 4, metRate: 1, suppressed: false },
      { priority: 'low', replies: 0, metRate: null, suppressed: false },
    ]);
    // 11 September: three replies, but only one met, so its rate is withheld.
    expect(r.daily.slice(0, 3)).toEqual([
      { date: '2026-09-10', replies: 3, metRate: 1, suppressed: false },
      { date: '2026-09-11', replies: 3, metRate: null, suppressed: false },
      { date: '2026-09-12', replies: 0, metRate: null, suppressed: false },
    ]);
    expect(r.daily).toHaveLength(7);
  });

  it('reports offers accepted, declined and run out, and the hand-offs left in the queue', async () => {
    const { offers } = (
      await shop.owner.get(`/v1/admin/analytics/overview?${WEEK}&brandId=${brand4Public}`)
    ).body;
    expect(offers.windowLimited).toBe(false);
    expect(offers.offered).toEqual({ value: 11, suppressed: false, sample: 11 });
    expect(offers.accepted).toMatchObject({ value: 3, sample: 10, rate: 0.3 });
    expect(offers.declined).toMatchObject({ value: 6, sample: 10, rate: 0.6 });
    expect(offers.expired).toEqual({ value: null, suppressed: true, sample: 10, rate: null });
    expect(offers.cancelled).toMatchObject({ value: null, suppressed: true });
    expect(offers.acceptMedianSeconds).toEqual({ value: 60, suppressed: false, sample: 3 });
    expect(offers.leftInQueue).toEqual({ value: null, suppressed: true, sample: 6, rate: null });
    expect(offers.declineReasons).toEqual([
      { reason: 'at_capacity', count: 3, suppressed: false },
      { reason: 'not_my_area', count: null, suppressed: true },
      { reason: 'going_offline', count: null, suppressed: true },
    ]);
    expect(offers.byTeam).toEqual([
      {
        teamId: toPublicId('team', teamA),
        name: '=SUM(1+1)',
        offered: 11,
        acceptRate: 0.3,
        suppressed: false,
      },
    ]);
  });

  it('reports AI drafts sent, edited, rejected and set aside, with the reasons', async () => {
    const { aiDrafts } = (
      await shop.owner.get(`/v1/admin/analytics/overview?${WEEK}&brandId=${brand4Public}`)
    ).body;
    expect(aiDrafts.windowLimited).toBe(false);
    expect(aiDrafts.written).toEqual({ value: 10, suppressed: false, sample: 10 });
    expect(aiDrafts.sent).toMatchObject({ value: 4, sample: 7 });
    expect(aiDrafts.sent.rate).toBeCloseTo(4 / 7, 3);
    expect(aiDrafts.approved).toMatchObject({ value: 3, sample: 7 });
    expect(aiDrafts.edited).toEqual({ value: null, suppressed: true, sample: 7, rate: null });
    expect(aiDrafts.rejected).toMatchObject({ value: 3, sample: 7 });
    expect(aiDrafts.setAside).toMatchObject({ value: null, suppressed: true, sample: 10 });
    expect(aiDrafts.rejectReasons).toEqual([
      { reason: 'inaccurate', count: 3, suppressed: false },
    ]);
    expect(aiDrafts.setAsideReasons).toEqual([
      { reason: 'customer_wrote', count: null, suppressed: true },
    ]);
    expect(aiDrafts.byAgent).toHaveLength(1);
    expect(aiDrafts.byAgent[0]).toMatchObject({ agentId: null, written: 10, suppressed: false });
    expect(aiDrafts.byAgent[0].sentRate).toBeCloseTo(4 / 7, 3);
  });

  it('follows the brand filter, says when offers and drafts are past keeping, and exports', async () => {
    const elsewhere = (
      await shop.owner.get(`/v1/admin/analytics/overview?${WEEK}&brandId=${shop.brand.id}`)
    ).body;
    expect(elsewhere.replyTargets.met.value).toBe(0);
    expect(elsewhere.offers.offered.value).toBe(0);
    expect(elsewhere.aiDrafts.written.value).toBe(0);

    const old = (
      await shop.owner.get(`/v1/admin/analytics/overview?from=2026-01-01&to=2026-01-07`)
    ).body;
    expect(old.offers.windowLimited).toBe(true);
    expect(old.aiDrafts.windowLimited).toBe(true);

    const other = await connectedTenant(slice, 'stats-queue-other');
    const theirs = (await other.owner.get(`/v1/admin/analytics/overview?${WEEK}`)).body;
    expect(theirs.replyTargets.met.value).toBe(0);
    expect(theirs.replyTargets.recordingSince).toBeNull();
    expect(theirs.offers.offered.value).toBe(0);

    const csv = await shop.owner.get(`/v1/admin/analytics/export?${WEEK}&brandId=${brand4Public}`);
    const lines = String(csv.body).trim().split('\r\n');
    expect(lines).toContain('reply_targets,met,4,0.6667,false,6');
    expect(lines).toContain('reply_targets_priority,medium,4,1,false,');
    expect(lines).toContain('offers,accepted,3,0.3,false,10');
    expect(lines).toContain('offer_decline_reason,at_capacity,3,,false,');
    expect(lines).toContain("offer_team,'=SUM(1+1),11,0.3,false,");
    expect(lines).toContain('ai_drafts,rejected,3,0.4286,false,7');
    expect(lines).toContain('ai_draft_reject_reason,inaccurate,3,,false,');
  });
});
