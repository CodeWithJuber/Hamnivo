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
