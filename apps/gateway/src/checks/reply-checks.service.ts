import { type Db, toPublicId, withTenant } from '@hamnivo/db';
import {
  type AuthorityMessage,
  answerCheckCorrection,
  answerCheckRequest,
  answerCheckThresholdKey,
  answerCheckVerdict,
  answeredSlice,
  type CheckTask,
  citedClaims,
  ESCALATION_MESSAGES,
  ESCALATION_QUESTIONS,
  type EscalationReason,
  escalationVerdict,
  GUARD_MESSAGES,
  GUARD_REPLY_CHARS,
  INBOUND_GUARD_QUESTIONS,
  type InboundGuardReason,
  inboundGuardVerdict,
  LANGUAGE_CHECK_QUESTIONS,
  languageDecision,
  OUTBOUND_GUARD_QUESTIONS,
  outboundClaims,
  outboundGuardCorrection,
  PASSAGE_CHECK_CHARS,
  PASSAGE_QUESTIONS,
  passageVerdict,
  type ReplyLanguage,
  redactPersonalData,
  SAFE_REPLIES,
  SAFE_REPLIES_STAFF,
  SLICE_OF_LANGUAGE,
  unbackedClaims,
} from '@hamnivo/domain';
import { Inject, Injectable } from '@nestjs/common';
import type { LanguageDecider } from '../language/language.service.js';
import {
  type AiHandoffReason,
  CHECK_HANDOFF_NOTES,
  ESCALATION_NOTES,
  GUARD_NOTES,
  HANDOFF_NOTES,
} from '../runtime/handoff-notes.js';
import { RunsService } from '../runtime/runs.service.js';
import { APP_DB } from '../tokens.js';
import { type Asked, type CheckSetting, ChecksService } from './checks.service.js';
import { claimEvidence } from './claim-evidence.js';

/** A retrieved passage as the checks read it. */
export interface CheckedPassage {
  documentId: string;
  title: string;
  heading: string | null;
  text: string;
}

/** What to do with a draft reply after the checks before publication. */
export type ReplyVerdict =
  | {
      action: 'publish';
      /** False when a live check could not vouch for the reply: it is published, never cached. */
      cacheable: boolean;
    }
  | { action: 'regenerate'; correction: string; deadlineAt: number }
  /** Hand the conversation to people with this note (the reply was held back). */
  | { action: 'handoff'; note: string };

/** What to do before a reply is written. A check here can only add a hand-off. */
export type InboundVerdict =
  | { action: 'continue' }
  | { action: 'handoff'; reason: AiHandoffReason; note: string }
  /**
   * Someone may be at risk: Hamnivo's safe wording (no model's) goes to the customer, and people
   * are told with an urgent note. Who has the conversation decides the rest, so the caller picks
   * the wording (`staffText` for a conversation a person has: it says the team was told, not that
   * the chat was passed on) and writes the note from `reasons`. While the AI has it, the reply
   * job commits the hand-off and the wording's reservation together, so neither can be left
   * without the other.
   */
  | {
      action: 'urgent';
      reason: AiHandoffReason;
      reasons: InboundGuardReason[];
      text: string;
      staffText: string;
    };

interface RunContext {
  tenantId: string;
  brandId: string;
  conversationId: string;
  runId: string;
  /** When the run must be done: its start plus the agent's time limit (G09). */
  deadlineAt: number;
  /** The agent's time limit for one run. */
  budgetMs: number;
}

const passageText = (p: CheckedPassage) =>
  `${p.heading ? `${p.title} — ${p.heading}` : p.title}\n${p.text}`;

/** The customer's latest public messages, oldest first. */
function customerTexts(messages: readonly AuthorityMessage[], count: number): string[] {
  return messages
    .filter((m) => m.direction === 'incoming' && !m.private && m.text?.trim())
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || Number(a.ref) - Number(b.ref))
    .slice(-count)
    .map((m) => (m.text ?? '').trim().slice(0, 1000));
}

function guardNote(reasons: readonly InboundGuardReason[]): string {
  return [CHECK_HANDOFF_NOTES.guard, ...reasons.map((reason) => GUARD_NOTES[reason])].join(' ');
}

/**
 * Two checks of one draft, as one: a hand-off wins, then writing again (with both corrections),
 * and a reply either check could not vouch for is not cached.
 */
function combine(first: ReplyVerdict, second: ReplyVerdict): ReplyVerdict {
  if (first.action === 'handoff') return first;
  if (second.action === 'handoff') return second;
  if (first.action === 'regenerate' && second.action === 'regenerate') {
    return {
      action: 'regenerate',
      correction: `${first.correction}\n\n${second.correction}`,
      deadlineAt: Math.min(first.deadlineAt, second.deadlineAt),
    };
  }
  if (first.action === 'regenerate') return first;
  if (second.action === 'regenerate') return second;
  return { action: 'publish', cacheable: first.cacheable && second.cacheable };
}

function escalationNote(reasons: readonly EscalationReason[]): string {
  return [HANDOFF_NOTES.ai_escalated, ...reasons.map((reason) => ESCALATION_NOTES[reason])].join(
    ' ',
  );
}

/**
 * Checks around one AI reply, behind one handle so the reply path calls them from a few clear
 * points. Each check follows its brand setting: off (nothing runs), shadow (recorded, nothing
 * changes) or live (acted on). When the provider cannot answer, the reply goes on as it would
 * without the check, and that is recorded too.
 */
export class RunChecks {
  constructor(
    private readonly service: ReplyChecksService,
    readonly context: RunContext,
    private readonly settings: ReadonlyMap<CheckTask, CheckSetting>,
  ) {}

  private writes: Promise<unknown> = Promise.resolve();

  setting(task: CheckTask): CheckSetting | undefined {
    return this.settings.get(task);
  }

  /**
   * Runs this run's check writes one at a time. Checks ask Jev side by side, but a run's steps
   * are numbered in order, so two steps written at once would take the same number.
   */
  serially<T>(write: () => Promise<T>): Promise<T> {
    const next = this.writes.then(write, write);
    this.writes = next.catch(() => undefined);
    return next;
  }

  /**
   * Cached answers are kept apart while a check of drafts is live: an answer cached before (or
   * without) the check is never reused once what it holds back must not stand.
   */
  get cacheScope(): string {
    return (['answer-check', 'message-guard'] as const)
      .filter((task) => this.settings.get(task)?.mode === 'live')
      .map((task) => `+${task}`)
      .join('');
  }

  /**
   * Whether a check that can still hold the reply back is live (the answer check, the message
   * guard): then nothing of the reply is shown while it is written, only what is being done.
   */
  get holdsDrafts(): boolean {
    return (['answer-check', 'message-guard'] as const).some(
      (task) => this.settings.get(task)?.mode === 'live',
    );
  }

  remainingMs(now = Date.now()): number {
    return this.context.deadlineAt - now;
  }

  /**
   * Before a reply is written: whether someone may be at risk, or the customer threatens or
   * abuses (message guard), and whether the customer's messages need a person (escalation, J04).
   * Both read the same messages, side by side. They can only add a hand-off: a customer who asked
   * for a person was handed over before this, without asking Jev (see `inboundGuard`).
   */
  inbound(input: {
    messages: readonly AuthorityMessage[];
    /** The language of the customer's words: it picks the thresholds. */
    language: ReplyLanguage | undefined;
    /** The language Hamnivo replies in: the safe wording is in it. */
    replyLanguage?: ReplyLanguage | undefined;
  }): Promise<InboundVerdict> {
    return this.service.inbound(this, input);
  }

  /**
   * The message guard's check of what comes in, without the escalation advice, for the cases
   * where a hand-off to people is no news: a customer who asked for a person (handed over at
   * once, before anything asked Jev, J04), a workspace whose AI replies are used up, and a
   * conversation people have or are waiting to take. Only someone at risk changes anything there:
   * safe wording, and for people an urgent note. A threat or abuse is recorded, never acted on.
   */
  inboundGuard(input: Parameters<RunChecks['inbound']>[0]): Promise<InboundVerdict> {
    return this.service.inboundGuard(this, { ...input, urgentOnly: true });
  }

  /**
   * When the customer's words fit more than one language: Jev picks one (U01). Live: its choice is
   * used when it met the threshold for the language it named; otherwise the customer is asked
   * once, as before. Undefined when the check does not run for the brand.
   */
  languageDecider(): LanguageDecider | undefined {
    if (!this.settings.has('language')) return undefined;
    return (input) => this.service.language(this, input);
  }

  /**
   * Before the model sees retrieved passages: Jev asks, one request per passage, whether it is
   * about the question, answers it, or carries instructions for the assistant (J03). Live: the
   * passages that do not help are dropped. Shadow: all are kept, and what would be dropped is
   * recorded. A passage Jev could not judge is kept.
   */
  passages<P extends CheckedPassage>(input: {
    messages: readonly AuthorityMessage[];
    passages: readonly P[];
    language: ReplyLanguage | undefined;
  }): Promise<P[]> {
    return this.service.passages(this, input);
  }

  /**
   * Before an AI reply is published, side by side: each sentence that cites a passage, against
   * that passage (answer check); and whether the draft says or promises a payment, refund or order
   * change that Hamnivo's records do not back (message guard). The receipt check ran before this
   * and stays authoritative: these can only hold a reply back. Live: a draft that fails is written
   * again once, and handed to people if that fails too. Shadow: recorded only.
   */
  async reply(input: {
    text: string;
    passages: readonly CheckedPassage[];
    language: ReplyLanguage | undefined;
    attempt: number;
    lastAttempt: boolean;
  }): Promise<ReplyVerdict> {
    const [answer, guard] = await Promise.all([
      this.service.answerCheck(this, input),
      this.service.outboundGuard(this, input),
    ]);
    return combine(guard, answer);
  }
}

@Injectable()
export class ReplyChecksService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    private readonly checks: ChecksService,
    private readonly runs: RunsService,
  ) {}

  /** The checks that run for one AI reply, loaded once; null when none runs for the brand. */
  async forRun(input: {
    tenantId: string;
    brandId: string | null;
    conversationId: string;
    runId: string;
    budgetMs: number;
    startedAt?: number;
  }): Promise<RunChecks | null> {
    if (!input.brandId) return null;
    const brandId = input.brandId;
    const settings = await withTenant(this.db, { tenantId: input.tenantId, actorId: 'ai' }, (tx) =>
      this.checks.settings(tx, brandId),
    );
    if (settings.size === 0) return null;
    const startedAt = input.startedAt ?? Date.now();
    return new RunChecks(
      this,
      {
        tenantId: input.tenantId,
        brandId,
        conversationId: input.conversationId,
        runId: input.runId,
        deadlineAt: startedAt + input.budgetMs,
        budgetMs: input.budgetMs,
      },
      settings,
    );
  }

  /**
   * Whether the message guard runs for a brand (shadow or live): one read of its settings. Callers
   * that would otherwise start a run and read the conversation ask this first.
   */
  async hasMessageGuard(tenantId: string, brandId: string | null): Promise<boolean> {
    if (!brandId) return false;
    const settings = await withTenant(this.db, { tenantId, actorId: 'ai' }, (tx) =>
      this.checks.settings(tx, brandId),
    );
    return settings.has('message-guard');
  }

  /** Records a check and its step in the run, so the run's timeline shows it with its usage. */
  private async record(
    run: RunChecks,
    asked: Asked | readonly Asked[],
    triggerRef: string,
    outcome: {
      verdict: string;
      action: string;
      applied: boolean;
      detail?: Record<string, unknown>;
    },
    step: {
      kind?: 'guard' | 'decision' | 'retrieval';
      name: string;
      status: 'ok' | 'blocked' | 'skipped';
    },
  ): Promise<void> {
    const { context } = run;
    const where = {
      tenantId: context.tenantId,
      brandId: context.brandId,
      conversationId: context.conversationId,
      runId: context.runId,
      triggerRef,
    };
    const all = Array.isArray(asked) ? (asked as readonly Asked[]) : [asked as Asked];
    const first = all[0];
    if (!first) return;
    const values =
      all.length === 1
        ? this.checks.recordValues(first, where, outcome)
        : this.checks.recordValuesMany(all, where, outcome, (index) => `p${index + 1}`);
    await run.serially(() =>
      withTenant(this.db, { tenantId: context.tenantId, actorId: 'ai' }, async (tx) => {
        await this.checks.record(context.tenantId, values, tx);
        await this.runs.step(tx, context.tenantId, context.runId, {
          kind: step.kind ?? 'guard',
          name: step.name,
          status: step.status,
          provider: first.result.provider,
          modelId: values.modelVersion ?? null,
          inputTokens: values.inputTokens ?? null,
          outputTokens: values.outputTokens ?? null,
          latencyMs: values.latencyMs ?? null,
          inputHash: values.stateHash ?? null,
          detail: {
            mode: first.setting.mode,
            status: values.status,
            verdict: outcome.verdict,
            action: outcome.action,
            applied: outcome.applied,
          },
        });
      }),
    );
  }

  async inbound(
    run: RunChecks,
    input: {
      messages: readonly AuthorityMessage[];
      language: ReplyLanguage | undefined;
      replyLanguage?: ReplyLanguage | undefined;
    },
  ): Promise<InboundVerdict> {
    const [guard, escalation] = await Promise.all([
      this.inboundGuard(run, input),
      this.escalation(run, input),
    ]);
    // Someone at risk comes first, then a threat or abuse, then the escalation advice.
    return guard.action !== 'continue' ? guard : escalation;
  }

  /**
   * Message guard, what comes in: self-harm or danger now is urgent (safe wording, then people);
   * a threat or abuse goes to people. Code decides from one exact question each. `urgentOnly`:
   * people have the conversation already (or will have it anyway), so a threat or abuse is only
   * recorded, as found and not acted on.
   */
  async inboundGuard(
    run: RunChecks,
    input: {
      messages: readonly AuthorityMessage[];
      language: ReplyLanguage | undefined;
      replyLanguage?: ReplyLanguage | undefined;
      urgentOnly?: boolean;
    },
  ): Promise<InboundVerdict> {
    const setting = run.setting('message-guard');
    if (!setting) return { action: 'continue' };
    const texts = customerTexts(input.messages, GUARD_MESSAGES);
    if (texts.length === 0) return { action: 'continue' };
    const asked = await this.checks.ask(setting, {
      state: { messages: texts.map(redactPersonalData) },
      questions: INBOUND_GUARD_QUESTIONS,
      language: input.language ? SLICE_OF_LANGUAGE[input.language] : null,
      deadlineMs: Math.max(1, run.remainingMs()),
    });
    const triggerRef = `run:${run.context.runId}:guard:in`;
    if (asked.gated.status !== 'decided') {
      // Jev could not answer, or the language was not evaluated: the reply goes on as today.
      await this.record(
        run,
        asked,
        triggerRef,
        {
          verdict: asked.gated.status,
          action: 'continue',
          applied: false,
          detail: { direction: 'inbound' },
        },
        { name: 'inbound_guard', status: 'skipped' },
      );
      return { action: 'continue' };
    }
    const verdict = inboundGuardVerdict(asked.gated);
    const live = setting.mode === 'live';
    const action = verdict.urgent
      ? 'urgent'
      : verdict.handoff && !input.urgentOnly
        ? 'handoff'
        : 'continue';
    await this.record(
      run,
      asked,
      triggerRef,
      {
        verdict: verdict.urgent ? 'at_risk' : verdict.handoff ? 'flagged' : 'clear',
        action,
        applied: live && action !== 'continue',
        detail: { direction: 'inbound', reasons: verdict.reasons },
      },
      { name: 'inbound_guard', status: live && action !== 'continue' ? 'blocked' : 'ok' },
    );
    if (!live || action === 'continue') return { action: 'continue' };
    if (action === 'handoff') {
      return { action: 'handoff', reason: 'ai_escalated', note: guardNote(verdict.reasons) };
    }
    const language = input.replyLanguage ?? input.language ?? 'en';
    return {
      action: 'urgent',
      reason: 'ai_escalated',
      reasons: verdict.reasons,
      text: SAFE_REPLIES[language],
      staffText: SAFE_REPLIES_STAFF[language],
    };
  }

  /**
   * Message guard, what goes out: the payments, refunds and order changes a draft states or
   * promises, held against Hamnivo's records (receipts, refunds submitted), never the text.
   * A reply that states one is about this conversation, so it is never cached.
   */
  async outboundGuard(
    run: RunChecks,
    input: {
      text: string;
      language: ReplyLanguage | undefined;
      attempt: number;
      lastAttempt: boolean;
    },
  ): Promise<ReplyVerdict> {
    const setting = run.setting('message-guard');
    if (!setting || !input.text.trim()) return { action: 'publish', cacheable: true };
    const live = setting.mode === 'live';
    const asked = await this.checks.ask(setting, {
      // The draft only, with personal data replaced by its kind.
      state: { reply: redactPersonalData(input.text.slice(0, GUARD_REPLY_CHARS)) },
      questions: OUTBOUND_GUARD_QUESTIONS,
      language: input.language ? SLICE_OF_LANGUAGE[input.language] : null,
      deadlineMs: Math.max(1, run.remainingMs()),
    });
    const triggerRef = `run:${run.context.runId}:guard:out:${input.attempt + 1}`;
    if (asked.gated.status !== 'decided') {
      await this.record(
        run,
        asked,
        triggerRef,
        {
          verdict: asked.gated.status,
          action: 'publish',
          applied: false,
          detail: { direction: 'outbound', attempt: input.attempt + 1 },
        },
        { name: 'outbound_guard', status: 'skipped' },
      );
      // Published as it would be without the check; when live, never cached.
      return { action: 'publish', cacheable: !live };
    }
    const claims = outboundClaims(asked.gated);
    const evidence =
      claims.length === 0
        ? null
        : await withTenant(this.db, { tenantId: run.context.tenantId, actorId: 'ai' }, (tx) =>
            claimEvidence(tx, run.context.conversationId),
          );
    const unbacked = evidence ? unbackedClaims(claims, evidence) : [];
    // Writing again only fits when at least half of the run's time is left.
    const canRegenerate = !input.lastAttempt && run.remainingMs() >= run.context.budgetMs / 2;
    const action = unbacked.length === 0 ? 'publish' : canRegenerate ? 'regenerate' : 'handoff';
    await this.record(
      run,
      asked,
      triggerRef,
      {
        verdict: unbacked.length === 0 ? 'clear' : 'unbacked',
        action,
        applied: live && action !== 'publish',
        detail: {
          direction: 'outbound',
          attempt: input.attempt + 1,
          claims,
          unbacked,
          ...(evidence ? { evidence: { ...evidence } } : {}),
        },
      },
      { name: 'outbound_guard', status: live && action !== 'publish' ? 'blocked' : 'ok' },
    );
    if (!live) return { action: 'publish', cacheable: true };
    if (action === 'publish') return { action: 'publish', cacheable: claims.length === 0 };
    if (action === 'regenerate') {
      return {
        action: 'regenerate',
        correction: outboundGuardCorrection(unbacked),
        deadlineAt: run.context.deadlineAt,
      };
    }
    return { action: 'handoff', note: CHECK_HANDOFF_NOTES.unbacked_claim };
  }

  /** Escalation advice (J04): the questions are combined in code; live hands over with why. */
  private async escalation(
    run: RunChecks,
    input: { messages: readonly AuthorityMessage[]; language: ReplyLanguage | undefined },
  ): Promise<InboundVerdict> {
    const setting = run.setting('escalation');
    if (!setting) return { action: 'continue' };
    const texts = customerTexts(input.messages, ESCALATION_MESSAGES);
    if (texts.length === 0) return { action: 'continue' };
    const asked = await this.checks.ask(setting, {
      state: { messages: texts.map(redactPersonalData) },
      questions: ESCALATION_QUESTIONS,
      language: input.language ? SLICE_OF_LANGUAGE[input.language] : null,
      deadlineMs: Math.max(1, run.remainingMs()),
    });
    const triggerRef = `run:${run.context.runId}:escalation`;
    if (asked.gated.status !== 'decided') {
      // Jev could not answer, or the language was not evaluated: the reply goes on as today.
      await this.record(
        run,
        asked,
        triggerRef,
        { verdict: asked.gated.status, action: 'continue', applied: false },
        { kind: 'decision', name: 'escalation', status: 'skipped' },
      );
      return { action: 'continue' };
    }
    const verdict = escalationVerdict(asked.gated);
    const live = setting.mode === 'live';
    await this.record(
      run,
      asked,
      triggerRef,
      {
        verdict: verdict.escalate ? 'escalate' : 'continue',
        action: verdict.escalate ? 'handoff' : 'continue',
        applied: live && verdict.escalate,
        detail: { reasons: verdict.reasons },
      },
      { kind: 'decision', name: 'escalation', status: 'ok' },
    );
    if (!live || !verdict.escalate) return { action: 'continue' };
    return { action: 'handoff', reason: 'ai_escalated', note: escalationNote(verdict.reasons) };
  }

  async language(
    run: RunChecks,
    input: { text: string; candidates: readonly ReplyLanguage[] },
  ): Promise<ReplyLanguage | null> {
    const setting = run.setting('language');
    if (!setting) return null;
    const asked = await this.checks.ask(setting, {
      state: { messages: [redactPersonalData(input.text.slice(0, 1000))] },
      questions: LANGUAGE_CHECK_QUESTIONS,
      language: null,
      // Thresholds by the language answered: it is what is being decided.
      sliceOf: answeredSlice,
      deadlineMs: Math.max(1, run.remainingMs()),
    });
    const decided = languageDecision(asked.gated, input.candidates);
    const live = setting.mode === 'live';
    await this.record(
      run,
      asked,
      `run:${run.context.runId}:language`,
      {
        verdict:
          asked.gated.status !== 'decided' ? asked.gated.status : decided ? 'decided' : 'ask',
        action: decided ? 'use' : 'ask',
        applied: live && decided !== null,
        detail: {
          candidates: [...input.candidates],
          answered: answeredSlice(asked.result),
          decided,
        },
      },
      {
        kind: 'decision',
        name: 'language',
        status: asked.gated.status === 'decided' ? 'ok' : 'skipped',
      },
    );
    return live ? decided : null;
  }

  async passages<P extends CheckedPassage>(
    run: RunChecks,
    input: {
      messages: readonly AuthorityMessage[];
      passages: readonly P[];
      language: ReplyLanguage | undefined;
    },
  ): Promise<P[]> {
    const setting = run.setting('passage-relevance');
    if (!setting || input.passages.length === 0) return [...input.passages];
    // The question retrieval used: the customer's last two messages.
    const question = customerTexts(input.messages, 2).join('\n').slice(-1000);
    if (!question) return [...input.passages];
    const language = input.language ? SLICE_OF_LANGUAGE[input.language] : null;
    const deadlineMs = Math.max(1, run.remainingMs());
    const asked = await Promise.all(
      input.passages.map((passage) =>
        this.checks.ask(setting, {
          state: {
            question: redactPersonalData(question),
            passage: {
              title: passage.heading ? `${passage.title} — ${passage.heading}` : passage.title,
              text: passage.text.slice(0, PASSAGE_CHECK_CHARS),
            },
          },
          questions: PASSAGE_QUESTIONS,
          language,
          deadlineMs,
        }),
      ),
    );
    const verdicts = asked.map((a) =>
      a.gated.status === 'decided'
        ? { ...passageVerdict(a.gated), status: a.gated.status }
        : { keep: true, reason: null, status: a.gated.status },
    );
    const dropped = verdicts.filter((v) => !v.keep).length;
    const live = setting.mode === 'live';
    await this.record(
      run,
      asked,
      `run:${run.context.runId}:passages`,
      {
        verdict: dropped > 0 ? 'drop' : 'keep',
        action: dropped > 0 ? 'drop' : 'keep',
        applied: live && dropped > 0,
        detail: {
          passages: input.passages.map((passage, index) => ({
            document: toPublicId('document', passage.documentId),
            keep: verdicts[index]?.keep ?? true,
            reason: verdicts[index]?.reason ?? null,
            status: verdicts[index]?.status ?? 'unavailable',
          })),
          dropped,
          kept: input.passages.length - dropped,
        },
      },
      { kind: 'retrieval', name: 'passage_relevance', status: 'ok' },
    );
    return live
      ? input.passages.filter((_, index) => verdicts[index]?.keep ?? true)
      : [...input.passages];
  }

  async answerCheck(
    run: RunChecks,
    input: {
      text: string;
      passages: readonly CheckedPassage[];
      language: ReplyLanguage | undefined;
      attempt: number;
      lastAttempt: boolean;
    },
  ): Promise<ReplyVerdict> {
    const setting = run.setting('answer-check');
    if (!setting) return { action: 'publish', cacheable: true };
    const claims = citedClaims(input.text, input.passages.length);
    // Nothing cited, nothing to check.
    if (claims.length === 0) return { action: 'publish', cacheable: true };
    const live = setting.mode === 'live';
    // Jev sees the cited sentences, with personal data replaced by its kind, and their passages.
    const request = answerCheckRequest(
      claims.map((claim) => ({ ...claim, text: redactPersonalData(claim.text) })),
      input.passages.map((p) => passageText(p)),
    );
    const asked = await this.checks.ask(setting, {
      state: request.state,
      questions: request.questions,
      language: input.language ? SLICE_OF_LANGUAGE[input.language] : null,
      // Within the reply's deadline: never longer than the run has left.
      deadlineMs: Math.max(1, run.remainingMs()),
      keyOf: answerCheckThresholdKey,
    });
    const triggerRef = `run:${run.context.runId}:answer:${input.attempt + 1}`;
    const detail = {
      claims: claims.map((claim) => ({
        sentence: claim.sentence,
        documents: claim.passages.flatMap((p) => {
          const document = input.passages[p]?.documentId;
          return document ? [toPublicId('document', document)] : [];
        }),
      })),
      unchecked: request.unchecked,
      attempt: input.attempt + 1,
    };
    if (asked.gated.status !== 'decided') {
      // The provider could not answer, or the language was not evaluated: as without the check.
      await this.record(
        run,
        asked,
        triggerRef,
        { verdict: asked.gated.status, action: 'publish', applied: false, detail },
        { name: 'answer_check', status: 'skipped' },
      );
      return { action: 'publish', cacheable: !live };
    }
    const outcome = answerCheckVerdict(claims, request.pairs, asked.gated);
    const failing = outcome.claims
      .map((verdict, index) => ({ verdict, claim: claims[index] }))
      .filter((c) => c.verdict.verdict !== 'supported');
    // Writing again only fits when at least half of the run's time is left.
    const canRegenerate = !input.lastAttempt && run.remainingMs() >= run.context.budgetMs / 2;
    const action =
      outcome.verdict === 'pass' ? 'publish' : canRegenerate ? 'regenerate' : 'handoff';
    await this.record(
      run,
      asked,
      triggerRef,
      {
        verdict: outcome.verdict,
        action,
        applied: live,
        detail: { ...detail, verdicts: outcome.claims },
      },
      { name: 'answer_check', status: live && action !== 'publish' ? 'blocked' : 'ok' },
    );
    if (!live || action === 'publish') return { action: 'publish', cacheable: true };
    if (action === 'regenerate') {
      return {
        action: 'regenerate',
        correction: answerCheckCorrection(failing.flatMap((c) => (c.claim ? [c.claim.text] : []))),
        deadlineAt: run.context.deadlineAt,
      };
    }
    return { action: 'handoff', note: CHECK_HANDOFF_NOTES.unsupported_answer };
  }
}
