import type { AgentConfig } from '@hamnivo/contracts';
import { type Db, fromPublicId, schema, withTenant } from '@hamnivo/db';
import {
  type AuthorityMessage,
  cacheDependency,
  cacheInputText,
  type ReplyLanguage,
} from '@hamnivo/domain';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { MemoryPartRef, SourceRef } from '../authority/views.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { CacheService, type CacheSpec, type Lookup, type SourceRefRow } from './cache.service.js';

export interface AnswerContext {
  tenantId: string;
  brandId: string;
  agentId: string;
  agentVersionId: string;
  config: AgentConfig;
  /** Hash of the system prompt without passages: rules, brand and agent instructions. */
  promptVersion: string;
  language: ReplyLanguage;
  /** Customer-visible history, newest last. */
  history: AuthorityMessage[];
  question: string;
  /**
   * Personal context the reply uses, such as `personal_memory` when customer memory was
   * recalled. Any code keeps the answer out of the shared cache; with a customer it may be
   * cached for that customer alone, under their namespace and memory version.
   */
  personalContext?: readonly string[];
  /** The customer principal the reply is for, when known. */
  subjectId?: string | null;
}

export interface CachedAnswer {
  text: string;
  /** Sources as published with the reply (titles, links, excerpts of public documents). */
  sources: SourceRef[];
  /** Document references and versions, to recheck before reuse. */
  refs: SourceRefRow[];
  /** Customer memories the reply cited (only in the customer's own entries). */
  memories?: MemoryPartRef[];
  provider: string;
  modelId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

/** Whether an entry is shared by the brand's customers or private to one customer. */
export type AnswerScope = 'shared' | 'customer';

export type AnswerLookup =
  | { kind: 'hit'; answer: CachedAnswer; fingerprint: string; scope: AnswerScope }
  | {
      kind: 'fill';
      scope: AnswerScope;
      /**
       * Stores the answer when it is still eligible. Pass the personal context the generation
       * ended up using (for example memory recalled after the lookup): any code prevents storing.
       */
      fill: (answer: CachedAnswer, used?: { personalContext?: readonly string[] }) => Promise<void>;
      status: 'miss' | 'stale';
    }
  | { kind: 'skip'; status: 'bypass' | 'unavailable'; reason: string | null };

/**
 * The exact answer cache (K01) for AI replies. Only a customer's first message in a conversation
 * qualifies: later turns depend on the conversation and are personal. Answers use public
 * knowledge only, the key binds the agent version, prompt, model, language, brand and knowledge
 * versions, and a hit is checked against the current knowledge before it is reused: a document
 * that changed, expired, was retired or is no longer public makes the entry stale.
 */
@Injectable()
export class AnswerCache {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly cache: CacheService,
  ) {}

  spec(
    context: AnswerContext,
    complete = false,
    personalContext: readonly string[] = [],
  ): CacheSpec {
    const incoming = context.history.filter((m) => m.direction === 'incoming' && !m.private);
    const answered = context.history.some(
      (m) => m.direction === 'outgoing' && !m.private && m.text?.trim(),
    );
    const { config } = context;
    // Only the opening question of a conversation is generic enough to reuse: later turns depend
    // on the conversation, which is not part of the key.
    const opening = incoming.length === 1 && !answered && config.mode === 'answer';
    const personal = [...(context.personalContext ?? []), ...personalContext];
    // Built with personal context (memory): kept for this customer alone, never shared.
    const own = opening && personal.length > 0 && Boolean(context.subjectId);
    return {
      tier: 'exact_answer',
      tenantId: context.tenantId,
      brandId: context.brandId,
      audience: own ? 'customer' : 'public',
      ...(own && context.subjectId ? { subjectId: context.subjectId } : {}),
      language: context.language,
      model: `${config.model.provider}/${config.model.modelId}`,
      promptVersion: `${context.agentVersionId}:${context.promptVersion}`,
      dependencies: [
        cacheDependency.agent(context.agentId),
        cacheDependency.brand(context.brandId),
        cacheDependency.cachePolicy(context.brandId, 'exact_answer'),
        ...config.knowledgeSourceIds.map((id) =>
          cacheDependency.knowledgeSource(fromPublicId('source', id)),
        ),
      ],
      input: cacheInputText(context.question),
      request: {
        tier: 'exact_answer',
        dataClasses:
          config.knowledgeSourceIds.length > 0 ? ['general', 'public_knowledge'] : ['general'],
        texts: [context.question],
        personalized: !opening,
        personalContext: personal,
        complete,
        tags: { channel: 'widget' },
      },
    };
  }

  /** Whether every cited document is still the same public, current, reviewed version. */
  private async stillValid(context: AnswerContext, refs: SourceRefRow[]): Promise<boolean> {
    if (refs.length === 0) return true;
    const now = this.clock().toISOString();
    const rows = await withTenant(this.db, { tenantId: context.tenantId, actorId: 'cache' }, (tx) =>
      tx
        .select({ id: schema.knowledgeDocuments.id, version: schema.documentVersions.version })
        .from(schema.knowledgeDocuments)
        .innerJoin(
          schema.documentVersions,
          and(
            eq(schema.documentVersions.id, schema.knowledgeDocuments.currentVersionId),
            eq(schema.documentVersions.state, 'ready'),
            sql`(${schema.documentVersions.validUntil} is null or ${schema.documentVersions.validUntil} > ${now}::timestamptz)`,
          ),
        )
        .innerJoin(
          schema.knowledgeSources,
          and(
            eq(schema.knowledgeSources.id, schema.knowledgeDocuments.sourceId),
            eq(schema.knowledgeSources.status, 'active'),
            eq(schema.knowledgeSources.visibility, 'public'),
            eq(schema.knowledgeSources.brandId, context.brandId),
            sql`(${schema.knowledgeSources.reviewEveryDays} is null or coalesce(${schema.knowledgeDocuments.reviewedAt}, ${schema.documentVersions.readyAt}) > ${now}::timestamptz - make_interval(days => ${schema.knowledgeSources.reviewEveryDays}))`,
          ),
        )
        .where(
          and(
            eq(schema.knowledgeDocuments.status, 'active'),
            inArray(
              schema.knowledgeDocuments.id,
              refs.map((r) => r.documentId),
            ),
          ),
        ),
    );
    const current = new Map(rows.map((r) => [r.id, r.version]));
    return refs.every((ref) => current.get(ref.documentId) === ref.version);
  }

  async lookup(context: AnswerContext): Promise<AnswerLookup> {
    const spec = this.spec(context);
    const scope: AnswerScope = spec.audience === 'customer' ? 'customer' : 'shared';
    const result: Lookup<CachedAnswer> = await this.cache.lookup<CachedAnswer>(spec);
    switch (result.status) {
      case 'bypass':
        return { kind: 'skip', status: 'bypass', reason: result.reason };
      case 'unavailable':
        return { kind: 'skip', status: 'unavailable', reason: null };
      case 'hit': {
        if (await this.stillValid(context, result.value.refs)) {
          await this.cache.count(spec, {
            savedInputTokens: result.value.inputTokens ?? 0,
            savedOutputTokens: result.value.outputTokens ?? 0,
            savedMs: result.value.latencyMs,
          });
          return { kind: 'hit', answer: result.value, fingerprint: result.key.fingerprint, scope };
        }
        await this.cache.reject(spec, result, 'source_changed');
        return this.fillFor(context, await this.cache.lookup<CachedAnswer>(spec), scope);
      }
      default:
        return this.fillFor(context, result, scope);
    }
  }

  private fillFor(
    context: AnswerContext,
    result: Lookup<CachedAnswer>,
    scope: AnswerScope,
  ): AnswerLookup {
    if (result.status !== 'miss' && result.status !== 'stale') {
      return { kind: 'skip', status: 'unavailable', reason: null };
    }
    return {
      kind: 'fill',
      scope,
      status: result.status,
      fill: async (answer, used) => {
        await this.cache.put(this.spec(context, true, used?.personalContext), result, answer, {
          sources: answer.refs,
        });
      },
    };
  }
}
