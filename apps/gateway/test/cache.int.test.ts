import { randomUUID } from 'node:crypto';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { CacheStore } from '@hamnivo/adapters/cache';
import { createMockModel } from '@hamnivo/adapters/models';
import { MEMORY_NOTICE_VERSION } from '@hamnivo/contracts';
import { fromPublicId, schema, toPublicId, withTenant } from '@hamnivo/db';
import { MEMORY_EXTRACTION_MARKER } from '@hamnivo/domain';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnswerCache, type AnswerContext, type CachedAnswer } from '../src/cache/answers.js';
import { CacheService, type CacheSpec } from '../src/cache/cache.service.js';
import { CacheExclusions } from '../src/cache/store.js';
import { MemoryCache } from '../src/memory/cache.js';
import { contentHashOf } from '../src/memory/writer.service.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/** The mock model, counting the calls that actually reach it. */
function countingModel() {
  const base = createMockModel();
  const state = { calls: 0 };
  const model: LanguageModelV4 = {
    ...base,
    async doGenerate(call) {
      const result = await base.doGenerate(call);
      // Memory extraction for customers who agreed to memory is not a reply: the mock answers it.
      if (JSON.stringify(call.prompt).includes(MEMORY_EXTRACTION_MARKER)) return result;
      state.calls += 1;
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

/** Tenants whose memory keys (namespaces and versions) this file removes afterwards. */
const tenants = new Set<string>();

async function withKnowledge(
  tenant: Tenant,
  brand: { id: string; widgetId: string },
  agentId: string,
  hostOrigin: string,
  options: { memory?: boolean } = {},
): Promise<Brand> {
  tenants.add(fromPublicId('tenant', tenant.tenantId));
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
      ...(options.memory ? { memory: { ...config.memory, enabled: true } } : {}),
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
  // Entries private to one customer are placed by customer memory, as in production.
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
  for (const tenantId of tenants) {
    const keys = [
      ...((await valkey?.keys(`hamnivo:memory:c:${tenantId}:*`)) ?? []),
      ...((await valkey?.keys(`hamnivo:memory:v:${tenantId}:*`)) ?? []),
    ];
    if (keys.length > 0) await valkey.del(...keys);
  }
  valkey?.disconnect();
  await slice?.close();
});

/** Opens a conversation with `text` (as a new visitor unless one is given) and lets it finish. */
async function ask(brand: Brand, text: string, existing?: Visitor) {
  const visitor = existing ?? new Visitor(slice.baseUrl, brand.widgetId, brand.hostOrigin);
  if (!existing) await visitor.open();
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
    memoryStep: (run.body.steps as Array<Record<string, any>>).find(
      (s) => s.kind === 'retrieval' && s.name === 'memory',
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

describe('memory hooks: personal context and entries private to one customer', () => {
  const answer: CachedAnswer = {
    text: 'Your usual order was the blue notebook.',
    sources: [],
    refs: [],
    provider: 'mock',
    modelId: 'mock-1',
    inputTokens: 10,
    outputTokens: 8,
    latencyMs: 5,
  };
  const ids = () => ({
    tenantId: fromPublicId('tenant', alpha.tenantId),
    brandId: fromPublicId('brand', alpha.brandId),
  });
  const spec = (over: Partial<CacheSpec> = {}): CacheSpec => ({
    tier: 'exact_answer',
    ...ids(),
    audience: 'public',
    language: 'en',
    model: 'mock/mock-1',
    promptVersion: 'memory-hook-test',
    dependencies: [],
    input: 'What did I order last time?',
    request: {
      tier: 'exact_answer',
      dataClasses: ['general'],
      texts: ['What did I order last time?'],
      complete: true,
    },
    ...over,
  });
  /** An entry for one customer, as a reply built with their memory asks for it. */
  const privateSpec = (subjectId: string, over: Partial<CacheSpec> = {}): CacheSpec => {
    const base = spec(over);
    return {
      ...base,
      audience: 'customer',
      subjectId,
      request: { ...base.request, personalized: true, personalContext: ['personal_memory'] },
    };
  };

  it('keeps a reply built with personal context, such as memory, out of the shared cache', async () => {
    const cache = slice.worker.get(CacheService);
    const vetoed = await cache.lookup(
      spec({ request: { ...spec().request, personalContext: ['personal_memory'] } }),
    );
    expect(vetoed).toMatchObject({
      status: 'bypass',
      reason: 'personal_context',
      detail: 'personal_memory',
    });

    // Memory recalled after the lookup is passed when the answer is filled: nothing is stored.
    const answers = slice.worker.get(AnswerCache);
    const context: AnswerContext = {
      ...ids(),
      agentId: fromPublicId('agent', alpha.agentId),
      agentVersionId: randomUUID(),
      config: {
        model: { provider: 'mock', modelId: 'mock-1' },
        knowledgeSourceIds: [],
        mode: 'answer',
      } as unknown as AnswerContext['config'],
      promptVersion: `memory-hook-${randomUUID()}`,
      language: 'en',
      history: [
        {
          ref: '1',
          conversationRef: '1',
          key: null,
          direction: 'incoming',
          private: false,
          text: 'What are your opening hours?',
          contentAttributes: {},
          sender: { kind: 'contact', ref: '1', name: null },
          attachments: [],
          createdAt: new Date(),
        },
      ],
      question: 'What are your opening hours?',
    };
    const first = await answers.lookup(context);
    if (first.kind !== 'fill') throw new Error(`expected a fill, got ${first.kind}`);
    await first.fill(answer, { personalContext: ['personal_memory'] });
    const again = await answers.lookup(context);
    if (again.kind !== 'fill') throw new Error(`expected nothing stored, got ${again.kind}`);
    // The same answer without personal context is stored: the veto above is what kept it out.
    await again.fill(answer);
    expect(await answers.lookup(context)).toMatchObject({ kind: 'hit', scope: 'shared' });
    expect((await answers.lookup({ ...context, personalContext: ['personal_memory'] })).kind).toBe(
      'skip',
    );

    // With the customer known, a reply built with their memory is kept for them alone.
    const customer = { ...context, personalContext: ['personal_memory'], subjectId: randomUUID() };
    const own = await answers.lookup(customer);
    expect(own).toMatchObject({ kind: 'fill', scope: 'customer' });
    if (own.kind !== 'fill') throw new Error(`expected a fill, got ${own.kind}`);
    await own.fill(answer, { personalContext: ['personal_memory'] });
    expect(await answers.lookup(customer)).toMatchObject({ kind: 'hit', scope: 'customer' });
    expect(await answers.lookup(context)).toMatchObject({ kind: 'hit', scope: 'shared' });
  });

  it('keeps entries private to one customer in their memory namespace, under their memory version', async () => {
    const cache = slice.worker.get(CacheService);
    const memory = slice.worker.get(MemoryCache);
    const { tenantId } = ids();
    const indexed = (await entries(alpha)).length;
    const customer = randomUUID();
    const mine = privateSpec(customer);
    const namespace = memory.namespace(tenantId, customer);

    const first = await cache.lookup<CachedAnswer>(mine);
    if (first.status !== 'miss') throw new Error(`expected a miss, got ${first.status}`);
    expect(first.customer).toEqual({
      prefix: namespace,
      version: String(await memory.version(tenantId, customer)),
    });
    expect(await cache.put(mine, first, answer)).toBe(true);
    // Stored in the customer's memory namespace, never under the shared prefix.
    expect(await valkey.keys(`${namespace}*`)).toEqual([
      `${namespace}cache:exact_answer:${first.key.fingerprint}`,
    ]);
    expect(
      await valkey.keys(`${slice.gw.config.CACHE_KEY_PREFIX}*${first.key.fingerprint}`),
    ).toEqual([]);
    expect(await cache.lookup<CachedAnswer>(mine)).toMatchObject({ status: 'hit', value: answer });
    // Another customer never sees it.
    expect(await cache.lookup(privateSpec(randomUUID()))).toMatchObject({ status: 'miss' });

    // A memory change bumps the customer's version: the entry is no longer reachable.
    await memory.bump(tenantId, customer);
    const changed = await cache.lookup<CachedAnswer>(mine);
    if (changed.status !== 'miss') throw new Error(`expected a miss, got ${changed.status}`);
    expect(changed.key.fingerprint).not.toBe(first.key.fingerprint);
    expect(await cache.put(mine, changed, answer)).toBe(true);
    expect(await cache.lookup(mine)).toMatchObject({ status: 'hit' });

    // A deletion purges the namespace (and bumps the version): nothing of theirs is left.
    expect(await memory.purge(tenantId, customer)).toBe(2);
    expect(await valkey.keys(`${namespace}*`)).toEqual([]);
    expect(await cache.lookup(mine)).toMatchObject({ status: 'miss' });
    // Private entries never appear in the shared index.
    expect(await entries(alpha)).toHaveLength(indexed);
  });

  it('stores nothing when the lookup and the store disagree about whose entry it is', async () => {
    const cache = slice.worker.get(CacheService);
    const input = `Which size did I order? ${randomUUID()}`;
    const shared = spec({ input });
    const mine = privateSpec(randomUUID(), { input });
    // Found missing as a shared entry, then offered as a private one: kept out of both.
    const sharedMiss = await cache.lookup<CachedAnswer>(shared);
    if (sharedMiss.status !== 'miss') throw new Error(`expected a miss, got ${sharedMiss.status}`);
    expect(await cache.put(mine, sharedMiss, answer)).toBe(false);
    // Found missing for the customer, then offered as a shared one: kept out of both.
    const privateMiss = await cache.lookup<CachedAnswer>(mine);
    if (privateMiss.status !== 'miss') {
      throw new Error(`expected a miss, got ${privateMiss.status}`);
    }
    expect(await cache.put(shared, privateMiss, answer)).toBe(false);
    expect(await cache.lookup(shared)).toMatchObject({ status: 'miss' });
    expect(await cache.lookup(mine)).toMatchObject({ status: 'miss' });
  });

  it('never caches per customer without a namespace that is theirs, answered in time', async () => {
    const intruder = randomUUID();
    const slow = randomUUID();
    const broken = await startSlice({
      model: counted.model,
      personalCacheScope: {
        async scope(_tenantId, subjectId) {
          // Another tenant's namespace, a provider that never answers, or no namespace at all.
          if (subjectId === intruder) {
            return { prefix: `hamnivo:memory:c:${randomUUID()}:${subjectId}:`, version: '1' };
          }
          if (subjectId === slow) return new Promise(() => undefined);
          return null;
        },
      },
    });
    const off = await startSlice({ model: counted.model, personalCacheScope: null });
    try {
      const cases: Array<[Slice, string[]]> = [
        [broken, [randomUUID(), intruder, slow]],
        [off, [randomUUID()]],
      ];
      for (const [running, subjects] of cases) {
        const cache = running.worker.get(CacheService);
        const t = await connectedTenant(running, 'cachenoscope');
        const policy = await t.owner.put(`/v1/admin/brands/${t.brand.id}/cache/policy`, {
          tiers: { exact_answer: { enabled: true, ttlSeconds: 3600 } },
        });
        expect(policy.status).toBe(200);
        for (const subjectId of subjects) {
          const started = Date.now();
          const found = await cache.lookup(
            privateSpec(subjectId, {
              tenantId: fromPublicId('tenant', t.tenantId),
              brandId: fromPublicId('brand', t.brand.id),
            }),
          );
          expect(found).toMatchObject({ status: 'bypass', reason: 'no_customer_scope' });
          expect(Date.now() - started).toBeLessThan(running.gw.config.CACHE_TIMEOUT_MS + 1000);
        }
      }
    } finally {
      await broken.close();
      await off.close();
    }
  });
});

describe('memory hooks in replies: customer memory stays with the customer (K09, G19)', () => {
  const ASKED = 'How do I reach your team?';
  let shop: Brand;
  let workspaceId: string;

  beforeAll(async () => {
    const t = await connectedTenant(slice, 'cachememory');
    workspaceId = t.workspaceId;
    shop = await withKnowledge(t, t.brand, t.agentId, t.hostOrigin, { memory: true });
  });

  /** A customer who agreed to memory, with one remembered preference. */
  async function rememberingCustomer() {
    const visitor = new Visitor(slice.baseUrl, shop.widgetId, shop.hostOrigin);
    await visitor.open();
    const consent = await visitor.call('POST', '/v1/widget/memory/consent', {
      state: 'granted',
      noticeVersion: MEMORY_NOTICE_VERSION,
    });
    expect(consent.status, JSON.stringify(consent.body)).toBe(200);
    const tenantId = fromPublicId('tenant', shop.tenantId);
    const subjectId = fromPublicId('customer', visitor.principalId);
    const at = new Date(Date.now() - 60_000);
    const [row] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .insert(schema.memoryRecords)
        .values({
          tenantId,
          workspaceId: fromPublicId('workspace', workspaceId),
          brandId: fromPublicId('brand', shop.brandId),
          subjectId,
          scope: 'person',
          kind: 'preference',
          key: 'contact_method',
          payload: { value: 'Email' },
          contentHash: contentHashOf('preference', 'contact_method', 'Email'),
          sourceType: 'customer_statement',
          evidenceStatus: 'supported',
          writtenByType: 'ai',
          writeReason: 'extracted_from_message',
          purpose: 'test',
          allowedPurposes: ['ai_replies', 'staff_context'],
          allowedRoles: ['customer', 'staff', 'ai'],
          sensitivity: 'normal',
          retentionClass: 'long',
          policyVersion: 'memory-write/1',
          status: 'active',
          reviewStatus: 'auto',
          observedAt: at,
          validFrom: at,
        })
        .returning(),
    );
    if (!row) throw new Error('no memory record');
    const memory = slice.worker.get(MemoryCache);
    return {
      visitor,
      memoryId: toPublicId('memory', row.id),
      namespace: memory.namespace(tenantId, subjectId),
      version: () => memory.version(tenantId, subjectId),
    };
  }

  const privateKeys = (namespace: string) => valkey.keys(`${namespace}cache:*`);

  it('a reply built with memory never enters a shared entry, only the customer’s own', async () => {
    const sara = await rememberingCustomer();
    const first = await ask(shop, ASKED, sara.visitor);
    expect(first.modelCalls).toBe(1);
    expect(first.memoryStep).toMatchObject({
      status: 'ok',
      detail: { items: 1, sharedCache: { eligible: false, reason: 'personal_memory' } },
    });
    expect(first.cacheStep?.detail).toMatchObject({ outcome: 'miss', scope: 'customer' });
    // Kept in the customer's memory namespace only: nothing shared, nothing indexed.
    expect(await privateKeys(sara.namespace)).toHaveLength(1);
    expect(await entries(shop)).toEqual([]);

    // The same customer asking again gets their own entry.
    const again = await ask(shop, ASKED, sara.visitor);
    expect(again.modelCalls).toBe(0);
    expect(again.cacheStep).toMatchObject({
      status: 'ok',
      detail: { outcome: 'hit', scope: 'customer' },
    });
    expect(again.run).toMatchObject({ provider: 'cache', outcome: 'replied' });

    // Another customer asking the same question never gets it: theirs is a shared entry.
    const other = await ask(shop, ASKED);
    expect(other.modelCalls).toBe(1);
    expect(other.memoryStep).toMatchObject({ status: 'skipped' });
    expect(other.cacheStep?.detail).toMatchObject({ outcome: 'miss', scope: 'shared' });
    expect(await entries(shop)).toHaveLength(1);
    // The customer with memory still gets their own entry, not the shared one.
    const mine = await ask(shop, ASKED, sara.visitor);
    expect(mine.cacheStep?.detail).toMatchObject({ outcome: 'hit', scope: 'customer' });
    expect(await entries(shop)).toHaveLength(1);
  });

  it('a memory change makes the customer’s entries unreachable, and a deletion removes them', async () => {
    const ali = await rememberingCustomer();
    expect((await ask(shop, ASKED, ali.visitor)).cacheStep?.detail).toMatchObject({
      outcome: 'miss',
      scope: 'customer',
    });
    expect((await ask(shop, ASKED, ali.visitor)).cacheStep?.detail).toMatchObject({
      outcome: 'hit',
      scope: 'customer',
    });

    // The customer corrects what was remembered: their memory version moves on.
    const version = await ali.version();
    const corrected = await ali.visitor.call('POST', `/v1/widget/memory/${ali.memoryId}/correct`, {
      value: 'WhatsApp',
    });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
    expect(await ali.version()).toBeGreaterThan(version);
    const changed = await ask(shop, ASKED, ali.visitor);
    expect(changed.modelCalls).toBe(1);
    expect(changed.cacheStep?.detail).toMatchObject({ outcome: 'miss', scope: 'customer' });
    expect(await privateKeys(ali.namespace)).toHaveLength(2);

    // Deleting the memory purges the namespace once the deletion has run.
    const current = corrected.body.memory.id as string;
    const deleted = await ali.visitor.call('POST', `/v1/widget/memory/${current}/delete`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(202);
    await slice.drain();
    const receipt = await ali.visitor.call('GET', `/v1/widget/memory/deletions/${deleted.body.id}`);
    expect(receipt.body.status).toBe('completed');
    expect(await valkey.keys(`${ali.namespace}*`)).toEqual([]);
    // With nothing remembered, the question is answered like anyone else's.
    const after = await ask(shop, ASKED, ali.visitor);
    expect(after.memoryStep).toMatchObject({ status: 'ok', detail: { items: 0 } });
    expect(after.cacheStep?.detail).toMatchObject({ scope: 'shared' });
    expect(await privateKeys(ali.namespace)).toEqual([]);
  });
});

describe('commerce data never enters or leaves the answer cache (K06)', () => {
  const answer: CachedAnswer = {
    text: 'Your order is on its way.',
    sources: [],
    refs: [],
    provider: 'mock',
    modelId: 'mock-1',
    inputTokens: 10,
    outputTokens: 8,
    latencyMs: 5,
  };

  it('bypasses a conversation with commerce data and stores nothing a receipt check read', async () => {
    const answers = slice.worker.get(AnswerCache);
    const question = 'When will it arrive?';
    const context: AnswerContext = {
      tenantId: fromPublicId('tenant', alpha.tenantId),
      brandId: fromPublicId('brand', alpha.brandId),
      agentId: fromPublicId('agent', alpha.agentId),
      agentVersionId: randomUUID(),
      config: {
        model: { provider: 'mock', modelId: 'mock-1' },
        knowledgeSourceIds: [],
        mode: 'answer',
      } as unknown as AnswerContext['config'],
      promptVersion: `commerce-${randomUUID()}`,
      language: 'en',
      history: [
        {
          ref: '1',
          conversationRef: '1',
          key: null,
          direction: 'incoming',
          private: false,
          text: question,
          contentAttributes: {},
          sender: { kind: 'contact', ref: '1', name: null },
          attachments: [],
          createdAt: new Date(),
        },
      ],
      question,
    };
    // A conversation that holds an order: the cache is neither read nor written (commerce's rule).
    expect(await answers.lookup({ ...context, dataClasses: ['commerce.order_status'] })).toEqual({
      kind: 'skip',
      status: 'bypass',
      reason: 'excluded_by_rule',
      rule: 'commerce.live_data',
      detail: 'commerce.order_status',
    });
    // A reply whose receipt check read the payment status is not stored.
    const first = await answers.lookup(context);
    if (first.kind !== 'fill') throw new Error(`expected a fill, got ${first.kind}`);
    await first.fill(answer, { dataClasses: ['commerce.payment_status'] });
    const again = await answers.lookup(context);
    if (again.kind !== 'fill') throw new Error(`expected nothing stored, got ${again.kind}`);
    // The same answer without commerce data is stored: the rule is what kept it out.
    await again.fill(answer);
    expect(await answers.lookup(context)).toMatchObject({ kind: 'hit', scope: 'shared' });
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
