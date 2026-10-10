import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
const blogOrigin = 'https://blog.rename.example';

const brandPath = () => `/v1/admin/brands/${shop.brand.id}`;

async function brandAudits() {
  return withTenant(slice.app, { tenantId: fromPublicId('tenant', shop.tenantId) }, (tx) =>
    tx.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'brand.updated')),
  );
}

beforeAll(async () => {
  slice = await startSlice();
  shop = await connectedTenant(slice, 'rename', { publishAgent: false });
});

afterAll(async () => {
  await slice?.close();
});

describe('editing a brand (board 04)', () => {
  it('renames it and replaces its websites, ending chats on the websites removed', async () => {
    const shopper = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
    await shopper.open();
    const both = await shop.owner.patch(brandPath(), {
      allowedOrigins: [shop.hostOrigin, blogOrigin],
    });
    expect(both.status, JSON.stringify(both.body)).toBe(200);
    expect(both.body.allowedOrigins).toEqual([shop.hostOrigin, blogOrigin]);
    const reader = new Visitor(slice.baseUrl, shop.brand.widgetId, blogOrigin);
    const opened = await reader.open();

    const edited = await shop.owner.patch(brandPath(), {
      name: '  Noor Books ',
      allowedOrigins: [blogOrigin],
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ name: 'Noor Books', allowedOrigins: [blogOrigin] });

    // The chat on the removed website ends at once and cannot come back.
    expect((await shopper.call('GET', '/v1/widget/conversations')).status).toBe(401);
    const refused = await shopper.call('POST', '/v1/widget/sessions/refresh', {
      refreshToken: shopper.refreshToken,
    });
    expect(refused.status).toBe(401);
    const again = await new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin).call(
      'POST',
      '/v1/widget/sessions',
      { widgetId: shop.brand.widgetId, hostOrigin: shop.hostOrigin },
    );
    expect(again.body).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });

    // The website still allowed keeps its chat and sees the new name.
    expect((await reader.call('GET', '/v1/widget/conversations')).status).toBe(200);
    const refreshed = await reader.call('POST', '/v1/widget/sessions/refresh', {
      refreshToken: reader.refreshToken,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.config.brand.name).toBe('Noor Books');
    expect(refreshed.body.config.version).toBeGreaterThan(opened.config.version);
    const frames = await reader.call(
      'GET',
      `/v1/widget/frame-policy?widgetId=${shop.brand.widgetId}`,
    );
    expect(frames.body.frameAncestors).toEqual([blogOrigin]);

    expect((await brandAudits()).map((a) => a.data)).toEqual([
      { allowedOrigins: { added: [blogOrigin], removed: [] }, endedSessions: 0 },
      {
        name: { from: 'rename Shop', to: 'Noor Books' },
        allowedOrigins: { added: [], removed: [shop.hostOrigin] },
        endedSessions: 1,
      },
    ]);
  });

  it('records nothing when nothing changes, and refuses what cannot be right', async () => {
    const audits = (await brandAudits()).length;
    const same = await shop.owner.patch(brandPath(), {
      name: 'Noor Books',
      allowedOrigins: [blogOrigin, blogOrigin],
    });
    expect(same.status).toBe(200);
    expect(same.body.allowedOrigins).toEqual([blogOrigin]);
    expect(await brandAudits()).toHaveLength(audits);

    for (const bad of [
      {},
      { name: '   ' },
      { allowedOrigins: ['https://shop.example/checkout'] },
      { allowedOrigins: ['shop.example'] },
    ]) {
      expect((await shop.owner.patch(brandPath(), bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect((await shop.owner.patch('/v1/admin/brands/brd_unknown', { name: 'X' })).status).toBe(
      404,
    );
    const other = await connectedTenant(slice, 'elsewhere', { publishAgent: false });
    expect((await other.owner.patch(brandPath(), { name: 'Taken' })).status).toBe(404);
  });
});

describe('where the chat runs (HNV-01-04)', () => {
  let site: Awaited<ReturnType<typeof connectedTenant>>;
  const installs = () => site.owner.get('/v1/admin/brands/installs');
  const launcher = (origin?: string) =>
    fetch(`${slice.baseUrl}/v1/widget/launcher?widgetId=${site.brand.widgetId}`, {
      headers: origin ? { origin } : {},
    });

  beforeAll(async () => {
    site = await connectedTenant(slice, 'install', { publishAgent: false });
  });

  it('notes an allowed website once its page loads the chat, and nothing else', async () => {
    expect((await installs()).body).toEqual({ items: [] });
    // A website the brand did not allow, and a request that names no website, are not installs.
    expect((await launcher('https://evil.example')).status).toBe(403);
    expect((await launcher()).status).toBe(200);
    expect((await installs()).body).toEqual({ items: [] });

    expect((await launcher(site.hostOrigin)).status).toBe(200);
    const seen = await installs();
    expect(seen.status).toBe(200);
    expect(seen.body.items).toEqual([
      {
        brandId: site.brand.id,
        origin: site.hostOrigin,
        firstSeenAt: expect.any(String),
        lastSeenAt: expect.any(String),
      },
    ]);
    // Every page loads the launcher; a busy website is written every few minutes, not per page.
    expect((await launcher(site.hostOrigin)).status).toBe(200);
    expect((await installs()).body.items[0].lastSeenAt).toBe(seen.body.items[0].lastSeenAt);
  });

  it('is shown only to the brand’s own workspace', async () => {
    const others = await shop.owner.get('/v1/admin/brands/installs');
    expect(others.status).toBe(200);
    expect(others.body.items.map((item: { brandId: string }) => item.brandId)).not.toContain(
      site.brand.id,
    );
  });

  it('forgets a website taken off the brand’s list', async () => {
    const other = 'https://other.install.example';
    expect(
      (await site.owner.patch(`/v1/admin/brands/${site.brand.id}`, { allowedOrigins: [other] }))
        .status,
    ).toBe(200);
    expect((await installs()).body).toEqual({ items: [] });
    const rows = await withTenant(
      slice.app,
      { tenantId: fromPublicId('tenant', site.tenantId) },
      (tx) => tx.select().from(schema.brandInstallSightings),
    );
    expect(rows).toEqual([]);
  });
});
