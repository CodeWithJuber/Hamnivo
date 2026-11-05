import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectedTenant, type Slice, startSlice } from './slice-harness.js';

let slice: Slice;
let tenant: Awaited<ReturnType<typeof connectedTenant>>;
let other: Awaited<ReturnType<typeof connectedTenant>>;
let sourceId: string;

const QUESTION = 'When do observatory tours begin?';
const search = (target = tenant, audience = 'customer') =>
  target.owner.post('/v1/admin/knowledge/search', {
    query: QUESTION,
    brandId: target.brand.id,
    audience,
  });

beforeAll(async () => {
  slice = await startSlice();
  tenant = await connectedTenant(slice, 'retrieval');
  other = await connectedTenant(slice, 'retrieval-other');
  const source = await tenant.owner.post('/v1/admin/knowledge/sources', {
    brandId: tenant.brand.id,
    name: 'Visitor guide',
    visibility: 'public',
  });
  expect(source.status).toBe(201);
  sourceId = source.body.id;
  const doc = await tenant.owner.post(`/v1/admin/knowledge/sources/${sourceId}/documents`, {
    title: 'Observatory tours',
    content: {
      mediaType: 'text/markdown',
      text: 'Observatory tours begin at sunset every Friday.',
    },
  });
  expect(doc.status).toBe(202);
  await slice.drain();
  const policy = await tenant.owner.put(`/v1/admin/brands/${tenant.brand.id}/cache/policy`, {
    tiers: { retrieval: { enabled: true, ttlSeconds: 600 } },
  });
  expect(policy.status).toBe(200);
});

afterAll(async () => {
  await slice?.close();
});

describe('public retrieval cache', () => {
  it('reuses ranking with citations and records the hit', async () => {
    const first = await search();
    const second = await search();
    expect(first.status).toBe(200);
    expect(first.body.items.length).toBeGreaterThan(0);
    expect(second.body.items).toEqual(first.body.items);
    const metrics = await tenant.owner.get(
      `/v1/admin/brands/${tenant.brand.id}/cache/metrics?days=1`,
    );
    const retrieval = metrics.body.rows.find((row: { tier: string }) => row.tier === 'retrieval');
    expect(retrieval.hits).toBeGreaterThanOrEqual(1);
    expect(retrieval.stores).toBeGreaterThanOrEqual(1);
  });

  it('never exposes another tenant’s ranking or source text', async () => {
    const result = await search(other);
    expect(result.status).toBe(200);
    expect(result.body.items).toEqual([]);
    const denied = await other.owner.post('/v1/admin/knowledge/search', {
      query: QUESTION,
      brandId: tenant.brand.id,
      audience: 'customer',
    });
    expect(denied.status).toBe(404);
  });

  it('immediately removes newly private sources from customer results while staff can search', async () => {
    await withTenant(slice.app, { tenantId: fromPublicId('tenant', tenant.tenantId) }, (tx) =>
      tx
        .update(schema.knowledgeSources)
        .set({ visibility: 'internal' })
        .where(eq(schema.knowledgeSources.id, fromPublicId('source', sourceId))),
    );
    expect((await search()).body.items).toEqual([]);
    expect((await search(tenant, 'staff')).body.items.length).toBeGreaterThan(0);
  });
});
