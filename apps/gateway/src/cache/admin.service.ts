import type {
  CacheEntry,
  CacheImpact,
  CacheInspection,
  CacheMetrics,
  InspectCacheRequest,
  InvalidateCacheRequest,
  CachePolicy as PolicyView,
  UpdateCachePolicyRequest,
} from '@hamnivo/contracts';
import { appendAudit, type Db, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import {
  CACHE_TIERS,
  type CacheTier,
  cacheDependency,
  detectLanguage,
  isReplyLanguage,
  NEVER_CACHED,
  resolveReplyLanguage,
} from '@hamnivo/domain';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { authorizedBrand, idOf } from '../decisions/access.js';
import { AgentsService } from '../runtime/agents.service.js';
import { promptVersion } from '../runtime/prompt.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { AnswerCache, type CachedAnswer } from './answers.js';
import { CacheService, type EntryRow, policyOf, type SourceRefRow } from './cache.service.js';
import { CacheHealth } from './store.js';

const KNOWLEDGE_PREFIX = 'knowledge:source:';

function sourcesOf(refs: unknown): CacheEntry['sources'] {
  if (!Array.isArray(refs)) return [];
  return (refs as SourceRefRow[]).map((ref) => ({
    documentId: toPublicId('document', ref.documentId),
    sourceId: toPublicId('source', ref.sourceId),
    title: ref.title,
    version: ref.version,
  }));
}

/**
 * Cache policy, inspection, invalidation and metrics for Studio (board 25, K01, K07, K10).
 * Reading needs `knowledge.read` for the brand and changing needs `knowledge.manage`; every change
 * is audited. Nothing here returns cached content except the preview of an eligible answer hit,
 * which by construction holds no personal data.
 */
@Injectable()
export class CacheAdminService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly cache: CacheService,
    private readonly answers: AnswerCache,
    private readonly agents: AgentsService,
    private readonly health: CacheHealth,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private get access() {
    return { now: this.clock(), config: this.config };
  }

  private bump(tx: TenantTx, tenantId: string, dependency: string) {
    return tx.execute(sql`select app.bump_cache_dependency(${tenantId}::uuid, ${dependency})`);
  }

  private policyView(
    brandId: string,
    row: typeof schema.cachePolicies.$inferSelect | undefined,
  ): PolicyView {
    const policy = policyOf(row);
    return {
      brandId: toPublicId('brand', brandId),
      version: policy.version,
      tiers: policy.tiers,
      excludedClasses: [...policy.excludedClasses],
      neverCached: [...NEVER_CACHED],
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedBy ? toPublicId('staff', row.updatedBy) : null,
    };
  }

  async policy(principal: StaffPrincipal, brandPublicId: string): Promise<PolicyView> {
    return this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'knowledge.read',
        this.access,
      );
      const { row } = await this.cache.policy(tx, brand.id);
      return this.policyView(brand.id, row);
    });
  }

  /** A new policy version: every tier's dependency rises, so earlier entries stop being read. */
  async updatePolicy(
    principal: StaffPrincipal,
    brandPublicId: string,
    input: z.output<typeof UpdateCachePolicyRequest>,
  ): Promise<PolicyView> {
    return this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'knowledge.manage',
        this.access,
      );
      const { row, policy } = await this.cache.policy(tx, brand.id);
      const tiers = { ...policy.tiers, ...input.tiers };
      const excludedClasses = input.excludedClasses ?? [...policy.excludedClasses];
      const [saved] = await tx
        .insert(schema.cachePolicies)
        .values({
          tenantId: principal.tenantId,
          brandId: brand.id,
          version: (row?.version ?? 0) + 1,
          tiers,
          excludedClasses,
          updatedBy: principal.staffMemberId,
        })
        .onConflictDoUpdate({
          target: [schema.cachePolicies.tenantId, schema.cachePolicies.brandId],
          set: {
            version: sql`${schema.cachePolicies.version} + 1`,
            tiers,
            excludedClasses,
            updatedBy: principal.staffMemberId,
            updatedAt: this.clock(),
          },
        })
        .returning();
      for (const tier of CACHE_TIERS) {
        await this.bump(tx, principal.tenantId, cacheDependency.cachePolicy(brand.id, tier));
      }
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'cache.policy.updated',
        targetType: 'brand',
        targetId: brandPublicId,
        outcome: 'success',
        data: {
          version: saved?.version ?? null,
          enabled: CACHE_TIERS.filter((t) => tiers[t].enabled),
          excludedClasses,
        },
      });
      return this.policyView(brand.id, saved);
    });
  }

  /**
   * What the answer cache would do for this question as a visitor's first message to the brand's
   * published agent (HNV-25-02 to HNV-25-04). Looks only: nothing is counted or removed.
   */
  async inspect(
    principal: StaffPrincipal,
    brandPublicId: string,
    input: z.output<typeof InspectCacheRequest>,
  ): Promise<CacheInspection> {
    const loaded = await this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'knowledge.read',
        this.access,
      );
      const agent = await this.agents.activeFor(tx, brand.id);
      return { brand, agent };
    });
    const language =
      input.language && isReplyLanguage(input.language)
        ? input.language
        : resolveReplyLanguage({ detection: detectLanguage(input.question) }).language;
    const base: CacheInspection = {
      tier: 'exact_answer',
      status: 'bypass',
      reason: null,
      rule: null,
      fingerprint: null,
      language,
      knowledge: [],
      expiresAt: null,
      preview: null,
      sources: [],
    };
    const { brand, agent } = loaded;
    if (!agent) return { ...base, reason: 'no_published_agent', rule: 'runtime.agent' };
    const now = this.clock();
    const context = {
      tenantId: principal.tenantId,
      brandId: brand.id,
      agentId: agent.profile.id,
      agentVersionId: agent.version.id,
      config: agent.config,
      promptVersion: promptVersion(agent.config, brand.name, { language }),
      language,
      history: [
        {
          ref: '0',
          conversationRef: '0',
          key: null,
          direction: 'incoming' as const,
          private: false,
          text: input.question,
          contentAttributes: {},
          sender: { kind: 'contact' as const, ref: '0', name: null },
          attachments: [],
          createdAt: now,
        },
      ],
      question: input.question,
    };
    const result = await this.cache.lookup<CachedAnswer>(this.answers.spec(context), {
      inspect: true,
    });
    const knowledge = (versions: Record<string, number>) =>
      Object.entries(versions)
        .filter(([name]) => name.startsWith(KNOWLEDGE_PREFIX))
        .map(([name, version]) => ({
          sourceId: toPublicId('source', name.slice(KNOWLEDGE_PREFIX.length)),
          version,
        }));
    switch (result.status) {
      case 'bypass':
        return { ...base, reason: result.reason, rule: result.rule };
      case 'unavailable':
        return { ...base, status: 'unavailable', reason: 'store_unavailable' };
      case 'hit':
        return {
          ...base,
          status: 'hit',
          fingerprint: result.key.fingerprint,
          knowledge: knowledge(result.versions),
          expiresAt: result.entry?.expiresAt.toISOString() ?? null,
          preview: result.value.text.slice(0, 600),
          sources: sourcesOf(result.value.refs),
        };
      case 'stale':
      case 'miss':
        return {
          ...base,
          status: result.status,
          reason: result.status === 'stale' ? 'dependency_changed' : 'not_cached',
          fingerprint: result.key.fingerprint,
          knowledge: knowledge(result.versions),
          sources: result.previous ? sourcesOf(result.previous.sourceRefs) : [],
        };
    }
  }

  async entries(
    principal: StaffPrincipal,
    brandPublicId: string,
    query: { tier?: CacheTier | undefined; sourceId?: string | undefined; limit: number },
  ): Promise<CacheEntry[]> {
    return this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'knowledge.read',
        this.access,
      );
      const e = schema.cacheEntryIndex;
      const dependency = query.sourceId
        ? cacheDependency.knowledgeSource(idOf('source', query.sourceId, 'Source'))
        : null;
      const rows = await tx
        .select()
        .from(e)
        .where(
          and(
            eq(e.brandId, brand.id),
            query.tier ? eq(e.tier, query.tier) : undefined,
            dependency ? sql`${e.dependencies} ? ${dependency}` : undefined,
          ),
        )
        .orderBy(desc(e.createdAt))
        .limit(query.limit);
      const names = [...new Set(rows.flatMap((r) => Object.keys(r.dependencies as object)))];
      const current = await this.cache.versions(tx, names);
      const now = this.clock();
      return rows.map((row) => {
        const deps = row.dependencies as Record<string, number>;
        return {
          fingerprint: row.fingerprint,
          tier: row.tier,
          language: row.language,
          audience: row.audience,
          model: row.model,
          dependencies: deps,
          sources: sourcesOf(row.sourceRefs),
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          hits: row.hits,
          lastHitAt: row.lastHitAt?.toISOString() ?? null,
          stale:
            row.invalidatedAt !== null ||
            row.expiresAt <= now ||
            Object.entries(deps).some(([name, version]) => (current[name] ?? 0) !== version),
          invalidatedAt: row.invalidatedAt?.toISOString() ?? null,
          invalidationReason: row.invalidationReason,
        };
      });
    });
  }

  /** How many live entries depend on a source: the preview before editing it (board 25). */
  async impact(
    principal: StaffPrincipal,
    brandPublicId: string,
    sourcePublicId: string,
  ): Promise<CacheImpact> {
    const sourceId = idOf('source', sourcePublicId, 'Source');
    return this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'knowledge.read',
        this.access,
      );
      const dependency = cacheDependency.knowledgeSource(sourceId);
      const version = (await this.cache.versions(tx, [dependency]))[dependency] ?? 0;
      const e = schema.cacheEntryIndex;
      const [row] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(e)
        .where(
          and(
            eq(e.brandId, brand.id),
            sql`${e.invalidatedAt} is null`,
            gte(e.expiresAt, this.clock()),
            sql`(${e.dependencies} ->> ${dependency})::bigint = ${version}`,
          ),
        );
      return { sourceId: sourcePublicId, version, entries: Number(row?.n ?? 0) };
    });
  }

  /**
   * Invalidates a source's entries, a tier, or the whole brand (HNV-25-05). Reads stop at once
   * because the dependency version rises in this transaction; the stored keys are removed after,
   * and a key that cannot be removed now simply expires.
   */
  async invalidate(
    principal: StaffPrincipal,
    brandPublicId: string,
    input: z.output<typeof InvalidateCacheRequest>,
  ) {
    const bumped = await this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'knowledge.manage',
        this.access,
      );
      const names = input.sourceId
        ? [cacheDependency.knowledgeSource(idOf('source', input.sourceId, 'Source'))]
        : (input.tier ? [input.tier] : [...CACHE_TIERS]).map((tier) =>
            cacheDependency.cachePolicy(brand.id, tier),
          );
      for (const name of names) await this.bump(tx, principal.tenantId, name);
      const versions = await this.cache.versions(tx, names);
      const outdated: EntryRow[] = [];
      for (const name of names) {
        outdated.push(...(await this.cache.outdated(tx, brand.id, name, versions[name] ?? 0)));
      }
      // Entries of a tier also depend on the tier's policy version; a source's on the source.
      const unique = [...new Map(outdated.map((row) => [row.id, row])).values()].filter(
        (row) => !input.tier || row.tier === input.tier,
      );
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'cache.invalidated',
        targetType: 'brand',
        targetId: brandPublicId,
        outcome: 'success',
        data: {
          reason: input.reason,
          ...(input.sourceId ? { source: input.sourceId } : {}),
          ...(input.tier ? { tier: input.tier } : {}),
          entries: unique.length,
          versions,
        },
      });
      return { versions, entries: unique };
    });
    const retired = await this.cache.retire(bumped.entries, input.reason.slice(0, 200));
    return {
      invalidated: bumped.entries.length,
      removed: retired.removed,
      failed: retired.failed,
      dependencies: bumped.versions,
    };
  }

  async metrics(
    principal: StaffPrincipal,
    brandPublicId: string,
    days: number,
  ): Promise<CacheMetrics> {
    const counted = await this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'knowledge.read',
        this.access,
      );
      const since = new Date(this.clock().getTime() - (days - 1) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const m = schema.cacheMetricsDaily;
      const rows = await tx
        .select()
        .from(m)
        .where(and(eq(m.brandId, brand.id), gte(m.day, since)))
        .orderBy(desc(m.day), m.tier, m.language);
      return {
        brandId: brandPublicId,
        rows: rows.map((row) => ({
          day: row.day,
          tier: row.tier,
          language: row.language,
          hits: row.hits,
          misses: row.misses,
          bypasses: row.bypasses,
          stores: row.stores,
          stale: row.stale,
          errors: row.errors,
          savedInputTokens: row.savedInputTokens,
          savedOutputTokens: row.savedOutputTokens,
          savedMs: row.savedMs,
          lookupMs: row.lookupMs,
        })),
      };
    });
    await this.cache.probe();
    return {
      ...counted,
      health: {
        store: this.health.degraded() ? 'degraded' : 'up',
        recentFailures: this.health.recentFailures(),
      },
    };
  }

  static brandNotFound() {
    return new AppError('NOT_FOUND', { detail: 'Brand not found.' });
  }
}
