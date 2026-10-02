import { type Db, toPublicId, withTenant } from '@hamnivo/db';
import {
  type AuthorityMessage,
  answerCheckCorrection,
  answerCheckRequest,
  answerCheckThresholdKey,
  answerCheckVerdict,
  type CheckTask,
  citedClaims,
  ESCALATION_MESSAGES,
  ESCALATION_QUESTIONS,
  type EscalationReason,
  escalationVerdict,
  PASSAGE_CHECK_CHARS,
  PASSAGE_QUESTIONS,
  passageVerdict,
  type ReplyLanguage,
  redactPersonalData,
  SLICE_OF_LANGUAGE,
} from '@hamnivo/domain';
import { Inject, Injectable } from '@nestjs/common';
import {
  type AiHandoffReason,
  CHECK_HANDOFF_NOTES,
  ESCALATION_NOTES,
  HANDOFF_NOTES,
} from '../runtime/handoff-notes.js';
import { RunsService } from '../runtime/runs.service.js';
import { APP_DB } from '../tokens.js';
import { type Asked, type CheckSetting, ChecksService } from './checks.service.js';

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
  | { action: 'handoff'; reason: AiHandoffReason; note: string };

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

  setting(task: CheckTask): CheckSetting | undefined {
    return this.settings.get(task);
  }

  /**
   * Cached answers are kept apart while the answer check is live: an answer cached before (or
   * without) the check is never reused once unsupported answers must not stand.
   */
  get cacheScope(): string {
    return this.settings.get('answer-check')?.mode === 'live' ? '+answer-check' : '';
  }

  remainingMs(now = Date.now()): number {
    return this.context.deadlineAt - now;
  }

  /**
   * Before a reply is written: whether the customer's messages need a person (escalation, J04).
   * It can only add a hand-off: a customer who asked for a person was handed over before this,
   * without asking Jev.
   */
  inbound(input: {
    messages: readonly AuthorityMessage[];
    language: ReplyLanguage | undefined;
  }): Promise<InboundVerdict> {
    return this.service.inbound(this, input);
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
   * Before an AI reply is published: each sentence that cites a passage is checked against that
   * passage (answer check). Live: a reply with a sentence that is not supported is never
   * published; it is written again once without it, and handed to people if that fails too.
   * Shadow: recorded only.
   */
  reply(input: {
    text: string;
    passages: readonly CheckedPassage[];
    language: ReplyLanguage | undefined;
    attempt: number;
    lastAttempt: boolean;
  }): Promise<ReplyVerdict> {
    return this.service.answerCheck(this, input);
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
    await withTenant(this.db, { tenantId: context.tenantId, actorId: 'ai' }, async (tx) => {
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
    });
  }

  async inbound(
    run: RunChecks,
    input: { messages: readonly AuthorityMessage[]; language: ReplyLanguage | undefined },
  ): Promise<InboundVerdict> {
    return this.escalation(run, input);
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
