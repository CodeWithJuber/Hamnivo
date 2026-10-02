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
import {
  type AuthorityMessage,
  detectHumanRequest,
  type ModuleDataClass,
  sharedCacheEligibility,
} from '@hamnivo/domain';
import {
  ACTION_CLAIM_CORRECTION,
  checkActionClaims,
  findActionClaims,
} from '@hamnivo/domain/actions';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { generateText, isStepCount, type ToolSet } from 'ai';
import canonicalize from 'canonicalize';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { TOOL_DATA_CLASS } from '../actions/answer-cache.js';
import { ActionApprovals } from '../actions/approvals.service.js';
import { type RunTools, ToolGateway } from '../actions/gateway.service.js';
import { HandoffPackets } from '../actions/handoff.service.js';
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
import { EntitlementsService } from '../billing/entitlements.service.js';
import { AnswerCache, type AnswerLookup } from '../cache/answers.js';
import type { SourceRefRow } from '../cache/cache.service.js';
import {
  type InboundVerdict,
  ReplyChecksService,
  type RunChecks,
} from '../checks/reply-checks.service.js';
import { claimedLiveData, conversationLiveData } from '../commerce/answer-cache.js';
import { CLAIM_CORRECTION, checkReplyClaims } from '../commerce/claims.js';
import { AppError } from '../common/app-error.js';
import { type Passage, RetrievalService } from '../knowledge/retrieval.service.js';
import { LanguageService } from '../language/language.service.js';
import { citeMemories, memoryBlock } from '../memory/prompt.js';
import { MemoryRecallService, type RecalledMemory } from '../memory/recall.service.js';
import { enqueueOutbox } from '../outbox/outbox.js';
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
  /** Commerce data the reply's receipt check read (X10), which keeps it out of caches (K06). */
  liveData: ModuleDataClass[];
}

/**
 * Prompt options, why the reply language was chosen (recorded with the model step), and the
 * checks that run around this reply (none for staff suggestions).
 */
type GenerateOptions = PromptOptions & { languageSource?: string; checks?: RunChecks | null };

/** Why `generate` returned no reply, and whether the reply it returned may be cached. */
interface GenerateOutcome {
  /** A live check held the reply back; the hand-off carries this note. */
  blocked?: { note: string };
  cacheable?: boolean;
}

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

/** The outbox topic that posts a reserved safety wording, at least once. */
export const SAFE_REPLY_TOPIC = 'conversation.safe_reply';

/** A safety wording claimed this recently is assumed to be still in flight. */
const IN_FLIGHT_MS = 30_000;

type UrgentVerdict = Extract<InboundVerdict, { action: 'urgent' }>;

/**
 * What the publications ledger keeps of a safety wording, so that every retry posts the same
 * words, as the same bot, without asking a model or Jev again.
 */
interface SafeReplyDetail extends PublicationFacts {
  safe: { text: string; botRef: string };
}

/**
 * Someone may be at risk: what the reply job needs to put the safety wording out (J04). Either
 * the AI still has the conversation, and the packet for the hand-off is made from `handoff`, or
 * people have it already (the customer asked for a person) and `handedOffAt` is the epoch their
 * hand-off made: the wording then follows it while nobody has answered.
 */
type SafeReplyInput = {
  tenantId: string;
  control: ControlRow;
  agent: ActiveAgent;
  runId: string;
  payload: CustomerMessageEvent;
  /** The key of this customer message's publication: one per message, wording or reply. */
  sourceKey: string;
  /** The bot that held the conversation: the wording comes from it. */
  botRef: string;
  urgent: UrgentVerdict;
} & (
  | { handedOffAt?: undefined; handoff: { request: string; language: string | null } }
  | { handedOffAt: number }
);

/** What a hand-off to people needs (see `handOffIn`). */
interface HandOffInput {
  tenantId: string;
  control: ControlRow;
  runId: string;
  epoch: number;
  reason: AiHandoffReason;
  errorKind?: string | undefined;
  handoff: { request?: string | null; language?: string | null };
  /** A note that says more than the reason's own (a check that held the reply back). */
  note?: string | undefined;
}

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
 *
 * Safety is not an AI reply, and the limits of AI replies never hold it back. Someone at risk
 * (message guard) gets Hamnivo's fixed wording, which costs no tokens, whatever the plan or the AI
 * budget say. A customer who asked for a person is handed over first, before Jev is asked (J04);
 * the guard then adds the wording and an urgent note. The wording is reserved in the transaction
 * that hands the conversation to people, and the outbox posts it (`conversation.safe_reply`) at
 * least once: a worker that stops in between loses neither the hand-off nor the wording.
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
    private readonly entitlements: EntitlementsService,
    private readonly toolGateway: ToolGateway,
    private readonly approvals: ActionApprovals,
    private readonly handoffs: HandoffPackets,
    private readonly checks: ReplyChecksService,
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
    const question = latestCustomerText(history.messages);
    // An answer to an approval request by text ("APPROVE 4F2A9C" where cards are not shown, W16)
    // is a decision, not a question: it is recorded and the AI does not reply to it. It costs no
    // tokens, so the plan's limits and the AI budget never stand in its way.
    if (await this.approvals.decideByText(tenantId, control, question, payload.ledgerId)) {
      await this.tx(tenantId, async (tx) => {
        await this.runs.step(tx, tenantId, run.id, {
          kind: 'decision',
          name: 'text_approval',
          status: 'ok',
          detail: {},
        });
        await this.runs.finish(tx, run.id, { outcome: 'skipped', state: 'skipped' });
      });
      return;
    }
    // Handoff precedence 1: a customer who asks for a person gets one, and no model or decision
    // provider is consulted first (J04).
    const asked = detectHumanRequest(question);
    if (asked.requested) {
      await this.tx(tenantId, (tx) =>
        this.runs.step(tx, tenantId, run.id, {
          kind: 'decision',
          name: 'human_request',
          status: 'ok',
          detail: { language: asked.language ?? null },
        }),
      );
      const handedOffAt = await this.handOff(
        tenantId,
        control,
        run.id,
        payload.epoch,
        'customer_request',
        undefined,
        { request: question },
      );
      // The hand-off is committed. Only now may Jev add to it: a customer who asks for a person
      // and also writes of hurting themselves still gets the safety wording and an urgent note.
      if (handedOffAt !== null) {
        await this.guardAfterHandoff({
          tenantId,
          control,
          agent,
          runId: run.id,
          payload,
          sourceKey,
          botRef: String(bot.externalBotId),
          history,
          question,
          handedOffAt,
        });
      }
      return;
    }

    // Plan limits and the workspace's own AI budget (A08) limit what costs tokens: the model's
    // replies, here. They never limit safety: Hamnivo's wording for someone at risk is fixed text.
    const allowance = await this.entitlements.aiAllowance(tenantId);

    // Checks around this reply, as the brand set them (shadow records, live acts).
    const checks = await this.checks.forRun({
      tenantId,
      brandId: control.brandId,
      conversationId: control.id,
      runId: run.id,
      budgetMs: agent.config.limits.timeoutMs,
    });

    // Reply in the customer's language (U01): their explicit choice, otherwise their words.
    const chosen = await this.language.forReply(
      tenantId,
      control.principalId,
      question,
      checks?.languageDecider(),
    );
    const options: GenerateOptions = {
      language: chosen.resolution.language,
      style: chosen.style,
      languageSource: chosen.resolution.source,
      tools: agent.config.tools.grants.length > 0,
      checks,
    };
    const handoffContext = { request: question, language: chosen.resolution.language ?? null };
    // Jev's checks of the customer's messages (message guard, escalation): they can only hand the
    // conversation to people, never answer, approve or unlock anything. With the AI's allowance
    // used up the conversation goes to people anyway, so only the safety question is asked.
    const forGuard = {
      messages: history.messages,
      language: chosen.detection.language ?? chosen.resolution.language,
      replyLanguage: chosen.resolution.language,
    };
    const inbound = allowance.allowed
      ? await checks?.inbound(forGuard)
      : await checks?.inboundGuard(forGuard);
    if (inbound?.action === 'handoff') {
      await this.handOff(
        tenantId,
        control,
        run.id,
        payload.epoch,
        inbound.reason,
        undefined,
        handoffContext,
        inbound.note,
      );
      return;
    }
    // Someone may be at risk: Hamnivo's safe wording goes out at once, without a model, memory or
    // cache, and people have the conversation with an urgent note from the same commit.
    if (inbound?.action === 'urgent') {
      await this.safeReply({
        tenantId,
        control,
        agent,
        runId: run.id,
        payload,
        sourceKey,
        botRef: String(bot.externalBotId),
        urgent: inbound,
        handoff: handoffContext,
      });
      return;
    }
    // Only now, with nothing urgent left to do, the limit: once used up, people answer instead.
    if (!allowance.allowed) {
      await this.tx(tenantId, (tx) =>
        this.runs.step(tx, tenantId, run.id, {
          kind: 'decision',
          name: 'ai_limit',
          status: 'ok',
          detail: { reason: allowance.reason },
        }),
      );
      await this.handOff(tenantId, control, run.id, payload.epoch, 'ai_limit');
      return;
    }
    // Customer memory (G19) is recalled before the cache: a reply built with it never enters a
    // shared entry, only the customer's own (keyed by their memory version, K09).
    const memories = await this.memory.recall(tenantId, {
      runId: run.id,
      control: context.control,
      config: agent.config,
      history: history.messages,
    });
    const shared = sharedCacheEligibility({ memoryItems: memories.length });
    const personalContext = shared.eligible ? [] : [shared.reason];
    // Commerce data the conversation holds (K06): a reply built from it is never cached. Nor is
    // the reply of an agent that may call tools (G15): it may rest on a tool's answer.
    const liveData = await this.tx(tenantId, (tx) => conversationLiveData(tx, control.id));
    const cached: AnswerLookup = await this.cachedAnswer(
      tenantId,
      run.id,
      context,
      agent,
      history,
      question,
      options,
      personalContext,
      options.tools ? [...liveData, TOOL_DATA_CLASS] : liveData,
    );

    let generated: Generated | null;
    const outcome: GenerateOutcome = {};
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
        memories: cached.answer.memories ?? [],
        liveData: [],
      };
    } else {
      // The agent's granted tools (G07, G08), cancelled with the run or when someone takes over.
      const tools =
        options.tools && control.brandId
          ? await this.toolGateway.forRun({
              tenantId,
              brandId: control.brandId,
              conversationId: control.id,
              principalId: control.principalId,
              runId: run.id,
              epoch: payload.epoch,
              agentId: agent.profile.id,
              agentVersionId: agent.version.id,
              agentDisplayName: agent.config.displayName,
              config: agent.config,
              controller: new AbortController(),
            })
          : null;
      try {
        generated = await this.generate(
          tenantId,
          run.id,
          context,
          agent,
          history,
          options,
          memories,
          tools,
          outcome,
        );
      } catch (error) {
        if (tools?.signal.aborted) {
          await this.stopped(tenantId, run.id, tools);
          return;
        }
        const failure = classifyModelError(error);
        if (failure.retryable && event.attempts < MODEL_ATTEMPTS) throw error;
        await this.handOff(
          tenantId,
          control,
          run.id,
          payload.epoch,
          'ai_unavailable',
          failure.kind,
          handoffContext,
        );
        return;
      } finally {
        tools?.close();
      }
      if (tools?.signal.aborted) {
        await this.stopped(tenantId, run.id, tools);
        return;
      }
      if (!generated) {
        await this.handOff(
          tenantId,
          control,
          run.id,
          payload.epoch,
          'ai_blocked',
          undefined,
          handoffContext,
          outcome.blocked?.note,
        );
        return;
      }
      // Only complete answers that passed the honesty guard and the live checks, from the
      // configured model, are kept.
      const config = agent.config;
      if (
        cached.kind === 'fill' &&
        outcome.cacheable !== false &&
        generated.provider === config.model.provider &&
        generated.modelId === config.model.modelId
      ) {
        await cached.fill(
          {
            text: generated.text,
            sources: generated.sources,
            refs: generated.refs,
            memories: generated.memories,
            provider: generated.provider,
            modelId: generated.modelId,
            inputTokens: generated.inputTokens,
            outputTokens: generated.outputTokens,
            latencyMs: generated.latencyMs,
          },
          { personalContext, dataClasses: generated.liveData },
        );
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
    // A person stopped this run (Cancel run): nothing more is posted.
    if (await this.cancelRequested(tenantId, run.id, telemetry)) return;

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

  /**
   * After a customer's request for a person was handed over: whether they also write of hurting
   * themselves, or of danger now (message guard). Jev only adds here: the hand-off is committed
   * before anything asks it, and nothing it says, or fails to say, changes that. With Jev down,
   * or no message guard set for the brand, the hand-off stands as it is.
   */
  private async guardAfterHandoff(input: {
    tenantId: string;
    control: ControlRow;
    agent: ActiveAgent;
    runId: string;
    payload: CustomerMessageEvent;
    sourceKey: string;
    botRef: string;
    history: { messages: AuthorityMessage[] };
    question: string;
    handedOffAt: number;
  }): Promise<void> {
    const { tenantId, control, agent, history, question } = input;
    try {
      const checks = await this.checks.forRun({
        tenantId,
        brandId: control.brandId,
        conversationId: control.id,
        runId: input.runId,
        budgetMs: agent.config.limits.timeoutMs,
      });
      if (!checks?.setting('message-guard')) return;
      const chosen = await this.language.forReply(
        tenantId,
        control.principalId,
        question,
        checks.languageDecider(),
      );
      const verdict = await checks.inboundGuard({
        messages: history.messages,
        language: chosen.detection.language ?? chosen.resolution.language,
        replyLanguage: chosen.resolution.language,
      });
      if (verdict.action !== 'urgent') return;
      await this.safeReply({
        tenantId,
        control,
        agent,
        runId: input.runId,
        payload: input.payload,
        sourceKey: input.sourceKey,
        botRef: input.botRef,
        urgent: verdict,
        handedOffAt: input.handedOffAt,
      });
    } catch (error) {
      // The hand-off stands, and nothing here may undo it or fail the job for it (J04).
      this.logger.error(`safety check after handing ${control.id} over failed: ${String(error)}`);
    }
  }

  /**
   * Hamnivo's safety wording for someone at risk: no model writes it, and Jev only decided that it
   * is needed. The wording is reserved in the transaction that gives people the conversation (with
   * the urgent note), or that queues the urgent note when they had it already, so a worker that
   * stops anywhere after that leaves neither half done: the outbox posts the wording at least
   * once, and the ledger shows it once (`publishSafeReply`).
   */
  private async safeReply(input: SafeReplyInput): Promise<void> {
    const { tenantId, control, sourceKey } = input;
    const reserved = await this.tx(tenantId, (tx) => this.reserveSafeReply(tx, input));
    await this.journal.notify(tenantId, control.id, reserved.journal);
    if (reserved.reason) {
      this.logger.log(`safety wording for ${control.id} not published: ${reserved.reason}`);
      return;
    }
    if (input.handedOffAt === undefined) {
      this.logger.log(`conversation ${control.id} handed to people: ${input.urgent.reason}`);
    }
    // Now, without waiting for the relay; if this fails, the outbox event posts it.
    await this.publishSafeReply(tenantId, control.id, sourceKey).catch((error: unknown) =>
      this.logger.warn(`safety wording ${sourceKey} not posted yet, the outbox will: ${error}`),
    );
  }

  /**
   * The one transaction behind a safety wording. The AI still has the conversation: it goes to
   * people here, with the urgent note. People have it already (they were asked for first): the
   * urgent note is queued for them, whatever happened since, and the wording follows only while
   * nobody has answered. The wording's publication is reserved under the epoch the hand-off made,
   * and the outbox event that posts it is queued with it.
   */
  private async reserveSafeReply(
    tx: TenantTx,
    input: SafeReplyInput,
  ): Promise<{ reason: AbortReason | null; journal: JournalEntry[] }> {
    const { tenantId, control, payload, urgent } = input;
    const locked = await this.ownership.lock(tx, control.id);
    let epoch = payload.epoch;
    let reason: AbortReason | null;
    let journal: JournalEntry[] = [];
    if (input.handedOffAt === undefined) {
      reason = this.fenced(locked, payload.epoch);
      if (reason) {
        await this.runs.finish(tx, input.runId, { outcome: 'fenced' });
      } else {
        const handed = await this.handOffIn(tx, {
          tenantId,
          control,
          runId: input.runId,
          epoch: payload.epoch,
          reason: urgent.reason,
          handoff: input.handoff,
          note: urgent.note,
        });
        epoch = handed.epoch;
        journal = handed.journal;
      }
    } else {
      epoch = input.handedOffAt;
      reason =
        locked.ownerMode === 'WAITING_HUMAN' && locked.ownershipEpoch === epoch
          ? null
          : 'owner_changed';
      await enqueueOutbox(tx, tenantId, {
        topic: 'conversation.note',
        aggregateType: 'conversation',
        aggregateId: locked.id,
        payload: {
          conversationId: locked.id,
          key: `hv1:n:${uuidV5(locked.id, `urgent:${payload.ledgerId}`)}`,
          text: reason
            ? `${urgent.note} No safety wording was sent: the conversation changed hands first.`
            : urgent.note,
        },
      });
    }
    const detail: SafeReplyDetail = {
      sources: [],
      displayName: input.agent.config.displayName,
      safe: { text: urgent.text, botRef: input.botRef },
    };
    const values = {
      epoch,
      contentHash: sha256(urgent.text),
      state: reason ? ('aborted' as const) : ('reserved' as const),
      detail: reason ? { reason, currentEpoch: locked.ownershipEpoch } : detail,
    };
    const [row] = await tx
      .insert(schema.publications)
      .values({ tenantId, conversationId: locked.id, sourceKey: input.sourceKey, ...values })
      .onConflictDoUpdate({
        target: schema.publications.sourceKey,
        set: { ...values, updatedAt: this.clock() },
        // A reply or wording already out for this message stays as it is.
        setWhere: inArray(schema.publications.state, ['reserved', 'unknown']),
      })
      .returning({ id: schema.publications.id });
    if (row && !reason) {
      await enqueueOutbox(tx, tenantId, {
        topic: SAFE_REPLY_TOPIC,
        aggregateType: 'conversation',
        aggregateId: locked.id,
        payload: { conversationId: locked.id, sourceKey: input.sourceKey },
      });
    }
    return { reason, journal };
  }

  /** Outbox handler for `conversation.safe_reply`. Safe to run more than once. */
  async onSafeReply(event: ClaimedOutboxEvent): Promise<void> {
    const payload = event.payload as { conversationId: string; sourceKey: string };
    await this.publishSafeReply(
      event.tenantId,
      payload.conversationId,
      payload.sourceKey,
      event.attempts,
    );
  }

  /**
   * Posts a reserved safety wording as the bot that held the conversation, and records it. It goes
   * out only while the conversation still waits for people at the epoch their hand-off made, so it
   * is never said over a person, and Chatwoot is asked once more right before the post. Safe to
   * run more than once, and from more than one worker: a claim keeps a second copy from being
   * posted, and a retry looks for the first copy by its key before it posts.
   */
  private async publishSafeReply(
    tenantId: string,
    conversationId: string,
    sourceKey: string,
    attempt = 1,
  ): Promise<void> {
    const now = this.clock();
    const claimed = await this.tx(tenantId, async (tx) => {
      // The control row first, then the publication: the order everything else takes them in.
      const control = await this.ownership.lock(tx, conversationId);
      const [publication] = await tx
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.sourceKey, sourceKey))
        .for('update');
      if (!publication || (publication.state !== 'reserved' && publication.state !== 'unknown')) {
        return { kind: 'done' as const };
      }
      // Not a safety wording (this message was answered another way since): nothing to post.
      if (!(publication.detail as Partial<SafeReplyDetail>).safe) return { kind: 'done' as const };
      if (control.ownerMode !== 'WAITING_HUMAN' || control.ownershipEpoch !== publication.epoch) {
        const reason: AbortReason = 'owner_changed';
        await tx
          .update(schema.publications)
          .set({
            state: 'aborted',
            detail: { reason, currentEpoch: control.ownershipEpoch },
            updatedAt: now,
          })
          .where(eq(schema.publications.id, publication.id));
        return { kind: 'aborted' as const, reason };
      }
      // Another worker is posting it right now: let the outbox come back instead of posting twice.
      if (
        publication.state === 'unknown' &&
        now.getTime() - publication.updatedAt.getTime() < IN_FLIGHT_MS
      ) {
        return { kind: 'busy' as const };
      }
      await tx
        .update(schema.publications)
        .set({ state: 'unknown', updatedAt: now })
        .where(eq(schema.publications.id, publication.id));
      return {
        kind: 'claimed' as const,
        control,
        publication,
        lookup: publication.state !== 'reserved' || attempt > 1,
      };
    });
    if (claimed.kind === 'done') return;
    if (claimed.kind === 'aborted') {
      this.logger.log(`safety wording ${sourceKey} not published: ${claimed.reason}`);
      return;
    }
    if (claimed.kind === 'busy') throw new Error(`safety wording ${sourceKey} is being posted`);
    const { control, publication } = claimed;
    const detail = publication.detail as SafeReplyDetail;
    const ref = String(control.externalConversationId);
    const facts: PublicationFacts = {
      sources: [],
      ...(detail.displayName ? { displayName: detail.displayName } : {}),
    };
    try {
      const runtime = await this.registry.get(tenantId, control.connectionId);
      let posted: AuthorityMessage | null = claimed.lookup
        ? await runtime.authority.findByKey(ref, sourceKey, publication.createdAt)
        : null;
      if (!posted) {
        // A person already on it in Chatwoot, not yet seen here, must not be talked over.
        const state = await runtime.authority.getState(ref);
        if (state.owner.kind === 'user') {
          await this.tx(tenantId, (tx) =>
            tx
              .update(schema.publications)
              .set({
                state: 'aborted',
                detail: {
                  reason: 'preflight_owner_mismatch' satisfies AbortReason,
                  authorityOwner: state.owner,
                },
                updatedAt: this.clock(),
              })
              .where(
                and(
                  eq(schema.publications.sourceKey, sourceKey),
                  inArray(schema.publications.state, ['reserved', 'unknown']),
                ),
              ),
          );
          this.logger.log(`safety wording ${sourceKey} not published: preflight_owner_mismatch`);
          return;
        }
        ({ message: posted } = await runtime.authority.appendMessage({
          conversationRef: ref,
          key: sourceKey,
          author: { kind: 'bot', botRef: detail.safe.botRef },
          visibility: 'public',
          text: detail.safe.text,
        }));
      }
      await this.record(tenantId, runtime, conversationId, sourceKey, posted, facts);
    } catch (error) {
      // No longer in flight: the next attempt looks the message up by its key, and posts it only
      // if Chatwoot does not have it.
      await this.tx(tenantId, (tx) =>
        tx
          .update(schema.publications)
          .set({ state: 'unknown', updatedAt: new Date(now.getTime() - IN_FLIGHT_MS) })
          .where(
            and(
              eq(schema.publications.sourceKey, sourceKey),
              inArray(schema.publications.state, ['reserved', 'unknown']),
            ),
          ),
      );
      throw error;
    }
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
    // Suggestions spend tokens too: none once the plan or budget is used up.
    if (!(await this.entitlements.aiAllowance(tenantId)).allowed) {
      await this.tx(tenantId, (tx) =>
        this.runs.finish(tx, run.id, { outcome: 'skipped', state: 'skipped' }),
      );
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
    personalContext: string[],
    liveData: ModuleDataClass[],
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
      promptVersion:
        promptVersion(agent.config, context.brandName, options) +
        (options.checks?.cacheScope ?? ''),
      language: options.language,
      history: history.messages,
      question,
      personalContext,
      subjectId: context.control.principalId,
      dataClasses: liveData,
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
            ? { outcome: 'hit', fingerprint: found.fingerprint, scope: found.scope }
            : {
                outcome: found.status,
                ...(found.kind === 'skip'
                  ? {
                      reason: found.reason,
                      ...(found.rule ? { rule: found.rule, detail: found.detail ?? null } : {}),
                    }
                  : { scope: found.scope }),
              },
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
    recalled?: RecalledMemory[],
    tools?: RunTools | null,
    outcome?: GenerateOutcome,
  ): Promise<Generated | null> {
    const runtime = await this.registry.get(tenantId, context.control.connectionId);
    const { messages: history, view } =
      fetched ?? (await this.history(tenantId, runtime, context.control));
    const config: AgentConfig = agent.config;
    const messages = historyMessages(history, config.limits.historyMessages);
    const assist = config.mode === 'assist';
    const retrieved = await this.retrieve(tenantId, runId, context, config, history);
    // Passages that do not help are dropped before the model sees them (live check only).
    const passages =
      (await options.checks?.passages({
        messages: history,
        passages: retrieved,
        language: options.language,
      })) ?? retrieved;
    // Customer memory (G19): only with the customer's consent, in scope and currently valid.
    const memories =
      recalled ??
      (await this.memory.recall(tenantId, {
        runId,
        control: context.control,
        config,
        history,
      }));
    const base =
      systemPrompt(config, context.brandName, passages, options) +
      (memories.length ? `\n\n${memoryBlock(memories)}` : '') +
      (assist
        ? '\n\nYou are writing a suggested reply for a support agent to review. Write only the reply.'
        : '');
    let correction: string | null = null;
    let deadlineAt: number | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const system = correction ? `${base}\n\n${correction}` : base;
      const generated = await this.callModels(
        tenantId,
        runId,
        config,
        system,
        messages,
        {
          view,
          ...(options.language ? { language: options.language } : {}),
          ...(options.languageSource ? { languageSource: options.languageSource } : {}),
        },
        tools,
        deadlineAt,
      );
      const cited = applyCitations(generated.text, passages, (p) => p.documentId);
      const remembered = citeMemories(cited.text, memories);
      const result: Generated = {
        ...generated,
        text: remembered.text,
        memories: remembered.memories,
        liveData: [],
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
      if (!verdict.ok) {
        correction = CORRECTION;
        continue;
      }
      // X10: "paid" or "refunded" only with a provider receipt in this conversation.
      const claims = await this.tx(tenantId, (tx) =>
        checkReplyClaims(tx, context.control.id, result.text),
      );
      if (claims.claimed.length > 0) {
        await this.tx(tenantId, (tx) =>
          this.runs.step(tx, tenantId, runId, {
            kind: 'guard',
            name: 'receipt_claims',
            status: claims.verdict.ok ? 'ok' : 'blocked',
            outputHash: sha256(result.text),
            detail: { claims: claims.claimed },
          }),
        );
      }
      if (!claims.verdict.ok) {
        correction = CLAIM_CORRECTION;
        continue;
      }
      // G14: "changed", "done" or "checked" only with a receipt for an action in this
      // conversation and nothing still pending; a knowledge search counts as checking.
      const actionClaims = findActionClaims(result.text);
      if (actionClaims.length > 0) {
        const evidence = await this.toolGateway.evidence(tenantId, context.control.id);
        const verdict = checkActionClaims(result.text, {
          ...evidence,
          completedLookups: evidence.completedLookups + (passages.length > 0 ? 1 : 0),
        });
        await this.tx(tenantId, (tx) =>
          this.runs.step(tx, tenantId, runId, {
            kind: 'guard',
            name: 'action_claims',
            status: verdict.ok ? 'ok' : 'blocked',
            outputHash: sha256(result.text),
            detail: {
              claims: actionClaims.map((c) => c.claim),
              rules: actionClaims.map((c) => c.rule),
              ...evidence,
            },
          }),
        );
        if (!verdict.ok) {
          correction = ACTION_CLAIM_CORRECTION;
          continue;
        }
      }
      if (!result.text) throw new EmptyReplyError('The model returned no text.');
      // Before publication: each sentence that cites a passage, against that passage. The model's
      // own text is read, so its citation numbers still point at the passages it saw.
      const checked = await options.checks?.reply({
        text: generated.text,
        passages,
        language: options.language,
        attempt,
        lastAttempt: attempt === 1,
      });
      if (checked?.action === 'regenerate') {
        correction = checked.correction;
        deadlineAt = checked.deadlineAt;
        continue;
      }
      if (checked?.action === 'handoff') {
        if (outcome) outcome.blocked = { note: checked.note };
        return null;
      }
      if (outcome && checked) outcome.cacheable = checked.cacheable;
      return { ...result, liveData: claimedLiveData(claims.claimed) };
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
    tools?: RunTools | null,
    /** A draft written again after a check must still finish within the run's time limit. */
    deadlineAt?: number,
  ): Promise<Generated> {
    const choices: ModelChoice[] = [config.model, ...config.fallbackModels];
    const inputHash = sha256(canonicalize({ system, messages }) ?? '');
    let lastError: unknown;
    for (const [index, choice] of choices.entries()) {
      const started = Date.now();
      try {
        const resolved = await this.models.resolve(tenantId, choice);
        const timeout = AbortSignal.timeout(
          deadlineAt === undefined
            ? config.limits.timeoutMs
            : Math.max(1, Math.min(config.limits.timeoutMs, deadlineAt - Date.now())),
        );
        const result = await generateText({
          model: resolved.model,
          instructions: system,
          messages,
          ...(tools ? { tools: tools.tools as ToolSet } : {}),
          maxOutputTokens: config.limits.maxOutputTokens,
          stopWhen: isStepCount(config.limits.maxSteps),
          maxRetries: 0,
          abortSignal: tools ? AbortSignal.any([timeout, tools.signal]) : timeout,
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
          liveData: [],
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
              ...(tools ? { steps: result.steps.length, toolCalls: tools.calls } : {}),
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
            detail: {
              errorKind: tools?.signal.aborted ? 'stopped' : failure.kind,
              index,
            },
          }),
        );
        // A stopped run is not retried on another model.
        if (tools?.signal.aborted || !FALLBACK_KINDS.has(failure.kind)) throw error;
      }
    }
    throw lastError;
  }

  private async finishWithUsage(
    tx: TenantTx,
    tenantId: string,
    runId: string,
    outcome: RunOutcome,
    telemetry: Omit<Generated, 'text' | 'sources' | 'refs' | 'memories' | 'liveData'>,
  ) {
    await this.runs.finish(tx, runId, { outcome, ...telemetry });
    const now = this.clock();
    const entries = [
      ['ai.tokens.input', telemetry.inputTokens, 'token'],
      ['ai.tokens.output', telemetry.outputTokens, 'token'],
      // Each reply the customer received counts against the plan's AI replies (A08).
      ['ai.replies', outcome === 'replied' ? 1 : null, 'reply'],
    ] as const;
    for (const [meter, quantity, unit] of entries) {
      if (quantity === null) continue;
      await tx
        .insert(schema.usageEntries)
        .values({
          tenantId,
          meter,
          quantity,
          unit,
          occurredAt: now,
          dedupeKey: `run:${runId}:${meter}`,
          sourceRef: toPublicId('run', runId),
        })
        .onConflictDoNothing();
    }
  }

  /**
   * Hands an AI-owned conversation to people, unless someone already took it. The handoff note is
   * the handoff packet (G10): why, what the AI did, what is still pending and the customer facts
   * it relied on, from Hamnivo's records; the packet is kept for the inbox.
   */
  private async handOff(
    tenantId: string,
    control: ControlRow,
    runId: string,
    epoch: number,
    reason: AiHandoffReason,
    errorKind?: string,
    handoff: { request?: string | null; language?: string | null } = {},
    /** A note that says more than the reason's own (a check that held the reply back). */
    note?: string,
  ): Promise<number | null> {
    let done: { journal: JournalEntry[]; epoch: number };
    try {
      done = await this.tx(tenantId, (tx) =>
        this.handOffIn(tx, { tenantId, control, runId, epoch, reason, errorKind, handoff, note }),
      );
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'OWNERSHIP_CHANGED')) throw error;
      await this.tx(tenantId, (tx) => this.runs.finish(tx, runId, { outcome: 'fenced' }));
      return null;
    }
    await this.journal.notify(tenantId, control.id, done.journal);
    this.logger.log(`conversation ${control.id} handed to people: ${reason}`);
    return done.epoch;
  }

  /**
   * The hand-off itself, inside the caller's transaction: the packet, the move to the queue (fenced
   * by the epoch the caller saw), the stored packet and the run's end. Returns the epoch the
   * hand-off made. A safety wording is reserved in this same transaction (`reserveSafeReply`).
   */
  private async handOffIn(
    tx: TenantTx,
    input: HandOffInput,
  ): Promise<{ journal: JournalEntry[]; epoch: number }> {
    const { tenantId, control, runId, epoch, reason, errorKind, handoff, note } = input;
    const outcome: RunOutcome = reason === 'ai_blocked' ? 'blocked' : 'handoff';
    const packet = await this.handoffs.build(tx, {
      control,
      runId,
      reason,
      reasonText: note ?? HANDOFF_NOTES[reason],
      request: handoff.request?.trim() || null,
      replyLanguage: handoff.language ?? null,
    });
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
        handoffNote: this.handoffs.note(packet),
      },
    );
    if (result.changed) {
      await this.handoffs.record(
        tx,
        {
          tenantId,
          conversationId: control.id,
          epoch: result.control.ownershipEpoch,
          runId,
        },
        packet,
      );
    }
    await this.runs.finish(tx, runId, {
      outcome,
      state: reason === 'ai_unavailable' ? 'failed' : 'succeeded',
      ...(errorKind ? { errorKind } : {}),
    });
    return { journal: result.journal, epoch: result.control.ownershipEpoch };
  }

  /** A run a person stopped (Cancel run), or one whose conversation someone else took. */
  private async stopped(tenantId: string, runId: string, tools: RunTools) {
    const cancelled = tools.signal.reason === 'cancel_requested';
    await this.tx(tenantId, async (tx) => {
      await this.runs.step(tx, tenantId, runId, {
        kind: 'decision',
        name: 'stopped',
        status: 'ok',
        detail: {
          reason: cancelled ? 'cancel_requested' : 'owner_changed',
          toolCalls: tools.calls,
        },
      });
      await this.runs.finish(
        tx,
        runId,
        cancelled ? { outcome: 'cancelled', state: 'skipped' } : { outcome: 'fenced' },
      );
    });
  }

  /** Ends a run a person asked to stop before its reply is posted. */
  private async cancelRequested(
    tenantId: string,
    runId: string,
    telemetry: Omit<Parameters<RunsService['finish']>[2], 'outcome' | 'state'>,
  ): Promise<boolean> {
    return this.tx(tenantId, async (tx) => {
      const [row] = await tx
        .select({ at: schema.runs.cancelRequestedAt })
        .from(schema.runs)
        .where(eq(schema.runs.id, runId));
      if (!row?.at) return false;
      await this.runs.step(tx, tenantId, runId, {
        kind: 'decision',
        name: 'stopped',
        status: 'ok',
        detail: { reason: 'cancel_requested', toolCalls: 0 },
      });
      await this.runs.finish(tx, runId, { outcome: 'cancelled', state: 'skipped', ...telemetry });
      return true;
    });
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
