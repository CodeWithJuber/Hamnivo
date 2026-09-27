import { findPersonalData } from './privacy.js';

/**
 * Tenant-safe NLP and answer caching (K01, K06, K07, blueprint §31). A cache entry is reachable
 * only under a key built from everything that could change its result: tenant, brand, audience,
 * language, model, prompt version, the versions of every dependency (knowledge sources, agent,
 * policy) and a keyed digest of the exact input. Keys never contain input text. Bumping a
 * dependency version changes the key, so stale entries stop being read at once.
 */

export const CACHE_TIERS = [
  'exact_answer',
  'nlp',
  'embedding',
  'retrieval',
  'translation',
] as const;
export type CacheTier = (typeof CACHE_TIERS)[number];

/**
 * What a computation reads. Only public or general data may be cached and shared; personal,
 * account, live and consequential data never are (K06: commerce adds its own exclusions through
 * {@link CacheExclusionRule}).
 */
export const CACHE_DATA_CLASSES = [
  'general',
  'public_knowledge',
  'internal_knowledge',
  'personal',
  'identity',
  'account',
  'memory',
  'live_order',
  'payment',
  'approval',
  'tool_result',
] as const;
export type CacheDataClass = (typeof CACHE_DATA_CLASSES)[number];

/** Data classes that can never be served from a shared cache. */
export const NEVER_CACHED: readonly CacheDataClass[] = [
  'personal',
  'identity',
  'account',
  'memory',
  'live_order',
  'payment',
  'approval',
  'tool_result',
];

export type CacheAudience = 'public' | 'staff';

export interface CacheKeyEnvelope {
  tier: CacheTier;
  tenantId: string;
  brandId: string;
  /** Who may see the result. Personal audiences are never cached. */
  audience: CacheAudience;
  /** BCP 47 language of the result (or of the input for NLP tiers); null when language-free. */
  language: string | null;
  /** Provider and model id, including its revision; null for model-free computations. */
  model: string | null;
  /** Prompt, schema or algorithm version (for embeddings: preprocessing version and dimensions). */
  promptVersion: string;
  /** Every dependency with its current version, e.g. `knowledge:source:<id>` → 12. */
  dependencies: Readonly<Record<string, number>>;
  /** Keyed digest (HMAC with a tenant secret) of the exact input. Never the input itself. */
  inputDigest: string;
}

/** Dependency names, so producers and invalidators agree on them. */
export const cacheDependency = {
  knowledgeSource: (sourceId: string) => `knowledge:source:${sourceId}`,
  agent: (agentId: string) => `agent:${agentId}`,
  brand: (brandId: string) => `brand:${brandId}`,
  cachePolicy: (brandId: string) => `cache_policy:${brandId}`,
  glossary: (glossaryId: string) => `glossary:${glossaryId}`,
} as const;

const DIGEST = /^[0-9a-f]{32,128}$/;
const DEPENDENCY = /^[a-z_]+(?::[A-Za-z0-9_.-]+)+$/;

/** Returns why an envelope is incomplete, or undefined. Incomplete envelopes are never cached. */
export function envelopeProblem(envelope: CacheKeyEnvelope): string | undefined {
  if (!CACHE_TIERS.includes(envelope.tier)) return `unknown tier "${String(envelope.tier)}"`;
  if (!envelope.tenantId) return 'tenantId is required';
  if (!envelope.brandId) return 'brandId is required';
  if (envelope.audience !== 'public' && envelope.audience !== 'staff') {
    return 'audience must be public or staff';
  }
  if (!envelope.promptVersion) return 'promptVersion is required';
  if (!DIGEST.test(envelope.inputDigest)) return 'inputDigest must be a hex digest';
  for (const [name, version] of Object.entries(envelope.dependencies)) {
    if (!DEPENDENCY.test(name)) return `dependency "${name}" is not a valid name`;
    if (!Number.isSafeInteger(version) || version < 0) {
      return `dependency "${name}" needs a whole version number`;
    }
  }
  return undefined;
}

/**
 * The canonical text a key is hashed from: every field, dependencies sorted by name, so the same
 * envelope always gives the same key and any difference gives another.
 */
export function cacheKeyMaterial(envelope: CacheKeyEnvelope): string {
  const problem = envelopeProblem(envelope);
  if (problem) throw new TypeError(`Incomplete cache key: ${problem}`);
  const dependencies = Object.entries(envelope.dependencies).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return JSON.stringify([
    'hv-cache-v1',
    envelope.tier,
    envelope.tenantId,
    envelope.brandId,
    envelope.audience,
    envelope.language ?? '',
    envelope.model ?? '',
    envelope.promptVersion,
    dependencies,
    envelope.inputDigest,
  ]);
}

export interface CacheKey {
  /** Where the entry lives: tenant and brand in clear (for scoped purges), then the fingerprint. */
  key: string;
  /** Hash of the key material; shown in the inspector instead of any content. */
  fingerprint: string;
}

/**
 * Builds the storage key. `hash` must be a collision-resistant digest (SHA-256) of the material.
 * The tenant and brand prefix makes cross-tenant reads impossible even if two digests collided.
 */
export function cacheKey(envelope: CacheKeyEnvelope, hash: (material: string) => string): CacheKey {
  const fingerprint = hash(cacheKeyMaterial(envelope));
  return {
    key: `t:${envelope.tenantId}:b:${envelope.brandId}:${envelope.tier}:${fingerprint}`,
    fingerprint,
  };
}

export interface CacheRequest {
  tier: CacheTier;
  /** What the computation reads. */
  dataClasses: readonly CacheDataClass[];
  /** Customer or staff text the result depends on; checked for personal data, never stored. */
  texts?: readonly string[];
  /** The result depends on this conversation's history, a person's memory or identity. */
  personalized?: boolean;
  /** Tools, sends or other side effects happened. Such results are never cached or replayed. */
  sideEffects?: boolean;
  /** For stores: the output is complete and passed validation (not cancelled, not blocked). */
  complete?: boolean;
  /** Facts for exclusion rules added by other modules, such as `{ intent: 'order_status' }`. */
  tags?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface CacheTierPolicy {
  enabled: boolean;
  ttlSeconds: number;
}

export interface CachePolicy {
  version: number;
  tiers: Readonly<Record<CacheTier, CacheTierPolicy>>;
  /** Extra data classes the brand excludes on top of {@link NEVER_CACHED}. */
  excludedClasses: readonly CacheDataClass[];
}

/** Off for answers until an administrator turns it on; exact NLP and embeddings are safe to reuse. */
export const DEFAULT_CACHE_POLICY: CachePolicy = {
  version: 0,
  tiers: {
    exact_answer: { enabled: false, ttlSeconds: 3600 },
    nlp: { enabled: true, ttlSeconds: 86_400 },
    embedding: { enabled: true, ttlSeconds: 7 * 86_400 },
    retrieval: { enabled: false, ttlSeconds: 600 },
    translation: { enabled: false, ttlSeconds: 86_400 },
  },
  excludedClasses: [],
};

export const MAX_CACHE_TTL_SECONDS = 30 * 86_400;

/** Why a request bypasses the cache. Stored and shown; never contains the input. */
export type CacheBypassReason =
  | 'tier_disabled'
  | 'excluded_class'
  | 'personal_data'
  | 'personalized'
  | 'side_effects'
  | 'incomplete'
  | 'excluded_by_rule';

/**
 * An exclusion another module adds, such as commerce excluding live order questions (K06). It
 * returns a short reason code when the request must bypass the cache, otherwise null.
 */
export interface CacheExclusionRule {
  id: string;
  check(request: CacheRequest): string | null;
}

export type CacheEligibility =
  | { eligible: true }
  | { eligible: false; reason: CacheBypassReason; rule: string; detail?: string };

/**
 * Whether a computation may be read from or written to the cache. Checks, in order: the tier is on,
 * no excluded data class, not personalized, no side effects, no personal data in the input, every
 * added exclusion rule, and for writes that the output is complete.
 */
export function cacheEligibility(
  request: CacheRequest,
  policy: CachePolicy,
  options: { rules?: readonly CacheExclusionRule[]; forStore?: boolean } = {},
): CacheEligibility {
  const deny = (reason: CacheBypassReason, rule: string, detail?: string): CacheEligibility => ({
    eligible: false,
    reason,
    rule,
    ...(detail ? { detail } : {}),
  });
  if (!policy.tiers[request.tier]?.enabled) return deny('tier_disabled', 'policy.tier');
  const excluded = request.dataClasses.find(
    (c) => NEVER_CACHED.includes(c) || policy.excludedClasses.includes(c),
  );
  if (excluded) return deny('excluded_class', 'policy.data_class', excluded);
  if (request.personalized) return deny('personalized', 'core.personalized');
  if (request.sideEffects) return deny('side_effects', 'core.side_effects');
  for (const text of request.texts ?? []) {
    const kinds = findPersonalData(text);
    if (kinds.length > 0) return deny('personal_data', 'core.personal_data', kinds.join(','));
  }
  for (const rule of options.rules ?? []) {
    const reason = rule.check(request);
    if (reason) return deny('excluded_by_rule', rule.id, reason);
  }
  if (options.forStore && request.complete !== true) return deny('incomplete', 'core.complete');
  return { eligible: true };
}

/** Normalizes text before digesting, without folding away meaning: case and spacing only. */
export function cacheInputText(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();
}
