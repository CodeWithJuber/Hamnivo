import { createHash } from 'node:crypto';
import type { TestRubricRequest, TestRubricResult } from '@hamnivo/contracts';
import {
  appendAudit,
  type ClaimedOutboxEvent,
  type Db,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import {
  type AuthorityMessage,
  applyThreshold,
  baselineIntent,
  type DecisionProvider,
  type DecisionResult,
  decideRoute,
  detectHumanRequest,
  findPersonalData,
  type LanguageSlice,
  OTHER_INTENT,
  type RoutingAnswers,
  type RoutingDecision,
  redactPersonalData,
  routingQuestion,
  type ThresholdPolicy,
} from '@hamnivo/domain';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import canonicalize from 'canonicalize';
import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { JournalService } from '../authority/journal.service.js';
import { AuthorityRegistry } from '../authority/registry.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { LanguageService } from '../language/language.service.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { AuthorityContactsService } from '../widget/contacts.service.js';
import { authorizedBrand, type BrandRow } from './access.js';
import { DecisionProviders, MOCK_MODEL_VERSION } from './providers.js';
import { teamsForBrand } from './team-routing.service.js';
import {
  definitionOf,
  intentsOf,
  type RecordRow,
  ROUTING_TASK,
  type RubricRow,
  recordView,
  teamRule,
} from './views.js';

/** Outbox payload of `conversation.route`. */
export interface RouteRequested {
  conversationId: string;
  trigger: 'new_conversation' | 'handoff';
  /** Unique per conversation: `new:{ledgerId}` or `handoff:{epoch}`. */
  ref: string;
}

type ControlRow = typeof schema.conversationControls.$inferSelect;

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** What the provider sees: the chosen inputs, with personal data replaced by its kind. */
function minimizedState(texts: string[], status: string | null) {
  return {
    messages: texts.map(redactPersonalData),
    ...(status ? { conversation: status } : {}),
  };
}

export function rubricVersionOf(rubric: RubricRow): string {
  return `${rubric.task}-v${rubric.version}`;
}

/** Thresholds as the domain applies them: per language slice, for the one intent question. */
export function thresholdPolicy(rubric: RubricRow, providerId: string): ThresholdPolicy {
  const languages = Object.fromEntries(
    Object.entries(definitionOf(rubric).thresholds).map(([slice, threshold]) => [
      slice,
      { intent: { type: 'choice' as const, minConfidence: threshold?.minConfidence ?? 1 } },
    ]),
  );
  return {
    version: rubricVersionOf(rubric),
    tasks: {
      [rubric.task]: {
        provider: providerId,
        modelVersion:
          rubric.provider === 'mock'
            ? (rubric.modelVersion ?? MOCK_MODEL_VERSION)
            : (rubric.modelVersion ?? ''),
        rubricVersion: rubricVersionOf(rubric),
        languages,
      },
    },
  };
}

interface Judged {
  decision: RoutingDecision;
  result: DecisionResult<RoutingAnswers> | null;
  baseline: ReturnType<typeof baselineIntent>;
  language: LanguageSlice | null;
  offered: string[];
  stateHash: Buffer | null;
  redacted: string[];
}

/**
 * Intent and team routing (J02, U07). New conversations and handed-off ones are routed to a team
 * by intent and language. The rubric's provider (Jev) suggests the intent within the rubric's
 * total deadline; the deterministic baseline decides whenever it abstains, fails or is too slow.
 * Every decision is recorded with both answers (J07). `shadow` mode applies nothing; `live` puts
 * the conversation in the chosen inbox team's queue the way the inbox does
 * (`conversation_inbox_state.team_id`, then `conversation.team_changed` sets the Chatwoot team),
 * so team queues and team-scoped grants see it.
 *
 * A customer who asked for a person was handed over before this runs, in the same transaction
 * that queued it: routing only chooses where the conversation waits and never changes who owns it.
 */
@Injectable()
export class RoutingService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly registry: AuthorityRegistry,
    private readonly contacts: AuthorityContactsService,
    private readonly language: LanguageService,
    private readonly providers: DecisionProviders,
    private readonly journal: JournalService,
  ) {}

  private tx<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(this.db, { tenantId, actorId: 'routing' }, work);
  }

  /** Teams routing may choose for a brand: active inbox teams with active routing for it. */
  private async routingTeams(tx: TenantTx, brand: Pick<BrandRow, 'id' | 'workspaceId'>) {
    const rows = await teamsForBrand(tx, brand);
    return rows.flatMap((row) =>
      row.routing && row.routing.status === 'active'
        ? [{ team: row.team, routing: row.routing }]
        : [],
    );
  }

  private async setup(tx: TenantTx, brand: Pick<BrandRow, 'id' | 'workspaceId'>) {
    const brandId = brand.id;
    const [settings] = await tx
      .select()
      .from(schema.decisionTasks)
      .where(
        and(eq(schema.decisionTasks.brandId, brandId), eq(schema.decisionTasks.task, ROUTING_TASK)),
      );
    const [rubric] = await tx
      .select()
      .from(schema.decisionRubrics)
      .where(
        and(
          eq(schema.decisionRubrics.brandId, brandId),
          eq(schema.decisionRubrics.task, ROUTING_TASK),
          eq(schema.decisionRubrics.state, 'published'),
        ),
      );
    const teams = await this.routingTeams(tx, brand);
    return { mode: settings?.mode ?? 'shadow', rubric: rubric ?? null, teams };
  }

  /** The customer's latest public messages, oldest first (customer view when the contact is known). */
  private async customerTexts(
    tenantId: string,
    control: ControlRow,
    count: number,
  ): Promise<string[]> {
    const runtime = await this.registry.get(tenantId, control.connectionId);
    const ref = String(control.externalConversationId);
    const contact = control.principalId
      ? await this.tx(tenantId, async (tx) => {
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
                eq(schema.authorityContacts.principalId, control.principalId as string),
              ),
            );
          return row ?? null;
        })
      : null;
    const messages: AuthorityMessage[] = contact
      ? await runtime.authority.listMessages(ref, {
          view: 'customer',
          contactSourceId: this.contacts.sourceIdOf(tenantId, contact.contact),
          inboxRef: String(contact.inbox.externalInboxId),
        })
      : await runtime.authority.listMessages(ref, { view: 'staff' });
    return messages
      .filter((m) => m.direction === 'incoming' && !m.private && m.text?.trim())
      .sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || Number(a.ref) - Number(b.ref),
      )
      .slice(-count)
      .map((m) => (m.text ?? '').trim().slice(0, 1000));
  }

  /** Asks the provider (if any) and the baseline, and combines them. Never throws for provider trouble. */
  private async judge(input: {
    rubric: RubricRow;
    teams: ReturnType<typeof teamRule>[];
    texts: string[];
    state: ReturnType<typeof minimizedState>;
    language: LanguageSlice | null;
    alternatives: LanguageSlice[];
    explicitRequest: boolean;
    provider: DecisionProvider | null;
  }): Promise<Judged> {
    const intents = intentsOf(input.rubric);
    const offered = [...intents.map((i) => i.key), OTHER_INTENT];
    const joined = input.texts.join('\n');
    const baseline = baselineIntent(joined, intents);
    const redacted = [...new Set(input.texts.flatMap(findPersonalData))];
    const state = input.state;
    const stateHash = sha256(canonicalize(state) ?? '');
    let result: DecisionResult<RoutingAnswers> | null = null;
    if (input.provider) {
      const raw = await input.provider.decide({
        task: input.rubric.task,
        rubricVersion: rubricVersionOf(input.rubric),
        state,
        questions: { intent: routingQuestion(intents) },
        ...(input.language ? { language: input.language } : {}),
        deadlineMs: input.rubric.deadlineMs,
      });
      result = applyThreshold(raw, thresholdPolicy(input.rubric, input.provider.id));
    }
    const decision = decideRoute({
      provider: result,
      baseline,
      offered,
      language: input.language,
      alternatives: input.alternatives,
      teams: input.teams,
      explicitRequest: input.explicitRequest,
    });
    return { decision, result, baseline, language: input.language, offered, stateHash, redacted };
  }

  private recordValues(
    judged: Judged,
    rubric: RubricRow,
    extra: {
      tenantId: string;
      brandId: string;
      conversationId: string | null;
      trigger: 'new_conversation' | 'handoff' | 'test';
      triggerRef: string;
      mode: 'shadow' | 'live' | 'test';
      providerId: string;
      totalMs: number;
    },
  ): typeof schema.decisionRecords.$inferInsert {
    const { result, decision, baseline } = judged;
    // The provider's own answer: kept when decided, and when a threshold set it aside (for audit).
    const answer =
      result?.status === 'decided'
        ? result.value.intent
        : result?.status === 'abstained'
          ? result.observed?.intent
          : undefined;
    return {
      tenantId: extra.tenantId,
      brandId: extra.brandId,
      conversationId: extra.conversationId,
      task: rubric.task,
      trigger: extra.trigger,
      triggerRef: extra.triggerRef,
      rubricId: rubric.id,
      rubricVersion: rubric.version,
      mode: extra.mode,
      provider: result?.provider ?? 'none',
      modelVersion: result && 'modelVersion' in result ? (result.modelVersion ?? null) : null,
      status: result ? result.status : 'skipped',
      reason:
        result?.status === 'abstained' ||
        result?.status === 'invalid' ||
        result?.status === 'unavailable'
          ? result.reason.slice(0, 500)
          : result
            ? null
            : 'no_provider',
      retryable: result?.status === 'unavailable' ? result.retryable : null,
      providerIntent: typeof answer?.label === 'string' ? answer.label : null,
      // Only the provider's own confidence; nothing is estimated when it gave none.
      confidence: typeof answer?.confidence === 'number' ? answer.confidence : null,
      probabilities: answer?.probabilities ?? null,
      baselineIntent: baseline.intent,
      baselineMatches: baseline.matches,
      finalIntent: decision.intent,
      finalSource: decision.source,
      fallback: decision.fallback,
      teamId: decision.team.teamId,
      teamBasis: decision.team.basis,
      languageMatch: decision.team.languageMatch,
      language: judged.language,
      explicitRequest: decision.explicitRequest,
      latencyMs: result ? Math.round(result.latencyMs) : null,
      totalMs: extra.totalMs,
      inputTokens: result?.usage?.inputTokens ?? null,
      outputTokens: result?.usage?.outputTokens ?? null,
      requestId: result?.requestId ?? null,
      policyVersion: result?.policyVersion ?? null,
      stateHash: judged.stateHash,
      offered: judged.offered,
    };
  }

  /** Outbox handler for `conversation.route`. Safe to run more than once. */
  async onRoute(event: ClaimedOutboxEvent): Promise<void> {
    const started = performance.now();
    const payload = event.payload as RouteRequested;
    const tenantId = event.tenantId;
    const context = await this.tx(tenantId, async (tx) => {
      const [control] = await tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, payload.conversationId));
      if (!control?.brandId) return null;
      const [brand] = await tx
        .select()
        .from(schema.brands)
        .where(eq(schema.brands.id, control.brandId));
      if (!brand) return null;
      const setup = await this.setup(tx, brand);
      const existing = await tx
        .select()
        .from(schema.decisionRecords)
        .where(
          and(
            eq(schema.decisionRecords.conversationId, control.id),
            eq(schema.decisionRecords.task, ROUTING_TASK),
          ),
        )
        .orderBy(desc(schema.decisionRecords.createdAt));
      return { control, ...setup, existing };
    });
    if (!context || context.mode === 'off' || !context.rubric) return;
    const { control, rubric } = context;
    const brandId = control.brandId as string;
    const same = context.existing.find((r) => r.triggerRef === payload.ref);
    if (same) {
      // A retry after the record was written: finish applying it if that did not happen.
      if (same.mode === 'live' && !same.applied) await this.apply(tenantId, control, same);
      return;
    }
    // A new conversation is routed once; a handoff is a new moment to route.
    if (payload.trigger === 'new_conversation' && context.existing.length > 0) return;

    const texts = await this.customerTexts(tenantId, control, 5);
    // Without the customer's words there is nothing to route on yet; their first message will.
    if (texts.length === 0) return;
    const mode = context.mode === 'live' ? 'live' : 'shadow';
    const definition = definitionOf(rubric);
    const state = minimizedState(
      texts.slice(-definition.inputs.recentMessages),
      definition.inputs.conversationStatus
        ? control.ownerMode === 'AI_ACTIVE'
          ? 'with_ai'
          : 'waiting_for_person'
        : null,
    );
    // A handoff with nothing new since the last decision reuses it instead of asking again.
    const last = context.existing[0];
    if (
      last &&
      last.mode === mode &&
      last.rubricId === rubric.id &&
      last.stateHash?.equals(sha256(canonicalize(state) ?? ''))
    ) {
      if (mode === 'live' && !last.applied) await this.apply(tenantId, control, last);
      return;
    }
    const latest = texts.at(-1) ?? '';
    const explicitRequest = detectHumanRequest(latest).requested;
    const language = await this.tx(tenantId, (tx) =>
      this.language.forRouting(tx, control.principalId, texts.join('\n')),
    );
    const provider = this.providers.forRubric({
      provider: rubric.provider,
      modelVersion: rubric.modelVersion,
      intents: intentsOf(rubric),
    });
    const judged = await this.judge({
      rubric,
      teams: context.teams.map((t) => teamRule(t.team, t.routing)),
      texts,
      state,
      language: language.slice,
      alternatives: language.alternatives,
      explicitRequest,
      provider,
    });
    const values = this.recordValues(judged, rubric, {
      tenantId,
      brandId,
      conversationId: control.id,
      trigger: payload.trigger,
      triggerRef: payload.ref,
      mode,
      providerId: provider?.id ?? 'none',
      totalMs: Math.round(performance.now() - started),
    });
    const [record] = await this.tx(tenantId, (tx) =>
      tx.insert(schema.decisionRecords).values(values).onConflictDoNothing().returning(),
    );
    if (!record) return;
    if (mode === 'live') await this.apply(tenantId, control, record);
  }

  /**
   * Live routing: puts the conversation in the team's queue as the inbox does, and asks for the
   * team in Chatwoot through `conversation.team_changed`. A conversation a person already handles
   * keeps its team, and so does one whose team a person chose (a team no routing decision set).
   */
  private async apply(tenantId: string, control: ControlRow, record: RecordRow): Promise<void> {
    if (!record.teamId) return;
    const teamId = record.teamId;
    const changed = await this.tx(tenantId, async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, control.id))
        .for('update');
      if (!current || current.ownerMode === 'HUMAN_ACTIVE') return false;
      const [state] = await tx
        .select({ teamId: schema.conversationInboxState.teamId })
        .from(schema.conversationInboxState)
        .where(eq(schema.conversationInboxState.conversationId, control.id));
      const currentTeam = state?.teamId ?? null;
      if (currentTeam !== null && currentTeam !== teamId) {
        const [routed] = await tx
          .select({ id: schema.decisionRecords.id })
          .from(schema.decisionRecords)
          .where(
            and(
              eq(schema.decisionRecords.conversationId, control.id),
              eq(schema.decisionRecords.applied, true),
              eq(schema.decisionRecords.teamId, currentTeam),
            ),
          )
          .limit(1);
        if (!routed) return false;
      }
      const [team] = await tx.select().from(schema.teams).where(eq(schema.teams.id, teamId));
      if (team?.status !== 'active') return false;
      await tx
        .update(schema.decisionRecords)
        .set({ applied: true, appliedAt: this.clock() })
        .where(eq(schema.decisionRecords.id, record.id));
      if (currentTeam === teamId) return false;
      await tx
        .insert(schema.conversationInboxState)
        .values({ tenantId, conversationId: control.id, teamId })
        .onConflictDoUpdate({
          target: [
            schema.conversationInboxState.tenantId,
            schema.conversationInboxState.conversationId,
          ],
          set: { teamId, updatedAt: this.clock() },
        });
      // The inbox's own path: the sync sets the Chatwoot team (created on first use).
      await enqueueOutbox(tx, tenantId, {
        topic: 'conversation.team_changed',
        aggregateType: 'conversation',
        aggregateId: control.id,
        payload: { conversationId: control.id, teamId, actorStaffMemberId: null },
      });
      await appendAudit(tx, {
        actorType: 'system',
        actorId: 'routing',
        action: 'conversation.routed',
        targetType: 'conversation',
        targetId: toPublicId('conversation', control.id),
        outcome: 'success',
        data: {
          from: currentTeam ? toPublicId('team', currentTeam) : null,
          team: toPublicId('team', teamId),
          intent: record.finalIntent,
          source: record.finalSource,
          decision: toPublicId('decision', record.id),
          explicitRequest: record.explicitRequest,
        },
      });
      return true;
    });
    if (changed) await this.journal.signalInbox(tenantId, control.id);
  }

  /**
   * Tries a rubric on a synthetic message (HNV-12-02 to HNV-12-05). The record is kept as a test
   * (never applied, never counted in experiments) so the result can be inspected and reviewed.
   */
  async test(
    principal: StaffPrincipal,
    brandPublicId: string,
    task: string,
    input: z.output<typeof TestRubricRequest>,
  ): Promise<TestRubricResult> {
    if (task !== ROUTING_TASK)
      throw new AppError('NOT_FOUND', { detail: 'Decision task not found.' });
    const started = performance.now();
    const access = { now: this.clock(), config: this.config };
    const loaded = await withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      async (tx) => {
        const brand = await authorizedBrand(
          tx,
          principal,
          brandPublicId,
          'decisions.manage',
          access,
        );
        const [rubric] = await tx
          .select()
          .from(schema.decisionRubrics)
          .where(
            and(
              eq(schema.decisionRubrics.brandId, brand.id),
              eq(schema.decisionRubrics.task, task),
              eq(schema.decisionRubrics.state, input.rubric),
            ),
          );
        const teams = await this.routingTeams(tx, brand);
        const language = await this.language.forRouting(tx, null, input.message);
        return { brand, rubric, teams, language };
      },
    );
    if (!loaded.rubric) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'rubric', message: `There is no ${input.rubric} rubric to test.` }],
      });
    }
    const rubric = loaded.rubric;
    const explicitRequest = detectHumanRequest(input.message).requested;
    const provider = this.providers.forRubric({
      provider: rubric.provider,
      modelVersion: rubric.modelVersion,
      intents: intentsOf(rubric),
    });
    const definition = definitionOf(rubric);
    const judged = await this.judge({
      rubric,
      teams: loaded.teams.map((t) => teamRule(t.team, t.routing)),
      texts: [input.message],
      state: minimizedState(
        [input.message],
        definition.inputs.conversationStatus ? 'with_ai' : null,
      ),
      language: loaded.language.slice,
      alternatives: loaded.language.alternatives,
      explicitRequest,
      provider,
    });
    const values = this.recordValues(judged, rubric, {
      tenantId: principal.tenantId,
      brandId: loaded.brand.id,
      conversationId: null,
      trigger: 'test',
      triggerRef: `test:${toPublicId('staff', principal.staffMemberId)}`,
      mode: 'test',
      providerId: provider?.id ?? 'none',
      totalMs: Math.round(performance.now() - started),
    });
    const record = await withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      async (tx) => {
        const [row] = await tx.insert(schema.decisionRecords).values(values).returning();
        if (!row) throw new Error('decision test insert returned nothing');
        await appendAudit(tx, {
          actorType: 'staff',
          actorId: toPublicId('staff', principal.staffMemberId),
          action: 'decision.tested',
          targetType: 'decision',
          targetId: toPublicId('decision', row.id),
          outcome: 'success',
          data: { brand: brandPublicId, rubricVersion: rubric.version, status: row.status },
        });
        return row;
      },
    );
    const team = loaded.teams.find((t) => t.team.id === record.teamId)?.team;
    return {
      record: recordView(record, team?.name ?? null),
      policy: { explicitRequest, redacted: judged.redacted },
    };
  }
}
