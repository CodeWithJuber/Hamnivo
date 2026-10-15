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
import { storeAiDraft } from '../inbox/ai-drafts.js';
import { type Passage, RetrievalService } from '../knowledge/retrieval.service.js';
import { LanguageService } from '../language/language.service.js';
import { citeMemories, memoryBlock } from '../memory/prompt.js';
import { MemoryRecallService, type RecalledMemory } from '../memory/recall.service.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { AuthorityContactsService } from '../widget/contacts.service.js';
import { type ActiveAgent, AgentsService } from './agents.service.js';
import {
  type AiHandoffReason,
  HANDOFF_NOTES,
  type UrgentOutcome,
  urgentNote,
} from './handoff-notes.js';
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

/** The conversation as it stood at one of the customer's messages: nothing that came after it. */
function endingAt(messages: AuthorityMessage[], ref: number): AuthorityMessage[] {
  return messages.filter((m) => Number(m.ref) <= ref);
}

/** Whether a message the customer can see came from the team or a bot, not from them. */
function saidToCustomer(message: AuthorityMessage): boolean {
  return !message.private && (message.direction === 'outgoing' || message.direction === 'template');
}

/** Whether a safety limit's mark is still in force at `now`. */
function within(at: Date | null, ms: number, now: Date): boolean {
  return at !== null && now.getTime() - at.getTime() < ms;
}

/** The key of a customer message's publication in Chatwoot: one per message, wording or reply. */
function publicationKey(payload: CustomerMessageEvent): string {
  return `hv1:p:${uuidV5(payload.conversationId, `reply:${payload.ledgerId}`)}`;
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
type AbortReason =
  | 'owner_changed'
  | 'preflight_owner_mismatch'
  | 'not_ai_owned'
  /** A safety wording went out in the last 24 hours, so none goes out now. */
  | 'wording_limited'
  /** Someone said something to the customer since their message, so the wording stays unsaid. */
  | 'already_replied';

/** The outbox topic that posts a reserved safety wording, at least once. */
export const SAFE_REPLY_TOPIC = 'conversation.safe_reply';

/**
 * The outbox topic of the delayed safety wording for a conversation a person has: it posts only
 * if nobody has replied to the customer by then (`onSafeReplyFallback`).
 */
export const SAFE_REPLY_FALLBACK_TOPIC = 'conversation.safe_reply_fallback';

/** A safety wording claimed this recently is assumed to be still in flight. */
const IN_FLIGHT_MS = 30_000;

/** How long a person who has the conversation has to reply before Hamnivo sends the wording. */
const STAFF_FALLBACK_MS = 120_000;

/** At most one urgent note per conversation in this time, where people have the conversation. */
const ALERT_EVERY_MS = 10 * 60_000;

/** At most one automatic safety wording per conversation in this time, on every path. */
const WORDING_EVERY_MS = 24 * 60 * 60_000;

/** The guard's time to answer when there is no agent whose run limit could give it one. */
const GUARD_DEADLINE_MS = 1_500;

type UrgentVerdict = Extract<InboundVerdict, { action: 'urgent' }>;

/** The owner modes in which nobody has the conversation. */
type QueueMode = 'WAITING_HUMAN' | 'PAUSED';

/**
 * When a reserved safety wording may still be posted. `queue`: nobody else is speaking, so only in
 * the owner mode and at the epoch it was reserved under, never in a person's turn or the AI's.
 * `person`: a person has the conversation and the wording is for their silence, so it is posted
 * unless the AI has the conversation or anyone has said something to the customer since their
 * message `afterMessage`.
 */
type SafeFence = { kind: 'queue'; ownerMode: QueueMode } | { kind: 'person'; afterMessage: number };

/**
 * What the publications ledger keeps of a safety wording, so that every retry posts the same
 * words, as the same bot, without asking a model or Jev again. A wording reserved before fences
 * were kept has none: it is the queue fence of WAITING_HUMAN, as it always was.
 */
interface SafeReplyDetail extends PublicationFacts {
  safe: { text: string; botRef: string; fence?: SafeFence };
}

/** What the delayed `conversation.safe_reply_fallback` event carries: the words people were shown. */
interface SafeFallbackEvent {
  conversationId: string;
  sourceKey: string;
  /** The customer's message in Chatwoot; nobody may have said anything to them since. */
  afterMessage: number;
  text: string;
  botRef: string;
  displayName: string;
}

/** What the guard did for someone at risk in a conversation the AI does not have (labels only). */
type Alerted = {
  /** Who had the conversation when this was decided. */
  holder: 'nobody' | 'person' | 'ai';
  /** `limited`: an urgent note went out in the last 10 minutes. */
  note: 'sent' | 'limited';
  /**
   * `now`: reserved, posted at once. `later`: the delayed event sends it if nobody has replied.
   * `held`: one went out in the last 24 hours. `none`: the AI has the conversation, or no bot is
   * set up.
   */
  wording: 'now' | 'later' | 'held' | 'none';
};

/**
 * Someone may be at risk: what the reply job needs to put the safety wording out (J04). Either
 * the AI still has the conversation, and the packet for the hand-off is made from `handoff`, or
 * people have it already (the customer asked for a person) and `handedOffAt` is the epoch their
 * hand-off made: the wording then follows it while nobody has answered.
 */
type SafeReplyInput = {
  tenantId: string;
  control: ControlRow;
  /** The name the wording shows under: the agent's, or the brand's when there is no agent. */
  displayName: string;
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
 * the guard then adds the wording and an urgent note, and so it does when the AI cannot answer
 * (no agent, assist mode, a kill switch). The wording is reserved in the transaction that hands
 * the conversation to people, and the outbox posts it (`conversation.safe_reply`) at least once:
 * a worker that stops in between loses neither the hand-off nor the wording.
 *
 * Every customer message is screened in every ownership state. Where people have the conversation
 * or wait for it, the guard runs before any suggestion (`guardPeople`) and Hamnivo speaks only
 * when nobody else is speaking: never over a person or the AI. One automatic wording per
 * conversation in 24 hours, on every path.
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
      return;
    }
    // People have the conversation, or are waiting to. The customer's message is still read for
    // risk, before any suggestion is written. This runs here, in the worker, after the message was
    // committed: screening never delays its delivery.
    await this.guardPeople(event, payload, context);
    if (context.agent?.config.mode === 'assist' && !context.stopped) {
      await this.suggest(event, payload, context);
    }
  }

  private async reply(event: ClaimedOutboxEvent, payload: CustomerMessageEvent, context: Context) {
    const tenantId = event.tenantId;
    const { control, agent } = context;
    const sourceKey = publicationKey(payload);
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
    // The AI cannot answer, so people have the conversation. Someone at risk is still looked for
    // once that hand-off is committed, and still gets the safety wording and an urgent note.
    const handOffAndGuard = async (reason: 'no_agent' | 'assist_mode' | 'ai_stopped') => {
      const handedOffAt = await this.handOff(tenantId, control, run.id, payload.epoch, reason);
      if (handedOffAt === null) return;
      await this.guardAfterHandoff({
        tenantId,
        context,
        runId: run.id,
        payload,
        sourceKey,
        botRef: String(bot.externalBotId),
        history: () => this.history(tenantId, runtime, control),
        handedOffAt,
      });
    };
    if (agent?.config.mode !== 'answer') {
      await handOffAndGuard(agent ? 'assist_mode' : 'no_agent');
      return;
    }
    if (context.stopped) {
      // A kill switch stops what a model says. The safety wording is fixed text, not model output,
      // so it still goes out to someone at risk.
      await handOffAndGuard('ai_stopped');
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
          context,
          runId: run.id,
          payload,
          sourceKey,
          botRef: String(bot.externalBotId),
          history: async () => history,
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
        displayName: agent.config.displayName,
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
   * After people were given a conversation the AI had (the customer asked for a person, or the AI
   * cannot answer: no agent, assist mode, a kill switch): whether the customer also writes of
   * hurting themselves, or of danger now (message guard). Jev only adds here: the hand-off is
   * committed before anything asks it, and nothing it says, or fails to say, changes that. With
   * Jev down, or no message guard set for the brand, the hand-off stands as it is.
   */
  private async guardAfterHandoff(input: {
    tenantId: string;
    context: Context;
    runId: string;
    payload: CustomerMessageEvent;
    sourceKey: string;
    botRef: string;
    /** The conversation so far, read only once the brand is known to have a message guard. */
    history: () => Promise<{ messages: AuthorityMessage[] }>;
    handedOffAt: number;
  }): Promise<void> {
    const { tenantId, context } = input;
    const { control, agent } = context;
    try {
      // No message guard for the brand: nothing to read, not even the conversation.
      if (!(await this.checks.hasMessageGuard(tenantId, control.brandId))) return;
      const history = await input.history();
      // The guard's time starts here, not before the conversation was read.
      const checks = await this.checks.forRun({
        tenantId,
        brandId: control.brandId,
        conversationId: control.id,
        runId: input.runId,
        // Without an agent there is no run limit to borrow: the guard has its own.
        budgetMs: agent?.config.limits.timeoutMs ?? GUARD_DEADLINE_MS,
      });
      if (!checks?.setting('message-guard')) return;
      const chosen = await this.language.forReply(
        tenantId,
        control.principalId,
        latestCustomerText(history.messages),
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
        displayName: agent?.config.displayName ?? context.brandName,
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
    if (reserved.handedOff) {
      this.logger.log(`conversation ${control.id} handed to people: ${input.urgent.reason}`);
    }
    if (reserved.reason) {
      this.logger.log(`safety wording for ${control.id} not published: ${reserved.reason}`);
      return;
    }
    // Now, without waiting for the relay; if this fails, the outbox event posts it.
    await this.publishSafeReply(tenantId, control.id, sourceKey).catch((error: unknown) =>
      this.logger.warn(`safety wording ${sourceKey} not posted yet, the outbox will: ${error}`),
    );
  }

  /**
   * The one transaction behind a safety wording. The AI still has the conversation: it goes to
   * people here, with the urgent note. People have it already (they were asked for first, or the
   * AI could not answer): the urgent note is queued for them, whatever happened since, and the
   * wording follows only while nobody has answered. The wording's publication is reserved under
   * the epoch the hand-off made, and the outbox event that posts it is queued with it.
   *
   * One automatic wording per conversation in 24 hours, whoever asks for it: when one went out,
   * the hand-off and the note still happen, and the note says why there is no wording. The marks
   * of both limits are set under the control row's lock, in this transaction, with what they
   * stand for.
   */
  private async reserveSafeReply(
    tx: TenantTx,
    input: SafeReplyInput,
  ): Promise<{ reason: AbortReason | null; journal: JournalEntry[]; handedOff: boolean }> {
    const { tenantId, control, payload, urgent } = input;
    const locked = await this.ownership.lock(tx, control.id);
    const now = this.clock();
    const held = within(locked.safetyWordedAt, WORDING_EVERY_MS, now);
    let epoch = payload.epoch;
    let reason: AbortReason | null;
    let journal: JournalEntry[] = [];
    let handedOff = false;
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
          note: urgentNote(held ? 'held' : 'ai_sent', urgent.reasons),
        });
        epoch = handed.epoch;
        journal = handed.journal;
        handedOff = true;
        reason = held ? 'wording_limited' : null;
      }
    } else {
      epoch = input.handedOffAt;
      reason =
        locked.ownerMode !== 'WAITING_HUMAN' || locked.ownershipEpoch !== epoch
          ? 'owner_changed'
          : held
            ? 'wording_limited'
            : null;
      await this.queueNote(
        tx,
        tenantId,
        locked.id,
        `hv1:n:${uuidV5(locked.id, `urgent:${payload.ledgerId}`)}`,
        urgentNote(
          reason === 'owner_changed' ? 'changed_hands' : held ? 'held' : 'ai_sent',
          urgent.reasons,
        ),
      );
    }
    // The urgent note went to people with the hand-off, or was queued just above.
    if (handedOff || input.handedOffAt !== undefined) {
      await tx
        .update(schema.conversationControls)
        .set({ safetyAlertedAt: now, ...(reason ? {} : { safetyWordedAt: now }) })
        .where(eq(schema.conversationControls.id, locked.id));
    }
    const written = await this.reserveWording(tx, {
      tenantId,
      conversationId: locked.id,
      sourceKey: input.sourceKey,
      epoch,
      text: urgent.text,
      reason,
      currentEpoch: handedOff ? epoch : locked.ownershipEpoch,
      detail: {
        sources: [],
        displayName: input.displayName,
        safe: {
          text: urgent.text,
          botRef: input.botRef,
          fence: { kind: 'queue', ownerMode: 'WAITING_HUMAN' },
        },
      },
    });
    if (written && !reason) await this.queueSafeReply(tx, tenantId, locked.id, input.sourceKey);
    return { reason, journal, handedOff };
  }

  /**
   * Records a safety wording's publication, unless a reply or wording is already out for this
   * message. With a `reason` it records that nothing will be posted. Returns whether a row was
   * written.
   */
  private async reserveWording(
    tx: TenantTx,
    input: {
      tenantId: string;
      conversationId: string;
      sourceKey: string;
      epoch: number;
      text: string;
      reason: AbortReason | null;
      currentEpoch: number;
      detail: SafeReplyDetail;
    },
  ): Promise<boolean> {
    const values = {
      epoch: input.epoch,
      contentHash: sha256(input.text),
      state: input.reason ? ('aborted' as const) : ('reserved' as const),
      detail: input.reason
        ? { reason: input.reason, currentEpoch: input.currentEpoch }
        : input.detail,
    };
    const insert = tx.insert(schema.publications).values({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      sourceKey: input.sourceKey,
      ...values,
    });
    const returning = { id: schema.publications.id };
    const rows =
      input.reason === 'wording_limited'
        ? // The limit may be held by this message's own wording, reserved by an earlier attempt:
          // that one stays as it is.
          await insert.onConflictDoNothing().returning(returning)
        : await insert
            .onConflictDoUpdate({
              target: schema.publications.sourceKey,
              set: { ...values, updatedAt: this.clock() },
              // A reply or wording already out for this message stays as it is.
              setWhere: inArray(schema.publications.state, ['reserved', 'unknown']),
            })
            .returning(returning);
    return rows.length > 0;
  }

  /** Queues the outbox event that posts a reserved safety wording, at least once. */
  private queueSafeReply(
    tx: TenantTx,
    tenantId: string,
    conversationId: string,
    sourceKey: string,
  ): Promise<void> {
    return enqueueOutbox(tx, tenantId, {
      topic: SAFE_REPLY_TOPIC,
      aggregateType: 'conversation',
      aggregateId: conversationId,
      payload: { conversationId, sourceKey },
    });
  }

  /** Queues a private note for people; the outbox posts it once, by its key. */
  private queueNote(
    tx: TenantTx,
    tenantId: string,
    conversationId: string,
    key: string,
    text: string,
  ): Promise<void> {
    return enqueueOutbox(tx, tenantId, {
      topic: 'conversation.note',
      aggregateType: 'conversation',
      aggregateId: conversationId,
      payload: { conversationId, key, text },
    });
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
   * Posts a reserved safety wording as the bot that was to speak, and records it. It goes out
   * only under the fence it was reserved with (`SafeFence`), so it is never said over a person or
   * the AI: while nobody else speaks, that is, in the owner mode and at the epoch it was reserved
   * under (WAITING_HUMAN or PAUSED); or, for the wording that waits for a person's silence, while
   * the AI does not have the conversation and nobody has replied to the customer. Chatwoot is
   * asked once more right before the post. Safe to run more than once, and from more than one
   * worker: a claim keeps a second copy from being posted, and a retry looks for the first copy
   * by its key before it posts.
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
      const safe = (publication.detail as Partial<SafeReplyDetail>).safe;
      if (!safe) return { kind: 'done' as const };
      const fence: SafeFence = safe.fence ?? { kind: 'queue', ownerMode: 'WAITING_HUMAN' };
      const open =
        fence.kind === 'queue'
          ? control.ownerMode === fence.ownerMode && control.ownershipEpoch === publication.epoch
          : control.ownerMode !== 'AI_ACTIVE';
      if (!open) {
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
        fence,
        lookup: publication.state !== 'reserved' || attempt > 1,
      };
    });
    if (claimed.kind === 'done') return;
    if (claimed.kind === 'aborted') {
      this.logger.log(`safety wording ${sourceKey} not published: ${claimed.reason}`);
      return;
    }
    if (claimed.kind === 'busy') throw new Error(`safety wording ${sourceKey} is being posted`);
    const { control, publication, fence } = claimed;
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
        const stop = await this.postBlock(runtime, ref, fence, sourceKey);
        if (stop) {
          await this.tx(tenantId, (tx) =>
            tx
              .update(schema.publications)
              .set({
                state: 'aborted',
                detail: { reason: stop.reason, ...stop.detail },
                updatedAt: this.clock(),
              })
              .where(
                and(
                  eq(schema.publications.sourceKey, sourceKey),
                  inArray(schema.publications.state, ['reserved', 'unknown']),
                ),
              ),
          );
          this.logger.log(`safety wording ${sourceKey} not published: ${stop.reason}`);
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

  /**
   * Why a safety wording must not be posted now, read from Chatwoot right before the post; null
   * when it may. Queue fence: a person already on it in Chatwoot, not yet seen here, must not be
   * talked over. Person fence: nobody, staff or bot, may have said anything the customer can see
   * since their message (private notes and activity do not count). A reply that lands between this
   * read and the post is an accepted race: the customer then hears twice, never not at all.
   */
  private async postBlock(
    runtime: ConnectionRuntime,
    ref: string,
    fence: SafeFence,
    sourceKey: string,
  ): Promise<{ reason: AbortReason; detail: Record<string, unknown> } | null> {
    if (fence.kind === 'queue') {
      const state = await runtime.authority.getState(ref);
      return state.owner.kind === 'user'
        ? { reason: 'preflight_owner_mismatch', detail: { authorityOwner: state.owner } }
        : null;
    }
    return (await this.saidSince(runtime, ref, fence.afterMessage, sourceKey))
      ? { reason: 'already_replied', detail: {} }
      : null;
  }

  /**
   * Whether anyone, staff or a bot, has said something the customer can see since their message.
   * Read from Chatwoot, where a person may have replied without Hamnivo knowing yet. The wording's
   * own message, from an earlier attempt, is not counted.
   */
  private async saidSince(
    runtime: ConnectionRuntime,
    ref: string,
    afterMessage: number,
    ownKey: string,
  ): Promise<boolean> {
    const later = await runtime.authority.listMessages(ref, {
      view: 'staff',
      after: String(afterMessage),
    });
    return later.some((m) => saidToCustomer(m) && m.key !== ownKey);
  }

  /**
   * Message guard for a conversation the AI does not have: people do, or are waiting to. Nothing
   * here answers the customer's question; the message is still read for risk, in every ownership
   * state, and Hamnivo speaks only when nobody else is speaking. Live, when someone may be at risk
   * (self-harm, or danger now):
   * - nobody is assigned: people get an urgent note and the customer gets the safety wording, at
   *   once;
   * - a person is assigned: they get the urgent note now, with the words for the customer so they
   *   can send them first, and if nobody has replied after `STAFF_FALLBACK_MS`, Hamnivo sends
   *   them itself (`onSafeReplyFallback`).
   * Shadow mode only records. It catches and logs its own errors: it never fails the job, and
   * never holds up the suggestion that may follow.
   */
  private async guardPeople(
    event: ClaimedOutboxEvent,
    payload: CustomerMessageEvent,
    context: Context,
  ): Promise<void> {
    const tenantId = event.tenantId;
    const { control, agent } = context;
    let runId: string | null = null;
    try {
      // No message guard for the brand: nothing to read, not even the conversation.
      if (!(await this.checks.hasMessageGuard(tenantId, control.brandId))) return;
      const run = await this.tx(tenantId, (tx) =>
        this.runs.start(tx, {
          tenantId,
          conversationId: control.id,
          brandId: control.brandId,
          agentId: agent?.profile.id ?? null,
          agentVersionId: agent?.version.id ?? null,
          triggerRef: `guard:${payload.ledgerId}`,
          kind: 'guard',
          epoch: payload.epoch,
        }),
      );
      runId = run.id;
      // An earlier attempt did it all.
      if (run.state === 'succeeded' || run.state === 'skipped') return;
      await this.screenForPeople(tenantId, payload, context, run.id);
    } catch (error) {
      this.logger.error(`message guard for ${control.id} failed: ${String(error)}`);
      const failed = runId;
      if (failed) {
        await this.tx(tenantId, (tx) =>
          this.runs.finish(tx, failed, { outcome: 'error', errorKind: 'guard_failed' }),
        ).catch(() => undefined);
      }
    }
  }

  private async screenForPeople(
    tenantId: string,
    payload: CustomerMessageEvent,
    context: Context,
    runId: string,
  ): Promise<void> {
    const { control, agent } = context;
    const skipped = () =>
      this.tx(tenantId, (tx) =>
        this.runs.finish(tx, runId, { outcome: 'skipped', state: 'skipped' }),
      );
    const [ledger] = await this.tx(tenantId, (tx) =>
      tx
        .select({ ref: schema.messageLedger.authorityMessageId })
        .from(schema.messageLedger)
        .where(eq(schema.messageLedger.id, payload.ledgerId)),
    );
    const own = ledger?.ref ?? null;
    if (own === null) return skipped();
    const runtime = await this.registry.get(tenantId, control.connectionId);
    const history = await this.history(tenantId, runtime, control);
    // The guard's time starts here, not before the conversation was read.
    const checks = await this.checks.forRun({
      tenantId,
      brandId: control.brandId,
      conversationId: control.id,
      runId,
      budgetMs: agent?.config.limits.timeoutMs ?? GUARD_DEADLINE_MS,
    });
    if (!checks?.setting('message-guard')) return skipped();
    // The window that ends at this job's own message. A job is never skipped for a newer message
    // (the AI's is): in a burst longer than the window, each message is the last of one, so none
    // is pushed out of every window.
    const messages = endingAt(history.messages, own);
    const chosen = await this.language.forReply(
      tenantId,
      control.principalId,
      latestCustomerText(messages),
      checks.languageDecider(),
    );
    const verdict = await checks.inboundGuard({
      messages,
      language: chosen.detection.language ?? chosen.resolution.language,
      replyLanguage: chosen.resolution.language,
    });
    if (verdict.action !== 'urgent') return skipped();
    const sourceKey = publicationKey(payload);
    const alerted = await this.tx(tenantId, async (tx) => {
      const done = await this.reserveAlert(tx, {
        tenantId,
        control,
        payload,
        urgent: verdict,
        sourceKey,
        displayName: agent?.config.displayName ?? context.brandName,
        botRef: runtime.primaryBot ? String(runtime.primaryBot.externalBotId) : null,
        message: own,
      });
      await this.runs.step(tx, tenantId, runId, {
        kind: 'decision',
        name: 'safety_alert',
        status: 'ok',
        detail: { ...done },
      });
      const acted = done.note === 'sent' || done.wording === 'now' || done.wording === 'later';
      await this.runs.finish(
        tx,
        runId,
        acted ? { outcome: 'handoff' } : { outcome: 'skipped', state: 'skipped' },
      );
      return done;
    });
    this.logger.log(
      `message guard in ${control.id}: urgent note ${alerted.note}, wording ${alerted.wording}`,
    );
    // Now, without waiting for the relay; if this fails, the outbox event posts it.
    if (alerted.wording === 'now') {
      await this.publishSafeReply(tenantId, control.id, sourceKey).catch((error: unknown) =>
        this.logger.warn(`safety wording ${sourceKey} not posted yet, the outbox will: ${error}`),
      );
    }
  }

  /**
   * The one transaction behind an urgent alert in a conversation the AI does not have. Who has the
   * conversation is read from the locked row, not from when the message arrived:
   * - nobody: the note is queued and the wording reserved, to be posted at once;
   * - a person: the note is queued with the words for the customer, and the delayed event that
   *   sends them if nobody has replied;
   * - the AI again (it was handed back meanwhile): the note only, never wording over its turn.
   * The two limits are independent. A note goes out at most once in 10 minutes (it only keeps
   * people from being told again and again); the wording at most once in 24 hours, and then the
   * note says there is none. The marks are set under the lock, with what they stand for.
   */
  private async reserveAlert(
    tx: TenantTx,
    input: {
      tenantId: string;
      control: ControlRow;
      payload: CustomerMessageEvent;
      urgent: UrgentVerdict;
      sourceKey: string;
      displayName: string;
      /** The bot that speaks for the brand; null when none is set up. */
      botRef: string | null;
      /** The customer's message in Chatwoot. */
      message: number;
    },
  ): Promise<Alerted> {
    const { tenantId, payload, urgent } = input;
    const locked = await this.ownership.lock(tx, input.control.id);
    const now = this.clock();
    const holder: Alerted['holder'] =
      locked.ownerMode === 'AI_ACTIVE'
        ? 'ai'
        : locked.ownerStaffId !== null || locked.ownerExternalUserId !== null
          ? 'person'
          : 'nobody';
    const noteDue = !within(locked.safetyAlertedAt, ALERT_EVERY_MS, now);
    const marks: { safetyAlertedAt?: Date; safetyWordedAt?: Date } = {};
    // Wording is never said over the AI's turn, and needs a bot to say it as.
    const botRef = input.botRef;
    const canSpeak = holder !== 'ai' && botRef !== null;
    let wording: Alerted['wording'] = !canSpeak
      ? 'none'
      : within(locked.safetyWordedAt, WORDING_EVERY_MS, now)
        ? 'held'
        : holder === 'nobody'
          ? 'now'
          : 'later';
    if (canSpeak && wording === 'now') {
      const written = await this.reserveWording(tx, {
        tenantId,
        conversationId: locked.id,
        sourceKey: input.sourceKey,
        epoch: locked.ownershipEpoch,
        text: urgent.text,
        reason: null,
        currentEpoch: locked.ownershipEpoch,
        detail: {
          sources: [],
          displayName: input.displayName,
          safe: {
            text: urgent.text,
            botRef,
            fence: {
              kind: 'queue',
              ownerMode: locked.ownerMode === 'PAUSED' ? 'PAUSED' : 'WAITING_HUMAN',
            },
          },
        },
      });
      if (written) {
        await this.queueSafeReply(tx, tenantId, locked.id, input.sourceKey);
        marks.safetyWordedAt = now;
      } else {
        // A reply or wording is already out for this message: nothing more to say to the customer.
        wording = 'held';
      }
    } else if (canSpeak && wording === 'later') {
      // Reserved only if it is still needed when it is due (`onSafeReplyFallback`).
      const event: SafeFallbackEvent = {
        conversationId: locked.id,
        sourceKey: input.sourceKey,
        afterMessage: input.message,
        text: urgent.staffText,
        botRef,
        displayName: input.displayName,
      };
      await enqueueOutbox(tx, tenantId, {
        topic: SAFE_REPLY_FALLBACK_TOPIC,
        aggregateType: 'conversation',
        aggregateId: locked.id,
        payload: { ...event },
        availableAt: new Date(now.getTime() + STAFF_FALLBACK_MS),
      });
    }
    if (noteDue) {
      const outcome: UrgentOutcome =
        holder === 'ai'
          ? 'ai_again'
          : botRef === null
            ? 'no_bot'
            : wording === 'held'
              ? 'held'
              : holder === 'nobody'
                ? 'sent'
                : 'person';
      await this.queueNote(
        tx,
        tenantId,
        locked.id,
        `hv1:n:${uuidV5(locked.id, `urgent:${payload.ledgerId}`)}`,
        urgentNote(
          outcome,
          urgent.reasons,
          wording === 'later'
            ? { text: urgent.staffText, waitMinutes: STAFF_FALLBACK_MS / 60_000 }
            : undefined,
        ),
      );
      marks.safetyAlertedAt = now;
    }
    if (marks.safetyAlertedAt || marks.safetyWordedAt) {
      await tx
        .update(schema.conversationControls)
        .set(marks)
        .where(eq(schema.conversationControls.id, locked.id));
    }
    return { holder, note: noteDue ? 'sent' : 'limited', wording };
  }

  /**
   * Outbox handler for `conversation.safe_reply_fallback`, due `STAFF_FALLBACK_MS` after people
   * were told that someone may be at risk while a person had the conversation. Hamnivo sends the
   * safety wording itself only if all of these hold:
   * (a) the AI does not have the conversation;
   * (b) Chatwoot shows nothing said to the customer since their message, by staff or a bot
   *     (private notes and activity do not count);
   * (c) no automatic wording went out in the last 24 hours.
   * It reserves, claims, looks for its own copy by key on a retry and records the way a wording
   * for a waiting conversation does (`publishSafeReply`). Safe to run more than once.
   */
  async onSafeReplyFallback(event: ClaimedOutboxEvent): Promise<void> {
    const payload = event.payload as SafeFallbackEvent;
    const tenantId = event.tenantId;
    const [reserved] = await this.tx(tenantId, (tx) =>
      tx
        .select({ id: schema.publications.id })
        .from(schema.publications)
        .where(eq(schema.publications.sourceKey, payload.sourceKey)),
    );
    // An earlier attempt reserved it: finish what it started, without asking again.
    if (!reserved && !(await this.reserveFallback(tenantId, payload))) return;
    await this.publishSafeReply(
      tenantId,
      payload.conversationId,
      payload.sourceKey,
      event.attempts,
    );
  }

  /** Reserves the delayed wording when it is still needed; false when there is nothing to post. */
  private async reserveFallback(tenantId: string, payload: SafeFallbackEvent): Promise<boolean> {
    const [control] = await this.tx(tenantId, (tx) =>
      tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, payload.conversationId)),
    );
    // (a), read first so that nothing is asked of Chatwoot for a conversation the AI has again.
    if (!control || control.ownerMode === 'AI_ACTIVE') {
      this.logger.log(
        `safety wording ${payload.sourceKey} not needed: the AI has the conversation`,
      );
      return false;
    }
    // (b), before anything is reserved, so a person's reply leaves the 24-hour limit untouched.
    // The post checks again, since a retry may come later.
    const runtime = await this.registry.get(tenantId, control.connectionId);
    if (
      await this.saidSince(
        runtime,
        String(control.externalConversationId),
        payload.afterMessage,
        payload.sourceKey,
      )
    ) {
      this.logger.log(`safety wording ${payload.sourceKey} not needed: someone has replied`);
      return false;
    }
    return this.tx(tenantId, async (tx) => {
      const locked = await this.ownership.lock(tx, payload.conversationId);
      const now = this.clock();
      // (a) and (c), again under the lock that sets the mark.
      if (locked.ownerMode === 'AI_ACTIVE') {
        this.logger.log(
          `safety wording ${payload.sourceKey} not sent: the AI has the conversation`,
        );
        return false;
      }
      if (within(locked.safetyWordedAt, WORDING_EVERY_MS, now)) {
        this.logger.log(`safety wording ${payload.sourceKey} not sent: one went out in 24 hours`);
        return false;
      }
      const written = await this.reserveWording(tx, {
        tenantId,
        conversationId: locked.id,
        sourceKey: payload.sourceKey,
        epoch: locked.ownershipEpoch,
        text: payload.text,
        reason: null,
        currentEpoch: locked.ownershipEpoch,
        detail: {
          sources: [],
          displayName: payload.displayName,
          safe: {
            text: payload.text,
            botRef: payload.botRef,
            fence: { kind: 'person', afterMessage: payload.afterMessage },
          },
        },
      });
      if (!written) return false;
      await tx
        .update(schema.conversationControls)
        .set({ safetyWordedAt: now })
        .where(eq(schema.conversationControls.id, locked.id));
      return true;
    });
  }

  /**
   * Assist mode (HNV-09-05, G03): writes a reply for people to review, kept as an AI draft that
   * Studio shows above the composer. It is never sent on its own and never reaches Chatwoot; a
   * person approves, edits or rejects it. Outbox handler for `conversation.customer_message`, safe
   * to run more than once: a retry keeps the draft its run already wrote.
   */
  private async suggest(
    event: ClaimedOutboxEvent,
    payload: CustomerMessageEvent,
    context: Context,
  ) {
    const tenantId = event.tenantId;
    const { control } = context;
    const agent = context.agent as ActiveAgent;
    const runtime = await this.registry.get(tenantId, control.connectionId);
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
    // The customer wrote again: that message's own job drafts the reply with everything in view.
    if (await this.skipIfSuperseded(tenantId, run.id, payload)) return;
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
    const draft = generated;
    const telemetry = {
      provider: draft.provider,
      modelId: draft.modelId,
      inputTokens: draft.inputTokens,
      outputTokens: draft.outputTokens,
      latencyMs: draft.latencyMs,
    };
    const kept = await this.tx(tenantId, async (tx) => {
      const stored = await storeAiDraft(tx, {
        tenantId,
        conversationId: control.id,
        runId: run.id,
        agentId: agent.profile.id,
        agentVersionId: agent.version.id,
        triggerLedgerId: payload.ledgerId,
        text: draft.text,
        sources: draft.sources,
        language: chosen.resolution.language,
        now: this.clock(),
      });
      if (stored === 'not_needed') {
        // The AI took the conversation back, it was resolved or the customer wrote again.
        await this.runs.step(tx, tenantId, run.id, {
          kind: 'decision',
          name: 'draft_not_needed',
          status: 'ok',
        });
        await this.finishWithUsage(tx, tenantId, run.id, 'skipped', telemetry);
        await this.runs.finish(tx, run.id, { outcome: 'skipped', state: 'skipped' });
        return false;
      }
      await this.finishWithUsage(tx, tenantId, run.id, 'drafted', telemetry);
      return stored === 'stored';
    });
    if (kept) await this.journal.signalInbox(tenantId, control.id);
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
        // Assist drafts are written to be sent as they are (HNV-09-05): public knowledge only, so
        // every source they cite can be shown to the customer.
        audience: 'customer',
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
