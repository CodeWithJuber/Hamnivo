import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type CacheExclusionRule,
  type CacheKeyEnvelope,
  type CachePolicy,
  type CacheRequest,
  cacheDependency,
  cacheEligibility,
  cacheInputText,
  cacheKey,
  cacheKeyMaterial,
  DEFAULT_CACHE_POLICY,
  envelopeProblem,
} from '../src/index.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const base: CacheKeyEnvelope = {
  tier: 'exact_answer',
  tenantId: 'tenant-a',
  brandId: 'brand-a',
  audience: 'public',
  language: 'en',
  model: 'openai/gpt-5.4-mini',
  promptVersion: 'agent-version-7:prompt-v3',
  dependencies: {
    [cacheDependency.knowledgeSource('src-1')]: 12,
    [cacheDependency.agent('agent-1')]: 3,
    [cacheDependency.cachePolicy('brand-a', 'exact_answer')]: 1,
  },
  inputDigest: sha256('how can i contact the team?'),
};

describe('cacheKey (K01)', () => {
  it('is the same for the same envelope, whatever the dependency order', () => {
    const reordered: CacheKeyEnvelope = {
      ...base,
      dependencies: Object.fromEntries(Object.entries(base.dependencies).reverse()),
    };
    expect(cacheKey(reordered, sha256)).toEqual(cacheKey(base, sha256));
  });

  it.each([
    ['another tenant', { tenantId: 'tenant-b' }],
    ['another brand', { brandId: 'brand-b' }],
    ['staff instead of public', { audience: 'staff' as const }],
    ['another language', { language: 'ur-Latn' }],
    ['another model', { model: 'anthropic/claude-haiku-4-5' }],
    ['another prompt version', { promptVersion: 'agent-version-8:prompt-v3' }],
    ['another tier', { tier: 'translation' as const }],
    ['another input', { inputDigest: sha256('how can i reach the team?') }],
    [
      'a newer knowledge version',
      {
        dependencies: { ...base.dependencies, [cacheDependency.knowledgeSource('src-1')]: 13 },
      },
    ],
    [
      'one more dependency',
      { dependencies: { ...base.dependencies, [cacheDependency.brand('brand-a')]: 0 } },
    ],
  ])('changes with %s', (_, change) => {
    const other = cacheKey({ ...base, ...change }, sha256);
    expect(other.fingerprint).not.toBe(cacheKey(base, sha256).fingerprint);
    expect(other.key).not.toBe(cacheKey(base, sha256).key);
  });

  it('scopes the stored key to tenant and brand and holds no input text', () => {
    const { key, fingerprint } = cacheKey(base, sha256);
    expect(key).toBe(`t:tenant-a:b:brand-a:exact_answer:${fingerprint}`);
    expect(cacheKeyMaterial(base)).not.toContain('contact');
  });

  it('keeps customer entries under the customer, versioned by their personal data', () => {
    const mine: CacheKeyEnvelope = {
      ...base,
      audience: 'customer',
      subject: { id: 'customer-1', version: '7' },
    };
    const { key, fingerprint } = cacheKey(mine, sha256);
    expect(key).toBe(`t:tenant-a:b:brand-a:c:customer-1:exact_answer:${fingerprint}`);
    expect(fingerprint).not.toBe(cacheKey(base, sha256).fingerprint);
    // A memory change (new version) or another customer gives another key.
    for (const subject of [
      { id: 'customer-1', version: '8' },
      { id: 'customer-2', version: '7' },
    ]) {
      expect(cacheKey({ ...mine, subject }, sha256).fingerprint).not.toBe(fingerprint);
    }
    expect(() => cacheKey({ ...mine, subject: undefined }, sha256)).toThrow(/customer/);
    expect(() => cacheKey({ ...base, subject: { id: 'c', version: '1' } }, sha256)).toThrow(
      /only customer entries/,
    );
  });

  it('refuses incomplete envelopes', () => {
    expect(envelopeProblem(base)).toBeUndefined();
    expect(() => cacheKey({ ...base, tenantId: '' }, sha256)).toThrow(/tenantId/);
    expect(() => cacheKey({ ...base, brandId: '' }, sha256)).toThrow(/brandId/);
    expect(() => cacheKey({ ...base, inputDigest: 'how can I contact' }, sha256)).toThrow(
      /hex digest/,
    );
    expect(() => cacheKey({ ...base, dependencies: { 'Knowledge Source': 1 } }, sha256)).toThrow(
      /not a valid name/,
    );
    expect(() => cacheKey({ ...base, dependencies: { 'agent:a': 1.5 } }, sha256)).toThrow(
      /whole version/,
    );
    expect(() => cacheKey({ ...base, promptVersion: '' }, sha256)).toThrow(/promptVersion/);
  });
});

const enabled: CachePolicy = {
  ...DEFAULT_CACHE_POLICY,
  tiers: {
    ...DEFAULT_CACHE_POLICY.tiers,
    exact_answer: { enabled: true, ttlSeconds: 3600 },
  },
};
const faq: CacheRequest = {
  tier: 'exact_answer',
  dataClasses: ['general', 'public_knowledge'],
  texts: ['How can I contact the team?'],
};

describe('cacheEligibility (K01, K06)', () => {
  it('admits a public question under an enabled tier', () => {
    expect(cacheEligibility(faq, enabled)).toEqual({ eligible: true });
  });

  it('bypasses a disabled tier (answers are off by default)', () => {
    expect(cacheEligibility(faq, DEFAULT_CACHE_POLICY)).toMatchObject({
      eligible: false,
      reason: 'tier_disabled',
    });
  });

  it.each([
    'personal',
    'identity',
    'account',
    'memory',
    'live_order',
    'payment',
    'approval',
    'tool_result',
  ] as const)('never caches %s data', (dataClass) => {
    expect(
      cacheEligibility({ ...faq, dataClasses: ['public_knowledge', dataClass] }, enabled),
    ).toMatchObject({ eligible: false, reason: 'excluded_class', detail: dataClass });
  });

  it('applies the brand’s own excluded classes', () => {
    const policy = { ...enabled, excludedClasses: ['internal_knowledge' as const] };
    expect(cacheEligibility({ ...faq, dataClasses: ['internal_knowledge'] }, policy)).toMatchObject(
      { eligible: false, reason: 'excluded_class' },
    );
  });

  it('bypasses personalized results, side effects and personal data in the input', () => {
    expect(cacheEligibility({ ...faq, personalized: true }, enabled)).toMatchObject({
      reason: 'personalized',
    });
    expect(cacheEligibility({ ...faq, sideEffects: true }, enabled)).toMatchObject({
      reason: 'side_effects',
    });
    expect(
      cacheEligibility({ ...faq, texts: ['Has order NL-1048 shipped?'] }, enabled),
    ).toMatchObject({ eligible: false, reason: 'personal_data', detail: 'reference' });
    expect(
      cacheEligibility({ ...faq, texts: ['Email me at ayesha@example.com'] }, enabled),
    ).toMatchObject({ reason: 'personal_data', detail: 'email' });
  });

  it('never shares a result built with personal context, such as customer memory', () => {
    expect(cacheEligibility({ ...faq, personalContext: ['personal_memory'] }, enabled)).toEqual({
      eligible: false,
      reason: 'personal_context',
      rule: 'core.personal_context',
      detail: 'personal_memory',
    });
    // Private to one customer (their own prefix and personal version), it may be cached.
    expect(
      cacheEligibility(
        { ...faq, personalContext: ['personal_memory'], personalized: true, scope: 'customer' },
        enabled,
      ),
    ).toEqual({ eligible: true });
    // Personal data in the input and never-cached classes still veto, whoever the entry is for.
    expect(
      cacheEligibility(
        { ...faq, scope: 'customer', texts: ['Email me at a@example.com'] },
        enabled,
      ),
    ).toMatchObject({ reason: 'personal_data' });
    expect(
      cacheEligibility({ ...faq, scope: 'customer', dataClasses: ['live_order'] }, enabled),
    ).toMatchObject({ reason: 'excluded_class' });
  });

  it('runs exclusion rules other modules add (the commerce hook)', () => {
    const liveOrders: CacheExclusionRule = {
      id: 'commerce.live_order',
      check: (request) => (request.tags?.intent === 'order_status' ? 'live_order_state' : null),
    };
    expect(
      cacheEligibility({ ...faq, tags: { intent: 'order_status' } }, enabled, {
        rules: [liveOrders],
      }),
    ).toEqual({
      eligible: false,
      reason: 'excluded_by_rule',
      rule: 'commerce.live_order',
      detail: 'live_order_state',
    });
    expect(cacheEligibility(faq, enabled, { rules: [liveOrders] })).toEqual({ eligible: true });
  });

  it('passes data classes other modules name to their rules (K06)', () => {
    const commerce: CacheExclusionRule = {
      id: 'commerce.live_data',
      check: (request) =>
        request.dataClasses.filter((c) => c.startsWith('commerce.')).join(',') || null,
    };
    const order: CacheRequest = {
      ...faq,
      dataClasses: ['public_knowledge', 'commerce.order_status'],
    };
    expect(cacheEligibility(order, enabled, { rules: [commerce] })).toEqual({
      eligible: false,
      reason: 'excluded_by_rule',
      rule: 'commerce.live_data',
      detail: 'commerce.order_status',
    });
    expect(cacheEligibility(faq, enabled, { rules: [commerce] })).toEqual({ eligible: true });
  });

  it('stores only complete, validated output', () => {
    expect(cacheEligibility(faq, enabled, { forStore: true })).toMatchObject({
      reason: 'incomplete',
    });
    expect(cacheEligibility({ ...faq, complete: true }, enabled, { forStore: true })).toEqual({
      eligible: true,
    });
  });
});

describe('cacheInputText', () => {
  it('folds case and spacing but keeps negation, amounts and scripts', () => {
    expect(cacheInputText('  How can  I\ncancel? ')).toBe('how can i cancel?');
    expect(cacheInputText('Do not cancel')).not.toBe(cacheInputText('Do cancel'));
    expect(cacheInputText('USD 10')).not.toBe(cacheInputText('USD 100'));
    expect(cacheInputText('کینسل نہ کریں')).not.toBe(cacheInputText('کینسل کریں'));
  });
});
