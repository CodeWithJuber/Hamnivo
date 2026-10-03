import { createHash, randomBytes } from 'node:crypto';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MaintenanceService } from '../src/worker/maintenance.service.js';
import type { Client } from './harness.js';
import { customerStarts, join, type Shop } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.109 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';

let slice: Slice;
let desk: Shop;
let outlet: Shop;
let other: Shop;
let amina: { client: Client; staffId: string };
let ana: { client: Client; staffId: string };
let tenantId: string;

const newKey = () => randomBytes(16).toString('base64url');

interface Sent {
  status: number;
  body: any;
  headers: Headers;
}

/** What the chat loader sends from a visitor's browser: JSON as text/plain, no preflight. */
async function report(
  shop: Shop,
  key: string,
  event: 'view' | 'beat' | 'leave',
  page: { url?: string; title?: string; referrer?: string; language?: string } = {},
  headers: Record<string, string> = {},
  as: 'text' | 'json' = 'text',
): Promise<Sent> {
  const body = JSON.stringify({
    widgetId: shop.brand.widgetId,
    key,
    event,
    url: page.url ?? `${shop.hostOrigin}/pricing`,
    ...(page.title ? { title: page.title } : {}),
    ...(page.referrer ? { referrer: page.referrer } : {}),
    ...(page.language ? { language: page.language } : {}),
  });
  const response = await fetch(`${slice.baseUrl}/v1/widget/visits`, {
    method: 'POST',
    headers: {
      origin: shop.hostOrigin,
      'user-agent': CHROME,
      'content-type': as === 'text' ? 'text/plain;charset=UTF-8' : 'application/json',
      ...headers,
    },
    body,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : undefined,
    headers: response.headers,
  };
}

const tenantRows = <T>(work: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) =>
  withTenant(slice.app, { tenantId }, work);

const visitorRows = () => tenantRows((tx) => tx.select().from(schema.visitors));
const sessionRows = () => tenantRows((tx) => tx.select().from(schema.visitorSessions));
const viewRows = () =>
  tenantRows((tx) =>
    tx.select().from(schema.visitorPageViews).orderBy(schema.visitorPageViews.viewedAt),
  );

async function setVisitorSettings(settings: { tracking: boolean; keepQueryStrings: boolean }) {
  const saved = await desk.owner.put(
    `/v1/admin/brands/${desk.brand.id}/visitor-settings`,
    settings,
  );
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
}

beforeAll(async () => {
  slice = await startSlice();
  desk = await connectedTenant(slice, 'desk');
  tenantId = fromPublicId('tenant', desk.tenantId);
  const brand = await desk.owner.post('/v1/admin/brands', {
    workspaceId: desk.workspaceId,
    name: 'desk Outlet',
    allowedOrigins: ['https://outlet.example'],
  });
  const connection = await desk.owner.post('/v1/admin/authority/connections', {
    brandId: brand.body.id,
  });
  const agents = await desk.owner.get('/v1/admin/agents');
  const agentId = agents.body.items.find((a: { brandId: string }) => a.brandId === brand.body.id)
    ?.id as string;
  await desk.owner.post(`/v1/admin/agents/${agentId}/publish`, {});
  outlet = {
    ...desk,
    agentId,
    brand: brand.body,
    connection: connection.body,
    hostOrigin: 'https://outlet.example',
  };
  other = await connectedTenant(slice, 'other');
  amina = await join(slice, desk, 'Amina Agent', 'agent', { type: 'brand', id: desk.brand.id });
  ana = await join(slice, desk, 'Ana Analyst', 'analyst');
});

afterAll(async () => {
  await slice?.close();
});

describe('reporting a visit', () => {
  it('stores the page, the device and the country, and never the key or an address', async () => {
    const key = newKey();
    const sent = await report(
      desk,
      key,
      'view',
      {
        url: `${desk.hostOrigin}/pricing/teams?email=maya@example.com&utm_source=ad#plans`,
        title: 'Pricing · Noor Books',
        referrer: 'https://www.google.com/search?q=noor+books',
        language: 'en-GB',
      },
      { 'cf-ipcountry': 'PK', 'x-forwarded-for': '203.0.113.9' },
    );
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body).toEqual({ tracking: true, invite: null });
    // The brand's own website may read the answer; nobody else.
    expect(sent.headers.get('access-control-allow-origin')).toBe(desk.hostOrigin);
    expect(sent.headers.get('vary')).toContain('Origin');

    const [visitor] = await visitorRows();
    expect(visitor).toMatchObject({ visitCount: 1, principalId: null });
    // Only the hash of the key is stored.
    expect(visitor?.keyHash.equals(createHash('sha256').update(key).digest())).toBe(true);
    const [session] = await sessionRows();
    expect(session).toMatchObject({
      country: 'PK',
      browser: 'Chrome',
      browserVersion: '120',
      os: 'Windows',
      osVersion: '10',
      deviceType: 'desktop',
      language: 'en-GB',
      referrer: 'https://www.google.com/search',
      entryUrl: `${desk.hostOrigin}/pricing/teams`,
      currentUrl: `${desk.hostOrigin}/pricing/teams`,
      currentTitle: 'Pricing · Noor Books',
      pageCount: 1,
      endedAt: null,
    });
    const views = await viewRows();
    expect(views.map((v) => v.url)).toEqual([`${desk.hostOrigin}/pricing/teams`]);

    // Nothing in any column holds the key, the query string or an address.
    const everything = JSON.stringify([visitor, session, views]);
    expect(everything).not.toContain(key);
    expect(everything).not.toContain('maya@example.com');
    expect(everything).not.toContain('utm_source');
    expect(everything).not.toContain('203.0.113.9');
    expect(everything).not.toContain('plans');
  });

  it('counts a page once, notes it is still open, and adds a page when the visitor moves on', async () => {
    const key = newKey();
    await report(desk, key, 'view', { url: `${desk.hostOrigin}/shipping`, title: 'Shipping' });
    // A page that reports itself twice at once is one view.
    await report(desk, key, 'view', { url: `${desk.hostOrigin}/shipping`, title: 'Shipping' });
    // "Still here" on the same page adds nothing.
    await report(desk, key, 'beat', { url: `${desk.hostOrigin}/shipping`, title: 'Shipping' });
    let views = (await viewRows()).filter((v) => v.url.endsWith('/shipping'));
    expect(views).toHaveLength(1);

    // A beat from another page (a site that changes pages without a reload) counts as a view.
    await report(desk, key, 'beat', { url: `${desk.hostOrigin}/returns`, title: 'Returns' });
    views = (await viewRows()).filter((v) => /\/(shipping|returns)$/.test(v.url));
    expect(views.map((v) => v.url.split('/').pop())).toEqual(['shipping', 'returns']);
    const visitor = (await visitorRows()).find((v) =>
      v.keyHash.equals(createHash('sha256').update(key).digest()),
    );
    const session = (await sessionRows()).find((s) => s.visitorId === visitor?.id);
    expect(session).toMatchObject({
      currentUrl: `${desk.hostOrigin}/returns`,
      currentTitle: 'Returns',
      pageCount: 2,
    });
  });

  it('writes a sign of life at most every half minute', async () => {
    const key = newKey();
    await report(desk, key, 'view', { url: `${desk.hostOrigin}/care` });
    const hash = createHash('sha256').update(key).digest();
    const find = async () => {
      const visitor = (await visitorRows()).find((v) => v.keyHash.equals(hash));
      return (await sessionRows()).find((s) => s.visitorId === visitor?.id);
    };
    const first = await find();
    await report(desk, key, 'beat', { url: `${desk.hostOrigin}/care` });
    expect((await find())?.lastSeenAt.getTime()).toBe(first?.lastSeenAt.getTime());
    // After half a minute the next one is written.
    await tenantRows((tx) =>
      tx
        .update(schema.visitorSessions)
        .set({ lastSeenAt: new Date(Date.now() - 45_000) })
        .where(eq(schema.visitorSessions.id, first?.id ?? '')),
    );
    await report(desk, key, 'beat', { url: `${desk.hostOrigin}/care` });
    expect(Date.now() - (await find())!.lastSeenAt.getTime()).toBeLessThan(10_000);
  });

  it('ends the visit when the page closes, and counts a returning visitor’s next visit', async () => {
    const key = newKey();
    const hash = createHash('sha256').update(key).digest();
    await report(desk, key, 'view', { url: `${desk.hostOrigin}/a` });
    const left = await report(desk, key, 'leave', { url: `${desk.hostOrigin}/a` });
    expect(left.body).toEqual({ tracking: true, invite: null });
    const visitor = () => visitorRows().then((rows) => rows.find((v) => v.keyHash.equals(hash)));
    const sessions = () =>
      sessionRows().then((rows) => rows.filter((s) => s.visitorId === visitorRowId));
    let visitorRowId = (await visitor())?.id;
    expect((await sessions())[0]?.endedAt).toBeInstanceOf(Date);

    // The visitor comes back: a new visit, and the count goes up.
    await report(desk, key, 'view', { url: `${desk.hostOrigin}/b` });
    visitorRowId = (await visitor())?.id;
    expect(await sessions()).toHaveLength(2);
    expect((await visitor())?.visitCount).toBe(2);

    // A visit nobody closed (a laptop shut) ends when it was last seen; the next page opens a new one.
    await tenantRows((tx) =>
      tx
        .update(schema.visitorSessions)
        .set({ lastSeenAt: new Date(Date.now() - 40 * 60_000) })
        .where(
          and(
            eq(schema.visitorSessions.visitorId, visitorRowId ?? ''),
            eq(schema.visitorSessions.currentUrl, `${desk.hostOrigin}/b`),
          ),
        ),
    );
    await report(desk, key, 'beat', { url: `${desk.hostOrigin}/c` });
    const all = await sessions();
    expect(all).toHaveLength(3);
    expect(all.filter((s) => s.endedAt === null)).toHaveLength(1);
    expect((await visitor())?.visitCount).toBe(3);
  });
});

describe('who may be reported', () => {
  it('stores nothing for a browser that says Do Not Track or Global Privacy Control', async () => {
    const before = [(await visitorRows()).length, (await viewRows()).length];
    for (const header of [{ dnt: '1' }, { 'sec-gpc': '1' }] as Record<string, string>[]) {
      const sent = await report(desk, newKey(), 'view', { url: `${desk.hostOrigin}/dnt` }, header);
      expect(sent.body).toEqual({ tracking: false, invite: null });
    }
    expect([(await visitorRows()).length, (await viewRows()).length]).toEqual(before);
  });

  it('leaves out search engines and scripts', async () => {
    const before = (await visitorRows()).length;
    const sent = await report(
      desk,
      newKey(),
      'view',
      {},
      { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    );
    expect(sent.body.tracking).toBe(false);
    expect((await visitorRows()).length).toBe(before);
  });

  it('refuses a website the brand did not allow, a page of another website, and an unknown chat', async () => {
    const before = (await viewRows()).length;
    const foreign = await fetch(`${slice.baseUrl}/v1/widget/visits`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'content-type': 'text/plain',
        'user-agent': CHROME,
      },
      body: JSON.stringify({
        widgetId: desk.brand.widgetId,
        key: newKey(),
        event: 'view',
        url: 'https://evil.example/x',
      }),
    });
    expect(foreign.status).toBe(403);
    // No permission to read the answer, either.
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();

    // An allowed website reporting a page that is not its own is ignored.
    const mismatch = await report(desk, newKey(), 'view', { url: 'https://evil.example/phish' });
    expect(mismatch.body).toEqual({ tracking: true, invite: null });

    const unknown = await fetch(`${slice.baseUrl}/v1/widget/visits`, {
      method: 'POST',
      headers: { origin: desk.hostOrigin, 'content-type': 'text/plain', 'user-agent': CHROME },
      body: JSON.stringify({
        widgetId: 'wid_01j9zk7w3xq8r4t2v6m5n1p0cd',
        key: newKey(),
        event: 'view',
        url: `${desk.hostOrigin}/`,
      }),
    });
    expect(unknown.status).toBe(404);
    expect((await viewRows()).length).toBe(before);
  });

  it('checks the report: JSON, a good key, a page address', async () => {
    const notJson = await fetch(`${slice.baseUrl}/v1/widget/visits`, {
      method: 'POST',
      headers: { origin: desk.hostOrigin, 'content-type': 'text/plain', 'user-agent': CHROME },
      body: 'not json',
    });
    expect(notJson.status).toBe(422);
    expect((await report(desk, 'short', 'view')).status).toBe(422);
    expect((await report(desk, newKey(), 'view', { url: 'javascript:alert(1)' })).body).toEqual({
      tracking: true,
      invite: null,
    });
    // The same report as application/json is read too.
    expect((await report(desk, newKey(), 'view', {}, {}, 'json')).body.tracking).toBe(true);
  });
});

describe('the brand’s choice', () => {
  it('stops everything when the brand turns tracking off, and starts again when it turns it on', async () => {
    const before = (await visitorRows()).length;
    await setVisitorSettings({ tracking: false, keepQueryStrings: false });
    const off = await report(desk, newKey(), 'view');
    expect(off.body).toEqual({ tracking: false, invite: null });
    expect((await visitorRows()).length).toBe(before);
    await setVisitorSettings({ tracking: true, keepQueryStrings: false });
    expect((await report(desk, newKey(), 'view')).body.tracking).toBe(true);
    expect((await visitorRows()).length).toBe(before + 1);
  });

  it('keeps query strings only when the brand chose to, and then without secrets', async () => {
    await setVisitorSettings({ tracking: true, keepQueryStrings: true });
    const key = newKey();
    await report(desk, key, 'view', {
      url: `${desk.hostOrigin}/search?q=shoes&token=abc123&page=2`,
    });
    const kept = (await viewRows()).find((v) => v.url.includes('/search'));
    expect(kept?.url).toContain('q=shoes');
    expect(kept?.url).toContain('page=2');
    expect(kept?.url).not.toContain('abc123');
    await setVisitorSettings({ tracking: true, keepQueryStrings: false });
  });

  it('is changed only by people who configure the widget, and each change is audited', async () => {
    const settings = await desk.owner.get(`/v1/admin/brands/${desk.brand.id}/visitor-settings`);
    expect(settings.body).toMatchObject({
      brandId: desk.brand.id,
      settings: { tracking: true, keepQueryStrings: false },
    });
    expect(
      (
        await amina.client.put(`/v1/admin/brands/${desk.brand.id}/visitor-settings`, {
          tracking: false,
          keepQueryStrings: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (await amina.client.get(`/v1/admin/brands/${desk.brand.id}/visitor-settings`)).status,
    ).toBe(403);
    expect(
      (
        await desk.owner.put(`/v1/admin/brands/${desk.brand.id}/visitor-settings`, {
          tracking: 'yes',
        })
      ).status,
    ).toBe(422);
    const audited = await tenantRows((tx) =>
      tx
        .select({ action: schema.auditEvents.action })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, 'brand.visitor_settings.updated')),
    );
    expect(audited.length).toBeGreaterThanOrEqual(1);
    // Another workspace's brand is not found, not forbidden.
    expect(
      (await other.owner.get(`/v1/admin/brands/${desk.brand.id}/visitor-settings`)).status,
    ).toBe(404);
  });
});

describe('the visitor next to a conversation', () => {
  it('links the browser the chat runs in, tells the visitor, and shows staff the pages', async () => {
    const key = newKey();
    await report(
      desk,
      key,
      'view',
      { url: `${desk.hostOrigin}/pricing`, title: 'Pricing' },
      { 'cf-ipcountry': 'AE', 'user-agent': IPHONE },
    );
    await report(
      desk,
      key,
      'view',
      { url: `${desk.hostOrigin}/contact`, title: 'Contact us' },
      {
        'cf-ipcountry': 'AE',
        'user-agent': IPHONE,
      },
    );

    const { visitor, conversationId } = await customerStarts(slice, desk, 'Do you ship to Dubai?');
    await slice.drain();
    const linked = await visitor.call('POST', '/v1/widget/visitors/link', {
      visitorKey: key,
      locale: 'en',
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body.tracking).toBe(true);
    expect(linked.body.notice).toContain('notes which pages you view');
    expect(linked.body.notice).toContain('Do Not Track');
    expect(linked.body.invite).toBeNull();

    const card = await desk.owner.get(`/v1/inbox/conversations/${conversationId}/visitor`);
    expect(card.status, JSON.stringify(card.body)).toBe(200);
    expect(card.body.tracking).toBe(true);
    expect(card.body.visitor).toMatchObject({
      visitCount: 1,
      returning: false,
      online: true,
      country: 'AE',
      device: { type: 'mobile', browser: 'Safari 17', os: 'iOS 17' },
      entryUrl: `${desk.hostOrigin}/pricing`,
      currentPage: { url: `${desk.hostOrigin}/contact`, title: 'Contact us' },
    });
    expect(card.body.visitor.pages.map((p: { url: string }) => p.url)).toEqual([
      `${desk.hostOrigin}/contact`,
      `${desk.hostOrigin}/pricing`,
    ]);
    expect(card.body.visitor.timeOnSiteSeconds).toBeGreaterThanOrEqual(0);

    // The browser's other tab does not change who the conversation belongs to.
    expect(
      (await amina.client.get(`/v1/inbox/conversations/${conversationId}/visitor`)).body.visitor.id,
    ).toBe(card.body.visitor.id);
  });

  it('says nothing is noted for a visitor with Do Not Track, and links nothing', async () => {
    const key = newKey();
    const { visitor, conversationId } = await customerStarts(
      slice,
      desk,
      'Is this open on Friday?',
    );
    await slice.drain();
    const linked = await visitor.call(
      'POST',
      '/v1/widget/visitors/link',
      { visitorKey: key },
      { dnt: '1' },
    );
    expect(linked.body).toEqual({ tracking: false, notice: null, invite: null });
    expect(
      (await desk.owner.get(`/v1/inbox/conversations/${conversationId}/visitor`)).body.visitor,
    ).toBeNull();
    const gpc = await visitor.call(
      'POST',
      '/v1/widget/visitors/link',
      { visitorKey: key },
      { 'sec-gpc': '1' },
    );
    expect(gpc.body.tracking).toBe(false);
  });

  it('says nothing is noted when the brand does not, and shows no card to someone who cannot see the chat', async () => {
    const { visitor, conversationId } = await customerStarts(slice, desk, 'Hello?');
    await slice.drain();
    await setVisitorSettings({ tracking: false, keepQueryStrings: false });
    const linked = await visitor.call('POST', '/v1/widget/visitors/link', { visitorKey: newKey() });
    expect(linked.body).toEqual({ tracking: false, notice: null, invite: null });
    expect(
      (await desk.owner.get(`/v1/inbox/conversations/${conversationId}/visitor`)).body,
    ).toEqual({ tracking: false, visitor: null });
    await setVisitorSettings({ tracking: true, keepQueryStrings: false });
    // Another tenant cannot read it, and a customer needs a session to link anything.
    expect(
      (await other.owner.get(`/v1/inbox/conversations/${conversationId}/visitor`)).status,
    ).toBe(404);
    const anonymous = await new Visitor(slice.baseUrl, desk.brand.widgetId, desk.hostOrigin).call(
      'POST',
      '/v1/widget/visitors/link',
      { visitorKey: newKey() },
    );
    expect(anonymous.status).toBe(401);
  });
});

describe('live visitors', () => {
  it('lists who is on the website now, with their page, device, country and visit', async () => {
    const live = await desk.owner.get('/v1/visitors/live');
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    const items = live.body.items as any[];
    expect(items.length).toBeGreaterThan(0);
    const dubai = items.find((v) => v.page.url === `${desk.hostOrigin}/contact`);
    expect(dubai).toMatchObject({
      brand: { id: desk.brand.id, name: 'desk Shop' },
      country: 'AE',
      device: { type: 'mobile', browser: 'Safari 17', os: 'iOS 17' },
      returning: false,
      visitCount: 1,
      page: { title: 'Contact us' },
      identified: false,
      canInvite: true,
    });
    expect(dubai.id).toMatch(/^vis_/);
    // Anonymous: "Visitor" and a short code; the chat they opened is linked.
    expect(dubai.name).toMatch(/^Visitor [0-9A-Z]{4}$/);
    expect(dubai.conversationId).toMatch(/^conv_/);
    expect(live.body.generatedAt).toEqual(expect.any(String));
    // Visitors who closed the page are not listed.
    expect(items.find((v) => v.page.url === `${desk.hostOrigin}/a`)).toBeUndefined();
  });

  it('shows each person only the brands their role reaches, and who may invite', async () => {
    const outletKey = newKey();
    await report(outlet, outletKey, 'view', { url: `${outlet.hostOrigin}/bags`, title: 'Bags' });
    const owner = (await desk.owner.get('/v1/visitors/live')).body.items as any[];
    expect(owner.some((v) => v.brand.name === 'desk Outlet')).toBe(true);
    // Amina answers the first brand only.
    const mine = (await amina.client.get('/v1/visitors/live')).body.items as any[];
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((v) => v.brand.id === desk.brand.id)).toBe(true);
    // Ana may read, not reply: she sees visitors but cannot invite them.
    const reader = (await ana.client.get('/v1/visitors/live')).body.items as any[];
    expect(reader.length).toBeGreaterThan(owner.length - 1);
    expect(reader.every((v) => v.canInvite === false)).toBe(true);
    // Filtering by brand, and another tenant sees none of it.
    const filtered = (await desk.owner.get(`/v1/visitors/live?brandId=${outlet.brand.id}`)).body
      .items as any[];
    expect(filtered.map((v) => v.brand.name)).toEqual(['desk Outlet']);
    expect((await other.owner.get('/v1/visitors/live')).body.items).toEqual([]);
    expect((await desk.owner.get('/v1/visitors/live?brandId=nope')).status).toBe(422);
  });

  it('knows a visitor by name once they gave one, and a returning visitor from a first-time one', async () => {
    const key = newKey();
    const hash = createHash('sha256').update(key).digest();
    await report(desk, key, 'view', { url: `${desk.hostOrigin}/welcome-back` });
    await report(desk, key, 'leave', {});
    await report(desk, key, 'view', { url: `${desk.hostOrigin}/welcome-back` });
    const live = (await desk.owner.get('/v1/visitors/live')).body.items as any[];
    const found = live.find((v) => v.page.url === `${desk.hostOrigin}/welcome-back`);
    expect(found).toMatchObject({ returning: true, visitCount: 2 });
    // The customer's name appears once the chat has it.
    const row = (await visitorRows()).find((v) => v.keyHash.equals(hash));
    const { visitor: chatter } = await customerStarts(slice, desk, 'Hi');
    const principalId = chatter.principalId;
    await tenantRows(async (tx) => {
      await tx
        .update(schema.customerPrincipals)
        .set({ displayName: 'Maya Khan' })
        .where(eq(schema.customerPrincipals.id, fromPublicId('customer', principalId)));
      await tx
        .update(schema.visitors)
        .set({ principalId: fromPublicId('customer', principalId) })
        .where(eq(schema.visitors.id, row?.id ?? ''));
    });
    const named = (await desk.owner.get('/v1/visitors/live')).body.items as any[];
    expect(named.find((v) => v.page.url === `${desk.hostOrigin}/welcome-back`)).toMatchObject({
      name: 'Maya Khan',
      identified: true,
    });
  });
});

describe('inviting a visitor to chat', () => {
  it('tells the loader with each report until the chat shows it, and then no more', async () => {
    const key = newKey();
    await report(desk, key, 'view', { url: `${desk.hostOrigin}/invite-me` });
    const target = ((await desk.owner.get('/v1/visitors/live')).body.items as any[]).find(
      (v) => v.page.url === `${desk.hostOrigin}/invite-me`,
    );
    const invited = await amina.client.post(`/v1/visitors/${target.id}/invite`, {
      message: '  Hi! Can I help you with sizes?  ',
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(202);
    expect(Date.parse(invited.body.expiresAt) - Date.now()).toBeGreaterThan(2 * 60_000);

    const next = await report(desk, key, 'beat', { url: `${desk.hostOrigin}/invite-me` });
    expect(next.body.tracking).toBe(true);
    expect(next.body.invite).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{16}$/),
      message: 'Hi! Can I help you with sizes?',
    });
    // The loader shows it once, so it may be told again and again until the chat has it.
    const again = await report(desk, key, 'beat', { url: `${desk.hostOrigin}/invite-me` });
    expect(again.body.invite).toEqual(next.body.invite);
    // The visitor opens the chat: it takes the invitation, and it is gone.
    const { visitor } = await customerStarts(slice, desk, 'Yes please');
    const taken = await visitor.call('POST', '/v1/widget/visitors/link', { visitorKey: key });
    expect(taken.body.invite).toEqual(next.body.invite);
    expect(
      (await report(desk, key, 'beat', { url: `${desk.hostOrigin}/invite-me` })).body.invite,
    ).toBe(null);

    // The invitation is on record: who sent which words to whom.
    const audited = await tenantRows((tx) =>
      tx
        .select({ data: schema.auditEvents.data })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, 'visitor.invited')),
    );
    expect(audited.some((a) => JSON.stringify(a.data).includes('Can I help you with sizes?'))).toBe(
      true,
    );
  });

  it('reaches the chat widget too, when the visitor opens the chat first', async () => {
    const key = newKey();
    await report(desk, key, 'view', { url: `${desk.hostOrigin}/invite-chat` });
    const target = ((await desk.owner.get('/v1/visitors/live')).body.items as any[]).find(
      (v) => v.page.url === `${desk.hostOrigin}/invite-chat`,
    );
    await desk.owner.post(`/v1/visitors/${target.id}/invite`, { message: 'Need a hand?' });
    const { visitor } = await customerStarts(slice, desk, 'Hello');
    const linked = await visitor.call('POST', '/v1/widget/visitors/link', { visitorKey: key });
    expect(linked.body.invite).toMatchObject({ message: 'Need a hand?' });
  });

  it('needs the right to reply, a visitor who is still here, and words', async () => {
    const key = newKey();
    await report(desk, key, 'view', { url: `${desk.hostOrigin}/refuse` });
    const target = ((await desk.owner.get('/v1/visitors/live')).body.items as any[]).find(
      (v) => v.page.url === `${desk.hostOrigin}/refuse`,
    );
    // Ana can read but not reply.
    expect(
      (await ana.client.post(`/v1/visitors/${target.id}/invite`, { message: 'Hello' })).status,
    ).toBe(403);
    // Another tenant cannot tell the visitor exists.
    expect(
      (await other.owner.post(`/v1/visitors/${target.id}/invite`, { message: 'Hello' })).status,
    ).toBe(404);
    expect(
      (await desk.owner.post(`/v1/visitors/${target.id}/invite`, { message: '  ' })).status,
    ).toBe(422);
    expect(
      (await desk.owner.post('/v1/visitors/vis_notanid/invite', { message: 'Hi' })).status,
    ).toBe(404);
    // A visitor who left cannot be invited.
    await report(desk, key, 'leave', {});
    const gone = await desk.owner.post(`/v1/visitors/${target.id}/invite`, { message: 'Hello' });
    expect(gone.status).toBe(404);
    expect(gone.body.detail).toContain('left');
    // No invitation is left waiting for a visitor who was refused.
    expect(
      (await report(desk, key, 'view', { url: `${desk.hostOrigin}/refuse` })).body.invite,
    ).toBe(null);
  });
});

describe('keeping visitors for 30 days', () => {
  it('removes visitors, visits and page views that have not been seen for 30 days', async () => {
    const key = newKey();
    const hash = createHash('sha256').update(key).digest();
    await report(desk, key, 'view', { url: `${desk.hostOrigin}/old` });
    const row = (await visitorRows()).find((v) => v.keyHash.equals(hash));
    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000);
    await tenantRows(async (tx) => {
      await tx
        .update(schema.visitors)
        .set({ lastSeenAt: old })
        .where(eq(schema.visitors.id, row?.id ?? ''));
      await tx
        .update(schema.visitorSessions)
        .set({ lastSeenAt: old, startedAt: old, endedAt: old })
        .where(eq(schema.visitorSessions.visitorId, row?.id ?? ''));
      await tx
        .update(schema.visitorPageViews)
        .set({ viewedAt: old })
        .where(eq(schema.visitorPageViews.visitorId, row?.id ?? ''));
    });
    const purged = (await slice.worker.get(MaintenanceService).run('purge-expired')) as Record<
      string,
      number
    >;
    expect(purged.visitors_removed).toBeGreaterThanOrEqual(1);
    expect((await visitorRows()).some((v) => v.id === row?.id)).toBe(false);
    expect((await sessionRows()).some((s) => s.visitorId === row?.id)).toBe(false);
    expect((await viewRows()).some((v) => v.visitorId === row?.id)).toBe(false);
    // Visitors seen lately are kept.
    expect((await visitorRows()).length).toBeGreaterThan(0);
  });
});
