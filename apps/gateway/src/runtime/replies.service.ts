import { createHash } from 'node:crypto';
import { normalizeModelError } from '@hamnivo/adapters/models';
import type { AgentConfig, ModelChoice } from '@hamnivo/contracts';
import {
  type ClaimedOutboxEvent,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { type AuthorityMessage, detectHumanRequest } from '@hamnivo/domain';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { generateText, isStepCount } from 'ai';
import canonicalize from 'canonicalize';
import { and, eq, ne, sql } from 'drizzle-orm';
import { type JournalEntry, JournalService } from '../authority/journal.service.js';
import { type ControlRow, OwnershipService } from '../authority/ownership.service.js';
import { PublicationsService } from '../authority/publications.service.js';
import { AuthorityRegistry, type ConnectionRuntime } from '../authority/registry.js';
import { authorityMessageUuid, uuidV5 } from '../authority/uuid.js';
import {
  contractMessage,
  type MemoryPartRef,
  type PublicationFacts,
  type SourceRef,
} from '../authority/views.js';
import { AnswerCache, type AnswerLookup } from '../cache/answers.js';
import type { SourceRefRow } from '../cache/cache.service.js';
import { AppError } from '../common/app-error.js';
import { type Passage, RetrievalService } from '../knowledge/retrieval.service.js';
import { LanguageService } from '../language/language.service.js';
import { citeMemories, memoryBlock } from '../memory/prompt.js';
import { MemoryRecallService } from '../memory/recall.service.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { AuthorityContactsService } from '../widget/contacts.service.js';
import { type ActiveAgent, AgentsService } from './agents.service.js';
import { type AiHandoffReason, HANDOFF_NOTES } from './handoff-notes.js';
import { checkHonesty } from './honesty.js';
import { KillSwitchesService } from './kill-switches.service.js';
import { ModelFactory, ModelUnavailableError } from './models.js';
import {
  applyCitations,
  historyMessages,
  type PromptOptions,
  promptVersion,
  systemPrompt,
} from './prompt.js';
import { type RunOutcome, RunsService } from './runs.service.js';

interface CustomerMessageEvent {
  conversationId: string;
  ledgerId: string;
  epoch: number;
}

interface Context {
  control: ControlRow;
  agent: ActiveAgent | null;
  stopped: boolean;
  brandName: string;
}

interface Generated {
  text: string;
  provider: string;
  modelId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  /** Knowledge the reply cites, in citation order. */
  sources: SourceRef[];
  /** The cited documents and versions, for the answer cache to recheck before reuse. */
  refs: SourceRefRow[];
  /** Customer memories the reply relied on (G19). */
  memories: MemoryPartRef[];
}

/** Prompt options, and why the reply language was chosen (recorded with the model step). */
type GenerateOptions = PromptOptions & { languageSource?: string };

/** The customer's most recent words in a conversation. */
function latestCustomerText(history: AuthorityMessage[]): string {
  const incoming = history
    .filter((m) => m.direction === 'incoming' && !m.private && m.text?.trim())
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || Number(a.ref) - Number(b.ref));
  return incoming.at(-1)?.text?.trim() ?? '';
}

/** Passages retrieved per run. */
const PASSAGES = 5;

/** The start of a passage, cut at a word boundary, for the customer to recognise the source. */
function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= 280) return flat;
  const cut = flat.slice(0, 280);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 200))}…`;
}

/** Why a reply was not published, recorded on the publication for review. */
type AbortReason = 'owner_changed' | 'preflight_owner_mismatch' | 'not_ai_owned';

const CORRECTION =
  'Your previous draft claimed to be a person. You are an AI assistant; say so if it matters.';

/** Outbox attempts before a failing model hands the conversation to people. */
const MODEL_ATTEMPTS = 3;

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** The model answered with nothing to say. */
class EmptyReplyError extends Error {
  override readonly name = 'EmptyReplyError';
}

/** Failure of a model call, without prompt text or credentials. */
export function classifyModelError(error: unknown): { kind: string; retryable: boolean } {
  if (error instanceof ModelUnavailableError) return { kind: error.reason, retryable: false };
  if (error instanceof EmptyReplyError) return { kind: 'empty_reply', retryable: false };
  const normalized = normalizeModelError(error);
  return { kind: normalized.kind, retryable: normalized.retryable };
}

/** Kinds where another provider may still answer; a bad request would fail there too. */
const FALLBACK_KINDS = new Set(['rate_limited', 'overloaded', 'unavailable', 'timeout']);

/**
 * AI replies with fenced publication (ADR 0003, R05/R06), run by the brand's published agent
 * (G01) within its limits (G09), recorded as a run (G12). The reply is generated outside any lock,
 * then reserved under the ownership epoch the customer message arrived in. A pre-flight check
 * confirms Chatwoot still shows the Hamnivo bot as owner before the post. When the AI cannot or
 * must not answer, the conversation goes to people with a note saying why.
 */
@Injectable()
export class RepliesService {
  private readonly logger = new Logger(RepliesService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: AuthorityRegistry,
    private readonly journal: JournalService,
    private readonly ownership: OwnershipService,
    private readonly agents: AgentsService,
    private readonly switches: KillSwitchesService,
    private readonly runs: RunsService,
    private readonly models: ModelFactory,
    private readonly contacts: AuthorityContactsService,
    private readonly retrieval: RetrievalService,
    private readonly publications: PublicationsService,
    private readonly language: LanguageService,
    private readonly answers: AnswerCache,
    private readonly memory: MemoryRecallService,
  ) {}

  private tx<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(this.db, { tenantId, actorId: 'ai' }, work);
  }

  private fenced(control: ControlRow, epoch: number): AbortReason | null {
    if (control.ownerMode !== 'AI_ACTIVE') return 'not_ai_owned';
    if (control.ownershipEpoch !== epoch || control.ownerSyncedEpoch !== control.ownershipEpoch)
      return 'owner_changed';
    return null;
  }

  /**
   * Ends the run when the customer wrote again after the message that started it; the newer
   * message's own job then answers with the whole conversation in view.
   */
  private async skipIfSuperseded(
    tenantId: string,
    runId: string,
    payload: CustomerMessageEvent,
    telemetry: Omit<Parameters<RunsService['finish']>[2], 'outcome' | 'state'> = {},
  ): Promise<boolean> {
    return this.tx(tenantId, async (tx) => {
      const l = schema.messageLedger;
      // Compared in SQL: timestamps read into JavaScript lose their microseconds.
      const [newer] = await tx
        .select({ id: l.id })
        .from(l)
        .where(
          and(
            eq(l.conversationId, payload.conversationId),
            eq(l.senderKind, 'customer'),
            eq(l.state, 'committed'),
            ne(l.id, payload.ledgerId),
            sql`${l.createdAt} > (select m.created_at from message_ledger m where m.id = ${payload.ledgerId})`,
          ),
        )
        .limit(1);
      if (!newer) return false;
      await this.runs.step(tx, tenantId, runId, {
        kind: 'decision',
        name: 'superseded',
        status: 'ok',
        detail: { reason: 'newer_customer_message' },
      });
      await this.runs.finish(tx, runId, { outcome: 'skipped', state: 'skipped', ...telemetry });
      return true;
    });
  }

  /** Outbox handler for `conversation.customer_message`. Safe to run more than once. */
  async onCustomerMessage(event: ClaimedOutboxEvent): Promise<void> {
    const payload = event.payload as CustomerMessageEvent;
    const context = await this.tx(event.tenantId, async (tx): Promise<Context | null> => {
      const [control] = await tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, payload.conversationId));
      if (!control) return null;
      const agent = control.brandId ? await this.agents.activeFor(tx, control.brandId) : null;
      const stop = await this.switches.activeFor(tx, {
        brandId: control.brandId,
        agentId: agent?.profile.id ?? null,
      });
      const [brand] = control.brandId
        ? await tx.select().from(schema.brands).where(eq(schema.brands.id, control.brandId))
        : [];
      return { control, agent, stopped: stop !== null, brandName: brand?.name ?? 'this business' };
    });
    if (!context) return;
    if (context.control.ownerMode === 'AI_ACTIVE') {
      await this.reply(event, payload, context);
    } else if (context.agent?.config.mode === 'assist' && !context.stopped) {
      await this.suggest(event, payload, context);
    }
  }

  private async reply(event: ClaimedOutboxEvent, payload: CustomerMessageEvent, context: Context) {
    const tenantId = event.tenantId;
    const { control, agent } = context;
    const sourceKey = `hv1:p:${uuidV5(payload.conversationId, `reply:${payload.ledgerId}`)}`;
    const [publication] = await this.tx(tenantId, (tx) =>
      tx.select().from(schema.publications).where(eq(schema.publications.sourceKey, sourceKey)),
    );
    if (publication && publication.state !== 'reserved' && publication.state !== 'unknown') return;
    const runtime = await this.registry.get(tenantId, control.connectionId);
    const ref = String(control.externalConversationId);
    const bot = runtime.bots.find((b) => b.id === control.ownerBotId) ?? runtime.primaryBot;
    if (!bot) return;
    const run = await this.tx(tenantId, (tx) =>
      this.runs.start(tx, {
        tenantId,
        conversationId: control.id,
        brandId: control.brandId,
        agentId: agent?.profile.id ?? null,
        agentVersionId: agent?.version.id ?? null,
        triggerRef: `reply:${payload.ledgerId}`,
        kind: 'reply',
        epoch: payload.epoch,
      }),
    );

    // An earlier attempt may already have posted this reply.
    if (publication) {
      const posted = await runtime.authority.findByKey(ref, sourceKey, publication.createdAt);
      if (posted) {
        const stored = (publication.detail ?? {}) as Partial<PublicationFacts>;
        await this.record(tenantId, runtime, payload.conversationId, sourceKey, posted, {
          sources: stored.sources ?? [],
          ...(stored.displayName ? { displayName: stored.displayName } : {}),
          ...(stored.memories?.length ? { memories: stored.memories } : {}),
        });
        await this.tx(tenantId, (tx) => this.runs.finish(tx, run.id, { outcome: 'replied' }));
        return;
      }
    }
    if (this.fenced(control, payload.epoch)) {
      await this.tx(tenantId, (tx) => this.runs.finish(tx, run.id, { outcome: 'fenced' }));
      return;
    }
    if (await this.skipIfSuperseded(tenantId, run.id, payload)) return;
    if (agent?.config.mode !== 'answer') {
      await this.handOff(
        tenantId,
        control,
        run.id,
        payload.epoch,
        agent ? 'assist_mode' : 'no_agent',
      );
      return;
    }
    if (context.stopped) {
      await this.handOff(tenantId, control, run.id, payload.epoch, 'ai_stopped');
      return;
    }
    const history = await this.history(tenantId, runtime, control);
    // Handoff precedence 1: a customer who asks for a person gets one, and no model or decision
    // provider is consulted first (J04).
    const asked = detectHumanRequest(latestCustomerText(history.messages));
    if (asked.requested) {
      await this.tx(tenantId, (tx) =>
        this.runs.step(tx, tenantId, run.id, {
          kind: 'decision',
          name: 'human_request',
          status: 'ok',
          detail: { language: asked.language ?? null },
        }),
      );
      await this.handOff(tenantId, control, run.id, payload.epoch, 'customer_request');
      return;
    }

    // Reply in the customer's language (U01): their explicit choice, otherwise their words.
    const question = latestCustomerText(history.messages);
    const chosen = await this.language.forReply(tenantId, control.principalId, question);
    const options: GenerateOptions = {
      language: chosen.resolution.language,
      style: chosen.style,
      languageSource: chosen.resolution.source,
    };
    const cached = await this.cachedAnswer(
      tenantId,
      run.id,
      context,
      agent,
      history,
      question,
      options,
    );

    let generated: Generated | null;
    if (cached.kind === 'hit') {
      generated = {
        text: cached.answer.text,
        provider: 'cache',
        modelId: cached.answer.modelId,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        sources: cached.answer.sources,
        refs: cached.answer.refs,
        memories: [],
      };
    } else {
      try {
        generated = await this.generate(tenantId, run.id, context, agent, history, options);
      } catch (error) {
        const failure = classifyModelError(error);
        if (failure.retryable && event.attempts < MODEL_ATTEMPTS) throw error;
        await this.handOff(
          tenantId,
          control,
          run.id,
          payload.epoch,
          'ai_unavailable',
          failure.kind,
        );
        return;
      }
      if (!generated) {
        await this.handOff(tenantId, control, run.id, payload.epoch, 'ai_blocked');
        return;
      }
      // Only complete answers that passed the honesty guard, from the configured model, are kept.
      const config = agent.config;
      if (
        cached.kind === 'fill' &&
        generated.provider === config.model.provider &&
        generated.modelId === config.model.modelId
      ) {
        await cached.fill({
          text: generated.text,
          sources: generated.sources,
          refs: generated.refs,
          provider: generated.provider,
          modelId: generated.modelId,
          inputTokens: generated.inputTokens,
          outputTokens: generated.outputTokens,
          latencyMs: generated.latencyMs,
        });
      }
    }
    const reply = generated.text;
    const telemetry = {
      provider: generated.provider,
      modelId: generated.modelId,
      inputTokens: generated.inputTokens,
      outputTokens: generated.outputTokens,
      latencyMs: generated.latencyMs,
    };
    // The customer may have written again while the model was working: that message's job
    // answers both, so this reply is dropped (R05: one AI reply per burst of messages).
    if (await this.skipIfSuperseded(tenantId, run.id, payload, telemetry)) return;

    const facts: PublicationFacts = {
      sources: generated.sources,
      displayName: agent.config.displayName,
      ...(generated.memories.length ? { memories: generated.memories } : {}),
    };
    const reserved = await this.tx(tenantId, async (tx) => {
      const locked = await this.ownership.lock(tx, payload.conversationId);
      const reason = this.fenced(locked, payload.epoch);
      const [row] = await tx
        .insert(schema.publications)
        .values({
          tenantId,
          conversationId: locked.id,
          epoch: payload.epoch,
          sourceKey,
          contentHash: sha256(reply),
          state: reason ? 'aborted' : 'reserved',
          detail: reason ? { reason, currentEpoch: locked.ownershipEpoch } : facts,
        })
        .onConflictDoUpdate({
          target: schema.publications.sourceKey,
          set: reason
            ? {
                state: 'aborted',
                detail: { reason, currentEpoch: locked.ownershipEpoch },
                updatedAt: this.clock(),
              }
            : { updatedAt: this.clock(), detail: facts },
        })
        .returning();
      if (reason) await this.runs.finish(tx, run.id, { outcome: 'fenced', ...telemetry });
      return { publication: row, reason };
    });
    if (reserved.reason || !reserved.publication) {
      this.logger.log(
        `reply for ${payload.conversationId} not published: ${reserved.reason ?? 'no publication'}`,
      );
      return;
    }

    // Pre-flight: Chatwoot must still show the Hamnivo bot as the conversation's owner.
    const state = await runtime.authority.getState(ref);
    if (state.owner.kind !== 'bot' || state.owner.botRef !== String(bot.externalBotId)) {
      await this.abort(tenantId, sourceKey, 'preflight_owner_mismatch', {
        authorityOwner: state.owner,
      });
      await this.tx(tenantId, (tx) =>
        this.runs.finish(tx, run.id, { outcome: 'fenced', ...telemetry }),
      );
      return;
    }
    // A takeover committed in Hamnivo reaches Chatwoot through the outbox, so the pre-flight can
    // still show the bot: check Hamnivo's own fence once more, right before posting.
    const current = await this.tx(tenantId, (tx) =>
      tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, payload.conversationId)),
    );
    const latest = current[0];
    const lateReason = latest ? this.fenced(latest, payload.epoch) : 'not_ai_owned';
    if (lateReason) {
      await this.abort(tenantId, sourceKey, lateReason, {
        currentEpoch: latest?.ownershipEpoch ?? null,
      });
      await this.tx(tenantId, (tx) =>
        this.runs.finish(tx, run.id, { outcome: 'fenced', ...telemetry }),
      );
      return;
    }
    let posted: AuthorityMessage;
    try {
      ({ message: posted } = await runtime.authority.appendMessage({
        conversationRef: ref,
        key: sourceKey,
        author: { kind: 'bot', botRef: String(bot.externalBotId) },
        visibility: 'public',
        text: reply,
      }));
    } catch (error) {
      await this.tx(tenantId, (tx) =>
        tx
          .update(schema.publications)
          .set({ state: 'unknown', updatedAt: this.clock() })
          .where(eq(schema.publications.sourceKey, sourceKey)),
      );
      throw error;
    }
    await this.record(tenantId, runtime, payload.conversationId, sourceKey, posted, facts);
    await this.tx(tenantId, (tx) =>
      this.finishWithUsage(tx, tenantId, run.id, 'replied', telemetry),
    );
  }

  /** Assist mode (G03): a suggestion for staff as an internal note, never a customer reply. */
  private async suggest(
    event: ClaimedOutboxEvent,
    payload: CustomerMessageEvent,
    context: Context,
  ) {
    const tenantId = event.tenantId;
    const { control } = context;
    const agent = context.agent as ActiveAgent;
    const runtime = await this.registry.get(tenantId, control.connectionId);
    const bot = runtime.primaryBot;
    if (!bot) return;
    const ref = String(control.externalConversationId);
    const key = `hv1:d:${uuidV5(payload.conversationId, `draft:${payload.ledgerId}`)}`;
    const run = await this.tx(tenantId, (tx) =>
      this.runs.start(tx, {
        tenantId,
        conversationId: control.id,
        brandId: control.brandId,
        agentId: agent.profile.id,
        agentVersionId: agent.version.id,
        triggerRef: `draft:${payload.ledgerId}`,
        kind: 'draft',
        epoch: payload.epoch,
      }),
    );
    if (run.state !== 'running') return;
    if (run.attempts > 1 && (await runtime.authority.findByKey(ref, key, run.startedAt))) {
      await this.tx(tenantId, (tx) => this.runs.finish(tx, run.id, { outcome: 'drafted' }));
      return;
    }
    const history = await this.history(tenantId, runtime, control);
    const chosen = await this.language.forReply(
      tenantId,
      control.principalId,
      latestCustomerText(history.messages),
    );
    let generated: Generated | null;
    try {
      generated = await this.generate(tenantId, run.id, context, agent, history, {
        language: chosen.resolution.language,
        style: chosen.style,
        languageSource: chosen.resolution.source,
      });
    } catch (error) {
      const failure = classifyModelError(error);
      if (failure.retryable && event.attempts < MODEL_ATTEMPTS) throw error;
      await this.tx(tenantId, (tx) =>
        this.runs.finish(tx, run.id, { outcome: 'error', errorKind: failure.kind }),
      );
      return;
    }
    if (!generated) {
      await this.tx(tenantId, (tx) => this.runs.finish(tx, run.id, { outcome: 'blocked' }));
      return;
    }
    await runtime.authority.appendMessage({
      conversationRef: ref,
      key,
      author: { kind: 'bot', botRef: String(bot.externalBotId) },
      visibility: 'private',
      text: [
        `AI suggestion (not sent to the customer):\n\n${generated.text}`,
        ...(generated.sources.length
          ? [
              `Sources:\n${generated.sources
                .map(
                  (source, i) =>
                    `[${i + 1}] ${source.title}${source.url ? ` (${source.url})` : ''}`,
                )
                .join('\n')}`,
            ]
          : []),
      ].join('\n\n'),
    });
    await this.tx(tenantId, (tx) =>
      this.finishWithUsage(tx, tenantId, run.id, 'drafted', {
        provider: generated.provider,
        modelId: generated.modelId,
        inputTokens: generated.inputTokens,
        outputTokens: generated.outputTokens,
        latencyMs: generated.latencyMs,
      }),
    );
  }

  /** Customer-visible history: the Client API view when the contact is known. */
  private async history(
    tenantId: string,
    runtime: ConnectionRuntime,
    control: ControlRow,
  ): Promise<{ messages: AuthorityMessage[]; view: 'customer' | 'staff_filtered' }> {
    const ref = String(control.externalConversationId);
    const contact = await this.tx(tenantId, async (tx) => {
      if (!control.principalId) return null;
      const [row] = await tx
        .select({ contact: schema.authorityContacts, inbox: schema.authorityInboxes })
        .from(schema.authorityContacts)
        .innerJoin(
          schema.authorityInboxes,
          eq(schema.authorityInboxes.id, schema.authorityContacts.inboxId),
        )
        .where(
          and(
            eq(schema.authorityContacts.inboxId, control.inboxId),
            eq(schema.authorityContacts.principalId, control.principalId),
          ),
        );
      return row ?? null;
    });
    if (contact) {
      const messages = await runtime.authority.listMessages(ref, {
        view: 'customer',
        contactSourceId: this.contacts.sourceIdOf(tenantId, contact.contact),
        inboxRef: String(contact.inbox.externalInboxId),
      });
      return { messages, view: 'customer' };
    }
    // Conversations from other channels have no Hamnivo contact; private notes are removed here.
    const messages = await runtime.authority.listMessages(ref, { view: 'staff' });
    return {
      messages: messages.filter((m) => !m.private && m.direction !== 'activity'),
      view: 'staff_filtered',
    };
  }

  /**
   * The exact answer cache (K01): a customer's opening question to an answering agent, over public
   * knowledge only. The lookup is recorded as a run step with its outcome, never the text.
   */
  private async cachedAnswer(
    tenantId: string,
    runId: string,
    context: Context,
    agent: ActiveAgent,
    history: { messages: AuthorityMessage[] },
    question: string,
    options: GenerateOptions,
  ): Promise<AnswerLookup> {
    const brandId = context.control.brandId;
    if (!brandId || !options.language) {
      return { kind: 'skip', status: 'bypass', reason: 'no_brand' };
    }
    const started = Date.now();
    const found = await this.answers.lookup({
      tenantId,
      brandId,
      agentId: agent.profile.id,
      agentVersionId: agent.version.id,
      config: agent.config,
      promptVersion: promptVersion(agent.config, context.brandName, options),
      language: options.language,
      history: history.messages,
      question,
    });
    // With answer caching off (the default) there is nothing worth recording.
    if (found.kind === 'skip' && found.reason === 'tier_disabled') return found;
    await this.tx(tenantId, (tx) =>
      this.runs.step(tx, tenantId, runId, {
        kind: 'decision',
        name: 'answer_cache',
        status: found.kind === 'hit' ? 'ok' : 'skipped',
        latencyMs: Date.now() - started,
        detail:
          found.kind === 'hit'
            ? { outcome: 'hit', fingerprint: found.fingerprint }
            : { outcome: found.status, ...(found.kind === 'skip' ? { reason: found.reason } : {}) },
      }),
    );
    return found;
  }

  /**
   * Generates within the agent's limits, trying fallback models only when the main one is
   * overloaded or unavailable. Returns null when the honesty guard blocks the reply twice.
   */
  private async generate(
    tenantId: string,
    runId: string,
    context: Context,
    agent: ActiveAgent,
    fetched?: { messages: AuthorityMessage[]; view: 'customer' | 'staff_filtered' },
    options: GenerateOptions = {},
  ): Promise<Generated | null> {
    const runtime = await this.registry.get(tenantId, context.control.connectionId);
    const { messages: history, view } =
      fetched ?? (await this.history(tenantId, runtime, context.control));
    const config: AgentConfig = agent.config;
    const messages = historyMessages(history, config.limits.historyMessages);
    const assist = config.mode === 'assist';
    const passages = await this.retrieve(tenantId, runId, context, config, history);
    // Customer memory (G19): only with the customer's consent, in scope and currently valid.
    const memories = await this.memory.recall(tenantId, {
      runId,
      control: context.control,
      config,
      history,
    });
    const base =
      systemPrompt(config, context.brandName, passages, options) +
      (memories.length ? `\n\n${memoryBlock(memories)}` : '') +
      (assist
        ? '\n\nYou are writing a suggested reply for a support agent to review. Write only the reply.'
        : '');
    for (const correction of [null, CORRECTION]) {
      const system = correction ? `${base}\n\n${correction}` : base;
      const generated = await this.callModels(tenantId, runId, config, system, messages, {
        view,
        ...(options.language ? { language: options.language } : {}),
        ...(options.languageSource ? { languageSource: options.languageSource } : {}),
      });
      const cited = applyCitations(generated.text, passages, (p) => p.documentId);
      const remembered = citeMemories(cited.text, memories);
      const result: Generated = {
        ...generated,
        text: remembered.text,
        memories: remembered.memories,
        sources: cited.cited.map((p) => ({
          type: 'source',
          sourceId: toPublicId('document', p.documentId),
          title: p.title.slice(0, 300),
          url: p.url,
          version: `v${p.version}`,
          excerpt: excerptOf(p.text),
          freshness: 'current',
        })),
        refs: cited.cited.map((p) => ({
          documentId: p.documentId,
          sourceId: p.sourceId,
          title: p.title.slice(0, 300),
          version: p.version,
        })),
      };
      const verdict = checkHonesty(result.text);
      await this.tx(tenantId, (tx) =>
        this.runs.step(tx, tenantId, runId, {
          kind: 'guard',
          name: 'honest_identity',
          status: verdict.ok ? 'ok' : 'blocked',
          outputHash: sha256(result.text),
          detail: verdict.ok ? {} : { rule: verdict.rule },
        }),
      );
      if (verdict.ok) {
        if (!result.text) throw new EmptyReplyError('The model returned no text.');
        return result;
      }
    }
    return null;
  }

  /**
   * Passages from the agent's knowledge for the customer's latest words (G05). Customer answers
   * draw only on public sources; assist mode may use internal ones.
   */
  private async retrieve(
    tenantId: string,
    runId: string,
    context: Context,
    config: AgentConfig,
    history: AuthorityMessage[],
  ): Promise<Passage[]> {
    const brandId = context.control.brandId;
    if (config.knowledgeSourceIds.length === 0 || !brandId) return [];
    const query = history
      .filter((m) => m.direction === 'incoming' && !m.private && m.text?.trim())
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(-2)
      .map((m) => (m.text ?? '').trim())
      .join('\n')
      .slice(-1000);
    if (!query) return [];
    const started = Date.now();
    const passages = await this.tx(tenantId, (tx) =>
      this.retrieval.search(tx, {
        brandId,
        sourceIds: config.knowledgeSourceIds.map((id) => fromPublicId('source', id)),
        audience: config.mode === 'assist' ? 'staff' : 'customer',
        query,
        limit: PASSAGES,
      }),
    );
    await this.tx(tenantId, (tx) =>
      this.runs.step(tx, tenantId, runId, {
        kind: 'retrieval',
        name: 'knowledge',
        status: 'ok',
        latencyMs: Date.now() - started,
        inputHash: sha256(query),
        detail: {
          passages: passages.length,
          documents: [...new Set(passages.map((p) => toPublicId('document', p.documentId)))],
        },
      }),
    );
    return passages;
  }

  private async callModels(
    tenantId: string,
    runId: string,
    config: AgentConfig,
    system: string,
    messages: ReturnType<typeof historyMessages>,
    context: { view: string; language?: string; languageSource?: string },
  ): Promise<Generated> {
    const choices: ModelChoice[] = [config.model, ...config.fallbackModels];
    const inputHash = sha256(canonicalize({ system, messages }) ?? '');
    let lastError: unknown;
    for (const [index, choice] of choices.entries()) {
      const started = Date.now();
      try {
        const resolved = await this.models.resolve(tenantId, choice);
        const result = await generateText({
          model: resolved.model,
          instructions: system,
          messages,
          maxOutputTokens: config.limits.maxOutputTokens,
          stopWhen: isStepCount(config.limits.maxSteps),
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(config.limits.timeoutMs),
        });
        const generated: Generated = {
          text: result.text.trim(),
          provider: resolved.provider,
          modelId: resolved.modelId,
          inputTokens: result.usage.inputTokens ?? null,
          outputTokens: result.usage.outputTokens ?? null,
          latencyMs: Date.now() - started,
          sources: [],
          refs: [],
          memories: [],
        };
        await this.tx(tenantId, (tx) =>
          this.runs.step(tx, tenantId, runId, {
            kind: 'model',
            name: 'generate',
            status: 'ok',
            provider: generated.provider,
            modelId: generated.modelId,
            inputTokens: generated.inputTokens,
            outputTokens: generated.outputTokens,
            latencyMs: generated.latencyMs,
            inputHash,
            outputHash: sha256(generated.text),
            detail: {
              finishReason: result.finishReason,
              history: messages.length,
              ...context,
              index,
            },
          }),
        );
        return generated;
      } catch (error) {
        lastError = error;
        const failure = classifyModelError(error);
        await this.tx(tenantId, (tx) =>
          this.runs.step(tx, tenantId, runId, {
            kind: 'model',
            name: 'generate',
            status: 'error',
            provider: choice.provider,
            modelId: choice.modelId,
            latencyMs: Date.now() - started,
            inputHash,
            detail: { errorKind: failure.kind, index },
          }),
        );
        if (!FALLBACK_KINDS.has(failure.kind)) throw error;
      }
    }
    throw lastError;
  }

  private async finishWithUsage(
    tx: TenantTx,
    tenantId: string,
    runId: string,
    outcome: RunOutcome,
    telemetry: Omit<Generated, 'text' | 'sources' | 'refs' | 'memories'>,
  ) {
    await this.runs.finish(tx, runId, { outcome, ...telemetry });
    const now = this.clock();
    const entries = [
      ['ai.tokens.input', telemetry.inputTokens],
      ['ai.tokens.output', telemetry.outputTokens],
    ] as const;
    for (const [meter, quantity] of entries) {
      if (quantity === null) continue;
      await tx
        .insert(schema.usageEntries)
        .values({
          tenantId,
          meter,
          quantity,
          unit: 'token',
          occurredAt: now,
          dedupeKey: `run:${runId}:${meter}`,
          sourceRef: toPublicId('run', runId),
        })
        .onConflictDoNothing();
    }
  }

  /** Hands an AI-owned conversation to people, unless someone already took it. */
  private async handOff(
    tenantId: string,
    control: ControlRow,
    runId: string,
    epoch: number,
    reason: AiHandoffReason,
    errorKind?: string,
  ) {
    const outcome: RunOutcome = reason === 'ai_blocked' ? 'blocked' : 'handoff';
    let journal: JournalEntry[] = [];
    try {
      journal = await this.tx(tenantId, async (tx) => {
        const result = await this.ownership.transition(
          tx,
          tenantId,
          control.id,
          { kind: 'queue' },
          {
            origin: 'hamnivo',
            reason,
            actor: { type: 'system', id: 'ai' },
            expectedEpoch: epoch,
            handoffNote: HANDOFF_NOTES[reason],
          },
        );
        await this.runs.finish(tx, runId, {
          outcome,
          state: reason === 'ai_unavailable' ? 'failed' : 'succeeded',
          ...(errorKind ? { errorKind } : {}),
        });
        return result.journal;
      });
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'OWNERSHIP_CHANGED')) throw error;
      await this.tx(tenantId, (tx) => this.runs.finish(tx, runId, { outcome: 'fenced' }));
      return;
    }
    await this.journal.notify(tenantId, control.id, journal);
    this.logger.log(`conversation ${control.id} handed to people: ${reason}`);
  }

  private async abort(
    tenantId: string,
    sourceKey: string,
    reason: AbortReason,
    detail: Record<string, unknown>,
  ) {
    await this.tx(tenantId, (tx) =>
      tx
        .update(schema.publications)
        .set({ state: 'aborted', detail: { reason, ...detail }, updatedAt: this.clock() })
        .where(
          and(
            eq(schema.publications.sourceKey, sourceKey),
            eq(schema.publications.state, 'reserved'),
          ),
        ),
    );
    this.logger.log(`publication ${sourceKey} aborted: ${reason}`);
  }

  private async record(
    tenantId: string,
    runtime: ConnectionRuntime,
    conversationId: string,
    sourceKey: string,
    posted: AuthorityMessage,
    facts: PublicationFacts,
  ): Promise<void> {
    const authorityId = Number(posted.ref);
    const entries: JournalEntry[] = await this.tx(tenantId, async (tx) => {
      const control = await this.ownership.lock(tx, conversationId);
      await this.publications.confirm(tx, tenantId, control, sourceKey, posted);
      if (await this.journal.hasMessage(tx, conversationId, 'customer', authorityId)) return [];
      return this.journal.append(tx, tenantId, conversationId, [
        {
          lane: 'customer',
          type: 'message.created',
          data: {
            message: contractMessage({
              message: posted,
              id: toPublicId('message', authorityMessageUuid(runtime.connectionId, posted.ref)),
              conversationId: toPublicId('conversation', conversationId),
              sequence: null,
              clientMessageId: null,
              delivery: null,
              facts,
            }),
          },
          authorityCreatedAt: posted.createdAt,
          authorityId,
        },
      ]);
    });
    await this.journal.notify(tenantId, conversationId, entries);
  }
}
