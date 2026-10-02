import {
  appendAudit,
  type ClaimedOutboxEvent,
  type Db,
  newId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { type ActionState, checkBinding, IN_FLIGHT_ACTION_STATES } from '@hamnivo/domain/actions';
import { Inject, Injectable, type OnModuleInit, Optional } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { type JournalInput, JournalService } from '../authority/journal.service.js';
import { CommerceCardsService } from '../commerce/card-publisher.service.js';
import { backoffMs } from '../commerce/common.js';
import { Effects } from '../commerce/effects.js';
import { addReceipt, lockOperation, moveOperation, openOperation } from '../commerce/ledger.js';
import { AppError } from '../common/app-error.js';
import { OperationReconcilers } from '../common/operation-reconcilers.js';
import { KillSwitchesService } from '../runtime/kill-switches.service.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import {
  stillGranted,
  ToolAdapters,
  ToolCallFailure,
  type ToolOutcome,
  type ToolRow,
  type ToolScope,
  toolReason,
} from './adapters.js';
import { actionReceiptPublication } from './cards.js';
import type { ActionRow, ReceiptRow } from './views.js';

export const ACTION_EXECUTE_TOPIC = 'action.execute';

/** What became of an execution attempt, for the run (and the model) that started it. */
export interface ExecutionResult {
  state: ActionState;
  summary: string;
  /** The tool's raw result; contained by the caller before any model sees it. */
  output?: unknown;
}

/** Reconciliation tries before an unknown outcome is left to a person. */
const RECONCILE_LIMIT = 8;

interface Loaded {
  action: ActionRow;
  tool: ToolRow;
  control: typeof schema.conversationControls.$inferSelect;
  brandName: string;
}

const ACTION_OUTCOME: Partial<Record<ActionState, string>> = {
  executing: 'executing',
  completed: 'completed',
  failed: 'failed',
  unknown: 'unknown',
  superseded: 'cancelled',
  cancelled: 'cancelled',
};

/**
 * Runs approved AI actions through the operation ledger (G14, C07): one operation per action,
 * found again by its business key, dispatched once with the action's idempotency key. The answer
 * becomes a receipt; a lost answer makes the outcome unknown, and only the tool's own records
 * settle it (reconciliation), never a second send. Immediately before sending, everything the
 * approval was bound to is checked again (X02): tool revision and status, kill switches, the
 * resource's revision and the ownership epoch.
 */
@Injectable()
export class ActionExecutor implements OnModuleInit {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly adapters: ToolAdapters,
    private readonly switches: KillSwitchesService,
    private readonly journal: JournalService,
    private readonly cards: CommerceCardsService,
    @Optional() private readonly reconcilers?: OperationReconcilers,
  ) {}

  onModuleInit(): void {
    this.reconcilers?.register('tool.', (tenantId, operationId) =>
      this.reconcileOperation(tenantId, operationId, 'worker').then(() => undefined),
    );
  }

  private tx<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(this.db, { tenantId, actorId: 'ai' }, work);
  }

  private scopeOf(loaded: Loaded, tenantId: string): ToolScope {
    return {
      tenantId,
      brandId: loaded.tool.brandId,
      conversationId: loaded.action.conversationId,
      principalId: loaded.control.principalId,
    };
  }

  private async load(tx: TenantTx, actionId: string, lock: boolean): Promise<Loaded | null> {
    const query = tx.select().from(schema.actions).where(eq(schema.actions.id, actionId));
    const [action] = lock ? await query.for('update') : await query;
    if (!action) return null;
    const [tool] = await tx
      .select()
      .from(schema.toolDefinitions)
      .where(eq(schema.toolDefinitions.id, action.toolId));
    const [control] = await tx
      .select()
      .from(schema.conversationControls)
      .where(eq(schema.conversationControls.id, action.conversationId));
    if (!tool || !control) return null;
    const [brand] = await tx
      .select({ name: schema.brands.name })
      .from(schema.brands)
      .where(eq(schema.brands.id, tool.brandId));
    return { action, tool, control, brandName: brand?.name ?? 'Support' };
  }

  /** Customer-visible (or staff-visible) action update, plus the audit record. */
  private async record(
    tx: TenantTx,
    effects: Effects,
    tenantId: string,
    action: ActionRow,
    event: { state: ActionState; summary: string; audit: string; data?: Record<string, unknown> },
  ) {
    const now = this.clock();
    const outcome = ACTION_OUTCOME[event.state];
    const entries: JournalInput[] = [];
    if (outcome) {
      entries.push({
        lane: action.approver === 'staff' && action.basis !== 'autopilot' ? 'staff' : 'customer',
        type: 'action.updated',
        data: {
          actionId: toPublicId('action', action.id),
          outcome,
          summary: event.summary.slice(0, 300),
        },
      });
    }
    if (entries.length) {
      effects.add(
        tenantId,
        action.conversationId,
        await this.journal.append(tx, tenantId, action.conversationId, entries),
      );
    }
    await appendAudit(tx, {
      actorType: 'system',
      actorId: 'ai',
      action: event.audit,
      targetType: 'action',
      targetId: toPublicId('action', action.id),
      outcome: event.state === 'failed' ? 'failed' : 'success',
      occurredAt: now,
      data: {
        tool: action.toolName,
        risk: action.risk,
        state: event.state,
        argumentsHash: action.argumentsHash.toString('hex'),
        ...(event.data ?? {}),
      },
    });
  }

  private async postReceipt(
    tx: TenantTx,
    tenantId: string,
    loaded: Loaded,
    receipt: ReceiptRow,
    summary: string,
  ) {
    await this.cards.enqueue(
      tx,
      tenantId,
      loaded.control,
      actionReceiptPublication(loaded.action, receipt, summary, loaded.brandName),
      `action-receipt:${receipt.id}`,
    );
  }

  /** Outbox `action.execute`: an approval was given; send the action (at most once). */
  async onExecute(event: ClaimedOutboxEvent): Promise<void> {
    const payload = event.payload as { actionId: string };
    await this.execute(event.tenantId, payload.actionId, {});
  }

  /**
   * Sends an approved action. Safe to call again: an action already sent is not sent twice (its
   * outcome is settled by reconciliation), and one whose binding changed is superseded instead.
   */
  async execute(
    tenantId: string,
    actionId: string,
    options: { signal?: AbortSignal; runId?: string },
  ): Promise<ExecutionResult> {
    const effects = new Effects();
    const now = this.clock();
    const plan = await this.tx(tenantId, async (tx) => {
      const loaded = await this.load(tx, actionId, true);
      if (!loaded) return { kind: 'gone' as const };
      const { action, tool, control } = loaded;
      if (action.state !== 'approved') {
        return { kind: 'settled' as const, state: action.state, summary: action.summary };
      }
      if (options.signal?.aborted) {
        const [cancelled] = await tx
          .update(schema.actions)
          .set({ state: 'cancelled', reason: 'run_cancelled', updatedAt: now })
          .where(eq(schema.actions.id, action.id))
          .returning();
        await this.record(tx, effects, tenantId, cancelled ?? action, {
          state: 'cancelled',
          summary: `Not sent: ${action.summary}`,
          audit: 'ai.action.cancelled',
          data: { reason: 'run_cancelled' },
        });
        return { kind: 'stopped' as const, state: 'cancelled' as const };
      }
      const stopped = await this.switches.activeFor(tx, {
        brandId: tool.brandId,
        agentId: action.agentId,
        toolId: tool.id,
      });
      const granted = await stillGranted(tx, action.agentId, tool.id);
      const binding = checkBinding(
        {
          state: action.state,
          approver: action.approver,
          principalId: action.principalId,
          expiresAt: action.expiresAt ?? now,
          argumentsHash: action.argumentsHash.toString('hex'),
          toolRevision: action.toolRevision,
          resourceRevision: action.resourceRevision,
          ownerEpoch: action.ownerEpoch,
        },
        {
          toolRevision: tool.revision,
          toolUsable: tool.status === 'enabled' && stopped === null && granted,
          resourceRevision: await this.adapters.revision(
            tx,
            tool,
            action.arguments,
            this.scopeOf(loaded, tenantId),
          ),
          ownerEpoch: control.ownershipEpoch,
        },
      );
      if (!binding.ok) {
        const reason =
          binding.reason === 'tool_changed'
            ? toolReason(stopped !== null, granted)
            : binding.reason;
        const [superseded] = await tx
          .update(schema.actions)
          .set({ state: 'superseded', reason, updatedAt: now })
          .where(eq(schema.actions.id, action.id))
          .returning();
        await this.record(tx, effects, tenantId, superseded ?? action, {
          state: 'superseded',
          summary: `Not sent: ${action.summary}`,
          audit: 'ai.action.superseded',
          data: { reason },
        });
        return { kind: 'stopped' as const, state: 'superseded' as const };
      }
      let op = await openOperation(tx, newId(), {
        tenantId,
        kind: `tool.${tool.name}`,
        businessKey: `action:${action.id}`,
        requestHash: action.argumentsHash,
        provider: tool.source === 'mcp' ? 'mcp' : 'demo',
        resourceType: 'action',
        resourceId: action.id,
        conversationId: action.conversationId,
        ownerEpoch: action.ownerEpoch,
        actor:
          action.basis === 'autopilot'
            ? { type: 'ai', id: 'autopilot' }
            : { type: action.approver === 'staff' ? 'staff' : 'customer', id: null },
        idempotencyKey: (id) => `hv-action-${id}`,
        detail: { tool: tool.name, toolRevision: action.toolRevision },
      });
      if (op.state !== 'pending') {
        // Sent before (a crash between sending and recording): reconciliation settles it.
        return { kind: 'settled' as const, state: action.state, summary: action.summary };
      }
      const dispatched = await moveOperation(
        tx,
        op,
        'dispatch',
        {
          attempts: op.attempts + 1,
          dispatchedAt: now,
          // If this process dies mid-call, the reconciler picks the operation up from here.
          nextReconcileAt: new Date(now.getTime() + tool.timeoutMs + 30_000),
        },
        now,
      );
      if (!dispatched) throw new Error(`operation ${op.id} could not be dispatched`);
      op = dispatched;
      await addReceipt(tx, op, {
        kind: 'dispatch',
        outcome: 'pending',
        source: 'provider_api',
        evidence: { subject: 'tool', tool: tool.name, attempt: op.attempts },
        observedAt: now,
      });
      const [executing] = await tx
        .update(schema.actions)
        .set({ state: 'executing', operationId: op.id, updatedAt: now })
        .where(eq(schema.actions.id, action.id))
        .returning();
      await this.record(tx, effects, tenantId, executing ?? action, {
        state: 'executing',
        summary: `Sending: ${action.summary}`,
        audit: 'ai.action.dispatched',
        data: { operation: toPublicId('operation', op.id) },
      });
      return { kind: 'send' as const, loaded: { ...loaded, action: executing ?? action }, op };
    });
    await effects.flush(this.journal);
    if (plan.kind === 'gone') {
      return { state: 'cancelled', summary: 'The action no longer exists.' };
    }
    if (plan.kind === 'settled') return { state: plan.state, summary: plan.summary };
    if (plan.kind === 'stopped') {
      return { state: plan.state, summary: 'The action was not sent.' };
    }

    const { loaded, op } = plan;
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(loaded.tool.timeoutMs)])
      : AbortSignal.timeout(loaded.tool.timeoutMs);
    let outcome: ToolOutcome | null = null;
    let failure: ToolCallFailure | null = null;
    try {
      outcome = await this.adapters.execute(
        loaded.tool,
        loaded.action.arguments,
        this.scopeOf(loaded, tenantId),
        { idempotencyKey: op.providerIdempotencyKey, signal },
      );
    } catch (error) {
      failure =
        error instanceof ToolCallFailure
          ? error
          : new ToolCallFailure('unexpected', 'The tool failed.', true);
    }
    return this.settle(tenantId, loaded, op.id, { outcome, failure, kind: 'response' });
  }

  /** Records what a call, a reconciliation or a person established. */
  private async settle(
    tenantId: string,
    loaded: Loaded,
    operationId: string,
    observed: {
      outcome: ToolOutcome | null;
      failure: ToolCallFailure | null;
      kind: 'response' | 'reconcile' | 'manual';
      source?: 'provider_api' | 'reconciler' | 'staff';
      actor?: { type: 'staff'; id: string };
      note?: string;
    },
  ): Promise<ExecutionResult> {
    const effects = new Effects();
    const now = this.clock();
    const source = observed.source ?? 'provider_api';
    const result = await this.tx(tenantId, async (tx) => {
      const op = await lockOperation(tx, operationId);
      const [action] = await tx
        .select()
        .from(schema.actions)
        .where(eq(schema.actions.id, loaded.action.id))
        .for('update');
      if (!op || !action) return { state: 'cancelled' as const, summary: 'Gone.' };
      if (!IN_FLIGHT_ACTION_STATES.includes(action.state)) {
        return { state: action.state, summary: action.summary };
      }
      const { outcome, failure } = observed;
      const tool = loaded.tool.name;
      let state: ActionState;
      let summary: string;
      let receipt: ReceiptRow;
      if (outcome?.status === 'succeeded') {
        await moveOperation(tx, op, 'succeed', { providerRef: outcome.reference }, now);
        receipt = await addReceipt(tx, op, {
          kind: observed.kind,
          outcome: 'succeeded',
          source,
          providerRef: outcome.reference,
          evidence: { subject: 'tool', tool, ...(observed.note ? { note: observed.note } : {}) },
          observedAt: now,
        });
        state = 'completed';
        summary = outcome.summary;
      } else if (outcome?.status === 'failed' || (failure && !failure.mayHaveApplied)) {
        const code = outcome?.status === 'failed' ? outcome.reason : (failure?.kind ?? 'failed');
        await moveOperation(tx, op, 'fail', { lastErrorCode: code }, now);
        receipt = await addReceipt(tx, op, {
          kind: observed.kind,
          outcome: 'failed',
          source,
          evidence: { subject: 'tool', tool, error: code },
          observedAt: now,
        });
        state = 'failed';
        summary =
          outcome?.status === 'failed'
            ? outcome.summary
            : `${loaded.action.summary}: it could not be done.`;
      } else {
        // No answer after sending: it may have happened. Checked with the tool, never resent.
        const moved =
          op.state === 'dispatched'
            ? await moveOperation(
                tx,
                op,
                'lose_track',
                {
                  lastErrorCode: failure?.kind ?? 'no_answer',
                  nextReconcileAt: new Date(now.getTime() + 30_000),
                },
                now,
              )
            : op;
        receipt = await addReceipt(tx, moved ?? op, {
          kind: observed.kind,
          outcome: 'unknown',
          source,
          evidence: { subject: 'tool', tool, error: failure?.kind ?? 'no_answer' },
          observedAt: now,
        });
        state = 'unknown';
        summary = `${loaded.action.summary}: the request was sent, but the result is not confirmed.`;
      }
      const [updated] = await tx
        .update(schema.actions)
        .set({
          state,
          outcomeSummary: summary.slice(0, 500),
          updatedAt: now,
          ...(state === 'completed' || state === 'failed' ? { completedAt: now } : {}),
        })
        .where(eq(schema.actions.id, action.id))
        .returning();
      const row = updated ?? action;
      await this.record(tx, effects, tenantId, row, {
        state,
        summary,
        audit: `ai.action.${state === 'completed' ? 'executed' : state}`,
        data: {
          receipt: toPublicId('receipt', receipt.id),
          source,
          ...(observed.actor ? { resolvedBy: observed.actor.id } : {}),
        },
      });
      if (state !== 'unknown' || observed.kind === 'response') {
        await this.postReceipt(tx, tenantId, { ...loaded, action: row }, receipt, summary);
      }
      return {
        state,
        summary,
        ...(outcome?.status === 'succeeded' ? { output: outcome.output } : {}),
      };
    });
    await effects.flush(this.journal);
    return result;
  }

  /**
   * Settles an action whose answer was lost, from the tool's own records (worker, or a person
   * pressing "Check status"). A tool without a lookup leaves it to a person, never resending.
   */
  async reconcileOperation(
    tenantId: string,
    operationId: string,
    trigger: 'worker' | 'staff',
  ): Promise<'settled' | 'pending' | 'skipped'> {
    const now = this.clock();
    const plan = await this.tx(tenantId, async (tx) => {
      const op = await lockOperation(tx, operationId);
      if (!op?.kind.startsWith('tool.') || !['dispatched', 'unknown'].includes(op.state)) {
        return null;
      }
      const [action] = await tx
        .select()
        .from(schema.actions)
        .where(and(eq(schema.actions.operationId, op.id)));
      if (!action) return null;
      const loaded = await this.load(tx, action.id, false);
      if (!loaded) return null;
      // A call still in flight is left alone until its timeout has surely passed.
      if (
        op.state === 'dispatched' &&
        op.dispatchedAt &&
        now.getTime() - op.dispatchedAt.getTime() < loaded.tool.timeoutMs + 5_000
      ) {
        return null;
      }
      const attempts = op.reconcileAttempts + 1;
      await tx
        .update(schema.operations)
        .set({
          reconcileAttempts: attempts,
          nextReconcileAt:
            attempts >= RECONCILE_LIMIT ? null : new Date(now.getTime() + backoffMs(attempts)),
          updatedAt: now,
        })
        .where(eq(schema.operations.id, op.id));
      return { op, loaded };
    });
    if (!plan) return 'skipped';
    const outcome = await this.adapters
      .reconcile(
        plan.loaded.tool,
        plan.loaded.action.arguments,
        this.scopeOf(plan.loaded, tenantId),
        plan.op.providerIdempotencyKey,
      )
      .catch(() => null);
    if (!outcome) {
      if (trigger === 'staff' || plan.op.state === 'dispatched') {
        await this.settle(tenantId, plan.loaded, plan.op.id, {
          outcome: null,
          failure: new ToolCallFailure('no_lookup', 'The tool cannot be checked.', true),
          kind: 'reconcile',
          source: 'reconciler',
        });
      }
      return 'pending';
    }
    await this.settle(tenantId, plan.loaded, plan.op.id, {
      outcome,
      failure: null,
      kind: 'reconcile',
      source: trigger === 'worker' ? 'reconciler' : 'provider_api',
    });
    return 'settled';
  }

  /**
   * A person checked the system an unknown action went to and records what happened (a tool
   * without a lookup). The receipt says it came from staff; nothing is sent.
   */
  async resolveManually(
    tenantId: string,
    actionId: string,
    input: { outcome: 'succeeded' | 'failed'; note: string; staffPublicId: string },
  ): Promise<ExecutionResult> {
    const loaded = await this.tx(tenantId, (tx) => this.load(tx, actionId, false));
    if (!loaded?.action.operationId || loaded.action.state !== 'unknown') {
      throw new AppError('VERSION_CONFLICT', {
        detail: 'Only an action whose result is not confirmed can be resolved by hand.',
      });
    }
    return this.settle(tenantId, loaded, loaded.action.operationId, {
      outcome:
        input.outcome === 'succeeded'
          ? {
              status: 'succeeded',
              output: {},
              reference: null,
              summary: `${loaded.action.summary}: confirmed by a team member.`,
            }
          : {
              status: 'failed',
              reason: 'not_applied',
              summary: `${loaded.action.summary}: a team member confirmed it was not done.`,
            },
      failure: null,
      kind: 'manual',
      source: 'staff',
      actor: { type: 'staff', id: input.staffPublicId },
      note: input.note.slice(0, 300),
    });
  }
}
