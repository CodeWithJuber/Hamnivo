import { randomUUID } from 'node:crypto';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { CacheStore } from '@hamnivo/adapters/cache';
import { createMockModel } from '@hamnivo/adapters/models';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CacheExclusions } from '../src/cache/store.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/** The mock model, counting the calls that actually reach it. */
function countingModel() {
  const base = createMockModel();
  const state = { calls: 0 };
  const model: LanguageModelV4 = {
    ...base,
    async doGenerate(call) {
      state.calls += 1;
      const result = await base.doGenerate(call);
      // A reply that cites the first passage, so cached answers carry their sources.
      return {
        ...result,
        content: [{ type: 'text', text: 'Use the contact form on our website [1].' }],
      };
    },
  };
  return { model, state };
}

type Tenant = Awaited<ReturnType<typeof connectedTenant>>;
interface Brand {
  owner: Tenant['owner'];
  tenantId: string;
  brandId: string;
  widgetId: string;
  hostOrigin: string;
  agentId: string;
  sourceId: string;
  documentId: string;
}

const QUESTION = 'How can I contact the team?';
const counted = countingModel();
let slice: Slice;
let alpha: Brand;
let alphaSecond: Brand;
let beta: Brand;
let valkey: Redis;

async function withKnowledge(
  tenant: Tenant,
  brand: { id: string; widgetId: string },
  agentId: string,
  hostOrigin: string,
): Promise<Brand> {
  const { owner } = tenant;
  const source = await owner.post('/v1/admin/knowledge/sources', {
    brandId: brand.id,
    name: 'Help centre',
    visibility: 'public',
  });
  expect(source.status, JSON.stringify(source.body)).toBe(201);
  const document = await owner.post(`/v1/admin/knowledge/sources/${source.body.id}/documents`, {
    title: 'Contacting our team',
    content: {
      mediaType: 'text/markdown',
      text: '# Contact\n\nYou can contact our team through the contact form. We reply within one business day.',
    },
  });
  expect(document.status, JSON.stringify(document.body)).toBe(202);
  await slice.drain();
  const detail = await owner.get(`/v1/admin/agents/${agentId}`);
  const config = detail.body.published?.config ?? detail.body.draft.config;
  const draft = await owner.put(`/v1/admin/agents/${agentId}/draft`, {
    config: {
      ...config,
      languages: ['en', 'ur', 'hi', 'ar'],
      knowledgeSourceIds: [source.body.id],
    },
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(200);
  const published = await owner.post(`/v1/admin/agents/${agentId}/publish`, {});
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  const policy = await owner.put(`/v1/admin/brands/${brand.id}/cache/policy`, {
    tiers: { exact_answer: { enabled: true, ttlSeconds: 3600 } },
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
  return {
    owner,
    tenantId: owner.tenant as string,
    brandId: brand.id,
    widgetId: brand.widgetId,
    hostOrigin,
    agentId,
    sourceId: source.body.id,
    documentId: document.body.id,
  };
}

beforeAll(async () => {
  slice = await startSlice({ model: counted.model });
  const a = await connectedTenant(slice, 'cachealpha');
  alpha = await withKnowledge(a, a.brand, a.agentId, a.hostOrigin);
  // A second brand of the same tenant, with the same knowledge and settings.
  const brand = await a.owner.post('/v1/admin/brands', {
    workspaceId: a.workspaceId,
    name: 'Second Shop',
    allowedOrigins: ['https://second.example'],
  });
  expect(brand.status).toBe(201);
  const connection = await a.owner.post('/v1/admin/authority/connections', {
    brandId: brand.body.id,
  });
  expect(connection.status, JSON.stringify(connection.body)).toBe(201);
  const agents = await a.owner.get('/v1/admin/agents');
  const secondAgent = agents.body.items.find(
    (x: { brandId: string }) => x.brandId === brand.body.id,
  );
  alphaSecond = await withKnowledge(a, brand.body, secondAgent.id, 'https://second.example');
  const b = await connectedTenant(slice, 'cachebeta');
  beta = await withKnowledge(b, b.brand, b.agentId, b.hostOrigin);
  valkey = new Redis(slice.gw.config.REDIS_URL, { lazyConnect: true });
  await valkey.connect();
});

afterAll(async () => {
  valkey?.disconnect();
  await slice?.close();
});

async function ask(brand: Brand, text: string) {
  const visitor = new Visitor(slice.baseUrl, brand.widgetId, brand.hostOrigin);
  await visitor.open();
  const started = await visitor.call('POST', '/v1/widget/conversations', {
    firstMessage: text,
    clientMessageId: randomUUID(),
  });
  expect(started.status).toBe(201);
  const before = counted.state.calls;
  await slice.drain();
  const conversationId = started.body.id as string;
  const runs = await brand.owner.get(`/v1/admin/runs?conversationId=${conversationId}`);
  const run = await brand.owner.get(`/v1/admin/runs/${runs.body.items[0].id}`);
  const history = await visitor.call('GET', `/v1/widget/conversations/${conversationId}/messages`);
  const reply = (history.body.items as Array<Record<string, any>>).find(
    (m) => m.sender.kind === 'ai_agent',
  );
  return {
    visitor,
    conversationId,
    modelCalls: counted.state.calls - before,
    run: run.body as Record<string, any>,
    cacheStep: (run.body.steps as Array<Record<string, any>>).find(
      (s) => s.name === 'answer_cache',
    ),
    reply,
  };
}

async function entries(brand: Brand) {
  const listed = await brand.owner.get(
    `/v1/admin/brands/${brand.brandId}/cache/entries?tier=exact_answer`,
  );
  expect(listed.status).toBe(200);
  return listed.body.items as Array<Record<string, any>>;
}

describe('exact answer cache (K01)', () => {
  it('stores an eligible answer and reuses it for the same opening question', async () => {
    const first = await ask(alpha, QUESTION);
    expect(first.modelCalls).toBe(1);
    expect(first.cacheStep?.detail).toMatchObject({ outcome: 'miss' });
    expect(first.reply?.parts.find((p: { type: string }) => p.type === 'source')).toBeDefined();

    const second = await ask(alpha, QUESTION);
    expect(second.modelCalls).toBe(0);
    expect(second.cacheStep?.detail).toMatchObject({ outcome: 'hit' });
    expect(second.run).toMatchObject({ provider: 'cache', outcome: 'replied' });
    const text = (m: Record<string, any> | undefined) =>
      m?.parts.find((p: { type: string }) => p.type === 'text')?.text;
    expect(text(second.reply)).toBe(text(first.reply));
    // The cited source is shown with the cached answer too.
    expect(second.reply?.parts.filter((p: { type: string }) => p.type === 'source')).toEqual(
      first.reply?.parts.filter((p: { type: string }) => p.type === 'source'),
    );

    const [entry] = await entries(alpha);
    expect(entry).toMatchObject({
      tier: 'exact_answer',
      language: 'en',
      audience: 'public',
      hits: 1,
    });
    expect(entry?.sources).toEqual([
      expect.objectContaining({
        documentId: alpha.documentId,
        sourceId: alpha.sourceId,
        version: 1,
      }),
    ]);
    // The index keeps fingerprints and references, never the question or the answer.
    const listed = JSON.stringify(await entries(alpha));
    expect(listed).not.toContain('contact form');
    expect(listed).not.toContain('How can I');
  });

  it('never serves a hit across tenants or brands', async () => {
    const sameTenantOtherBrand = await ask(alphaSecond, QUESTION);
    expect(sameTenantOtherBrand.modelCalls).toBe(1);
    expect(sameTenantOtherBrand.cacheStep?.detail).toMatchObject({ outcome: 'miss' });
    const otherTenant = await ask(beta, QUESTION);
    expect(otherTenant.modelCalls).toBe(1);
    expect(otherTenant.cacheStep?.detail).toMatchObject({ outcome: 'miss' });
    // Identical questions and settings still give different keys: tenant and brand are part of
    // the key, and the question's digest is keyed per tenant.
    const fingerprints = [
      ...(await entries(alpha)),
      ...(await entries(alphaSecond)),
      ...(await entries(beta)),
    ].map((e) => e.fingerprint);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
    const keys = await valkey.keys(`${slice.gw.config.CACHE_KEY_PREFIX}*:exact_answer:*`);
    for (const brand of [alpha, alphaSecond, beta]) {
      const prefix = `${slice.gw.config.CACHE_KEY_PREFIX}t:${fromPublicId('tenant', brand.tenantId)}:b:${fromPublicId('brand', brand.brandId)}:exact_answer:`;
      expect(keys.filter((k) => k.startsWith(prefix))).toHaveLength(1);
    }
    // Tenant A cannot see tenant B's entries.
    const foreign = await alpha.owner.get(`/v1/admin/brands/${beta.brandId}/cache/entries`);
    expect(foreign.status).toBe(404);
  });

  it('never caches questions with personal data, later turns or excluded requests', async () => {
    const stored = (await entries(alpha)).length;
    const personal = `${QUESTION} My order is NL-1048.`;
    for (let i = 0; i < 2; i += 1) {
      const asked = await ask(alpha, personal);
      expect(asked.modelCalls).toBe(1);
      expect(asked.cacheStep?.detail).toMatchObject({ outcome: 'bypass', reason: 'personal_data' });
    }
    // A follow-up in the same conversation depends on the conversation: never shared, even when
    // the same words open other conversations from the cache.
    const opened = await ask(alpha, QUESTION);
    expect(opened.modelCalls).toBe(0);
    for (let i = 0; i < 2; i += 1) {
      const followUp = await opened.visitor.call(
        'POST',
        `/v1/widget/conversations/${opened.conversationId}/messages`,
        {
          clientMessageId: randomUUID(),
          parts: [{ type: 'text', text: 'What are your opening hours?' }],
        },
      );
      expect(followUp.status).toBe(202);
      const before = counted.state.calls;
      await slice.drain();
      expect(counted.state.calls - before).toBe(1);
    }
    const runs = await alpha.owner.get(`/v1/admin/runs?conversationId=${opened.conversationId}`);
    expect(runs.body.items).toHaveLength(3);
    for (const listed of runs.body.items as Array<{ id: string }>) {
      const run = await alpha.owner.get(`/v1/admin/runs/${listed.id}`);
      const step = (run.body.steps as Array<Record<string, any>>).find(
        (s) => s.name === 'answer_cache',
      );
      expect(['hit', 'bypass']).toContain(step?.detail.outcome);
      if (step?.detail.outcome === 'bypass') expect(step.detail.reason).toBe('personalized');
    }
    // The commerce hook: an exclusion rule another module registers (K06).
    for (const context of [slice.worker, slice.gw.app]) {
      context.get(CacheExclusions).register({
        id: 'commerce.test_live_orders',
        check: (request) =>
          request.texts?.some((t) => /shipping status/i.test(t)) ? 'live_order_state' : null,
      });
    }
    for (let i = 0; i < 2; i += 1) {
      const excluded = await ask(alpha, 'What is the shipping status right now?');
      expect(excluded.modelCalls).toBe(1);
      expect(excluded.cacheStep?.detail).toMatchObject({
        outcome: 'bypass',
        reason: 'excluded_by_rule',
      });
    }
    // Nothing of these was stored.
    expect(await entries(alpha)).toHaveLength(stored);
  });

  it('keeps each reply language apart', async () => {
    const urdu = await ask(alpha, 'میں ٹیم سے کیسے رابطہ کروں؟');
    expect(urdu.modelCalls).toBe(1);
    expect((await entries(alpha)).map((e) => e.language).sort()).toEqual(['en', 'ur']);
  });
});

describe('versioned invalidation (K07)', () => {
  it('stops reuse when the knowledge behind an answer changes', async () => {
    const impact = await alpha.owner.get(
      `/v1/admin/brands/${alpha.brandId}/cache/impact?sourceId=${alpha.sourceId}`,
    );
    expect(impact.body).toMatchObject({ sourceId: alpha.sourceId, entries: 2 });
    const updated = await alpha.owner.post(
      `/v1/admin/knowledge/documents/${alpha.documentId}/versions`,
      {
        content: {
          mediaType: 'text/markdown',
          text: '# Contact\n\nYou can contact our team by phone or through the contact form.',
        },
      },
    );
    expect(updated.status, JSON.stringify(updated.body)).toBe(202);
    await slice.drain();
    // The inspector says why the old answer is not reused (HNV-25-05, board 25 stale state).
    const inspected = await alpha.owner.post(`/v1/admin/brands/${alpha.brandId}/cache/inspect`, {
      question: QUESTION,
    });
    expect(inspected.body).toMatchObject({ status: 'stale', reason: 'dependency_changed' });
    const asked = await ask(alpha, QUESTION);
    expect(asked.modelCalls).toBe(1);
    expect(asked.cacheStep?.detail).toMatchObject({ outcome: 'stale' });
    const all = await entries(alpha);
    const retired = all.filter((e) => e.invalidatedAt !== null);
    expect(retired.length).toBeGreaterThanOrEqual(1);
    expect(retired[0]).toMatchObject({ invalidationReason: 'dependency_changed', stale: true });
    // The fresh answer cites the new version and is reused from now on.
    const fresh = all.find((e) => e.invalidatedAt === null && e.language === 'en');
    expect(fresh?.sources[0]).toMatchObject({ version: 2 });
    expect((await ask(alpha, QUESTION)).modelCalls).toBe(0);
  });

  it('invalidates a source on request, and reads stop at once', async () => {
    const invalidated = await alpha.owner.post(
      `/v1/admin/brands/${alpha.brandId}/cache/invalidate`,
      {
        sourceId: alpha.sourceId,
        reason: 'Disputed answer',
      },
    );
    expect(invalidated.status, JSON.stringify(invalidated.body)).toBe(200);
    expect(invalidated.body.invalidated).toBeGreaterThanOrEqual(1);
    expect(invalidated.body.failed).toBe(0);
    expect((await ask(alpha, QUESTION)).modelCalls).toBe(1);
    const audit = await alpha.owner.get('/v1/admin/audit?action=cache.invalidated');
    expect(audit.body.items[0].data).toMatchObject({
      reason: 'Disputed answer',
      source: alpha.sourceId,
    });
  });

  it('stops reuse when the policy changes or the agent is republished', async () => {
    expect((await ask(alpha, QUESTION)).modelCalls).toBe(0);
    const policy = await alpha.owner.put(`/v1/admin/brands/${alpha.brandId}/cache/policy`, {
      tiers: { exact_answer: { enabled: true, ttlSeconds: 1800 } },
    });
    expect(policy.body.version).toBeGreaterThan(1);
    expect((await ask(alpha, QUESTION)).modelCalls).toBe(1);
    expect((await ask(alpha, QUESTION)).modelCalls).toBe(0);
    const detail = await alpha.owner.get(`/v1/admin/agents/${alpha.agentId}`);
    const live = detail.body.published.version as number;
    expect(live).toBeGreaterThan(1);
    const rolledBack = await alpha.owner.post(`/v1/admin/agents/${alpha.agentId}/publish`, {
      version: 1,
    });
    expect(rolledBack.status, JSON.stringify(rolledBack.body)).toBe(200);
    expect((await ask(alpha, QUESTION)).modelCalls).toBe(1);
    // Rolling forward again does not bring back answers stored before the rollback.
    const restored = await alpha.owner.post(`/v1/admin/agents/${alpha.agentId}/publish`, {
      version: live,
    });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect((await ask(alpha, QUESTION)).modelCalls).toBe(1);
  });
});

describe('inspection and metrics (board 25, K10)', () => {
  it('shows a hit with its provenance, and a bypass without storing anything', async () => {
    await ask(alpha, QUESTION);
    const hit = await alpha.owner.post(`/v1/admin/brands/${alpha.brandId}/cache/inspect`, {
      question: QUESTION,
    });
    expect(hit.body).toMatchObject({
      tier: 'exact_answer',
      status: 'hit',
      language: 'en',
      preview: expect.stringContaining('contact form'),
      knowledge: [{ sourceId: alpha.sourceId, version: expect.any(Number) }],
    });
    const bypass = await alpha.owner.post(`/v1/admin/brands/${alpha.brandId}/cache/inspect`, {
      question: 'Has order NL-1048 shipped?',
    });
    expect(bypass.body).toMatchObject({ status: 'bypass', reason: 'personal_data', preview: null });
  });

  it('counts hits, misses and bypasses per language, with no content', async () => {
    const metrics = await alpha.owner.get(`/v1/admin/brands/${alpha.brandId}/cache/metrics?days=1`);
    expect(metrics.status).toBe(200);
    const english = metrics.body.rows.find(
      (r: Record<string, any>) => r.tier === 'exact_answer' && r.language === 'en',
    );
    expect(english.hits).toBeGreaterThanOrEqual(3);
    expect(english.misses).toBeGreaterThanOrEqual(3);
    expect(english.bypasses).toBeGreaterThanOrEqual(3);
    expect(english.stale).toBeGreaterThanOrEqual(1);
    expect(english.stores).toBeGreaterThanOrEqual(2);
    expect(metrics.body.health).toEqual({ store: 'up', recentFailures: 0 });
  });

  it('caches query embeddings for knowledge search (K02)', async () => {
    const search = () =>
      alpha.owner.post('/v1/admin/knowledge/search', {
        query: 'contact form',
        brandId: alpha.brandId,
        audience: 'customer',
      });
    expect((await search()).status).toBe(200);
    expect((await search()).status).toBe(200);
    const metrics = await alpha.owner.get(`/v1/admin/brands/${alpha.brandId}/cache/metrics?days=1`);
    const embedding = metrics.body.rows.find((r: Record<string, any>) => r.tier === 'embedding');
    expect(embedding.hits).toBeGreaterThanOrEqual(1);
    expect(embedding.stores).toBeGreaterThanOrEqual(1);
  });

  it('records every policy change as a new version', async () => {
    const [control] = await withTenant(
      slice.app,
      { tenantId: fromPublicId('tenant', alpha.tenantId) },
      (tx) =>
        tx
          .select()
          .from(schema.cachePolicies)
          .where(eq(schema.cachePolicies.brandId, fromPublicId('brand', alpha.brandId))),
    );
    expect(control?.version).toBeGreaterThan(1);
  });
});

describe('cache outage (K08)', () => {
  it('answers without the cache when the store does not respond', async () => {
    const hanging: CacheStore = {
      kind: 'valkey',
      get: () => new Promise(() => undefined),
      set: () => new Promise(() => undefined),
      setIfAbsent: () => new Promise(() => undefined),
      delete: () => new Promise(() => undefined),
    };
    const down = await startSlice({ model: counted.model, cacheStore: hanging });
    try {
      const other = slice;
      slice = down;
      const t = await connectedTenant(down, 'cachedown');
      const brand = await withKnowledge(t, t.brand, t.agentId, t.hostOrigin);
      const started = Date.now();
      const first = await ask(brand, QUESTION);
      const second = await ask(brand, QUESTION);
      slice = other;
      expect(first.modelCalls).toBe(1);
      expect(second.modelCalls).toBe(1);
      expect(first.reply).toBeDefined();
      expect(second.reply).toBeDefined();
      expect(first.cacheStep?.detail).toMatchObject({ outcome: 'unavailable' });
      expect(second.cacheStep?.detail).toMatchObject({ outcome: 'unavailable' });
      expect(Date.now() - started).toBeLessThan(20_000);
      // Studio shows the outage: the counters kept by the worker, and a live probe of the store.
      const metrics = await brand.owner.get(
        `/v1/admin/brands/${brand.brandId}/cache/metrics?days=1`,
      );
      expect(metrics.status).toBe(200);
      const english = metrics.body.rows.find(
        (r: Record<string, any>) => r.tier === 'exact_answer' && r.language === 'en',
      );
      expect(english).toMatchObject({ errors: 2, hits: 0, stores: 0 });
      expect(metrics.body.health.store).toBe('degraded');
      expect(metrics.body.health.recentFailures).toBeGreaterThanOrEqual(1);
      // Nothing was indexed while the store was down.
      expect(await entries(brand)).toHaveLength(0);
    } finally {
      await down.close();
    }
  });
});
