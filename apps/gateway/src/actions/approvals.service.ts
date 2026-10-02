import { createHash } from 'node:crypto';
import type { Action, DecideActionRequest } from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  expiredActions,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import {
  type ApprovalRefusal,
  actionCode,
  checkActionApproval,
  parseTextDecision,
  SUPERSEDING,
} from '@hamnivo/domain/actions';
import { authorizeActionApproval, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { JournalService } from '../authority/journal.service.js';
import type { ControlRow } from '../authority/ownership.service.js';
import { CommerceCardsService } from '../commerce/card-publisher.service.js';
import { Effects } from '../commerce/effects.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { InboxAccess } from '../inbox/access.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { KillSwitchesService } from '../runtime/kill-switches.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import type { WidgetClaims } from '../widget/tokens.service.js';
import { stillGranted, ToolAdapters, toolReason } from './adapters.js';
import { approvalPublication } from './cards.js';
import { ACTION_EXECUTE_TOPIC } from './executor.service.js';
import { type ActionRow, actionView } from './views.js';

type Decide = z.output<typeof DecideActionRequest>;

interface Approver {
  kind: 'customer' | 'staff';
  /** cus_… or stf_… */
  publicId: string;
  principalId: string | null;
  channel: 'widget' | 'inbox' | 'text';
  stepUp: boolean;
  evidence: Record<string, unknown>;
}

const REFUSAL_ERRORS: Record<ApprovalRefusal, () => AppError> = {
  staff_only: () =>
    new AppError('SCOPE_DENIED', { detail: 'Only a team member can approve this request.' }),
  customer_only: () =>
    new AppError('SCOPE_DENIED', {
      detail: 'Only the customer can approve this request; staff cannot approve it for them.',
    }),
  wrong_customer: () => new AppError('NOT_FOUND', { detail: 'Request not found.' }),
  not_pending: () =>
    new AppError('VERSION_CONFLICT', { detail: 'This request was already decided or cancelled.' }),
  expired: () => new AppError('APPROVAL_EXPIRED', { detail: 'This request has expired.' }),
  arguments_changed: () =>
    new AppError('APPROVAL_MISMATCH', {
      detail: 'The request is not the one you were shown. Review the current request.',
    }),
  tool_changed: () =>
    new AppError('APPROVAL_MISMATCH', {
      detail: 'The tool changed after this was proposed. A new request is needed.',
    }),
  resource_changed: () =>
    new AppError('APPROVAL_MISMATCH', {
      detail: 'The details changed after this was proposed. A new request is needed.',
    }),
  owner_changed: () =>
    new AppError('APPROVAL_MISMATCH', {
      detail: 'Someone else now handles this conversation. A new request is needed.',
    }),
};

/**
 * Approval of AI actions (G13): by the customer for their own low-risk requests (widget, or a code
 * by text where cards are not shown), by staff with `tools.approve` and the tool's permission for
 * everything else, with a fresh sign-in for money and irreversible actions. A decision is checked
 * against everything the approval is bound to; a change supersedes the action. Every approval,
 * decline, expiry and supersession is audited, and decided approvals are append-only.
 */
@Injectable()
export class ActionApprovals {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly adapters: ToolAdapters,
    private readonly switches: KillSwitchesService,
    private readonly journal: JournalService,
    private readonly access: InboxAccess,
    private readonly cards: CommerceCardsService,
  ) {}

  private async latest(tx: TenantTx, action: ActionRow) {
    const [approval] = await tx
      .select()
      .from(schema.actionApprovals)
      .where(eq(schema.actionApprovals.actionId, action.id));
    const receipt = action.operationId
      ? (
          await tx
            .select()
            .from(schema.operationReceipts)
            .where(eq(schema.operationReceipts.operationId, action.operationId))
            .orderBy(desc(schema.operationReceipts.createdAt))
            .limit(1)
        )[0]
      : undefined;
    return { approval: approval ?? null, receipt: receipt ?? null };
  }

  async view(tx: TenantTx, action: ActionRow, staff: boolean): Promise<Action> {
    return actionView(action, { ...(await this.latest(tx, action)), staff });
  }

  /** The bound values as they are now. */
  private async current(tx: TenantTx, action: ActionRow, control: ControlRow) {
    const [tool] = await tx
      .select()
      .from(schema.toolDefinitions)
      .where(eq(schema.toolDefinitions.id, action.toolId));
    if (!tool) {
      return {
        toolRevision: -1,
        toolUsable: false,
        resourceRevision: null,
        ownerEpoch: -1,
        toolReason: 'tool_changed',
      };
    }
    const stopped = await this.switches.activeFor(tx, {
      brandId: tool.brandId,
      agentId: action.agentId,
      toolId: tool.id,
    });
    const granted = await stillGranted(tx, action.agentId, tool.id);
    return {
      toolRevision: tool.revision,
      toolUsable: tool.status === 'enabled' && stopped === null && granted,
      toolReason: toolReason(stopped !== null, granted),
      resourceRevision: await this.adapters.revision(tx, tool, action.arguments, {
        tenantId: action.tenantId,
        brandId: tool.brandId,
        conversationId: action.conversationId,
        principalId: control.principalId,
      }),
      ownerEpoch: control.ownershipEpoch,
    };
  }

  /**
   * Records one decision on a locked action. Returns the refusal (after superseding the action
   * when a bound value changed), or null when recorded.
   */
  private async decide(
    tx: TenantTx,
    effects: Effects,
    action: ActionRow,
    control: ControlRow,
    approver: Approver,
    input: {
      decision: 'approve' | 'decline';
      argumentsHash: string;
      clientRequestId: string;
      reason?: string;
    },
  ): Promise<ApprovalRefusal | null> {
    const now = this.clock();
    // A decline needs no fresh binding: saying no is always allowed while it is pending.
    const current =
      input.decision === 'decline'
        ? {
            toolRevision: action.toolRevision,
            toolUsable: true,
            resourceRevision: action.resourceRevision,
            ownerEpoch: action.ownerEpoch,
            toolReason: 'tool_changed',
          }
        : await this.current(tx, action, control);
    const check = checkActionApproval(
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
        kind: approver.kind,
        principalId: approver.principalId,
        argumentsHash: input.argumentsHash,
        now,
      },
      current,
    );
    const publicId = toPublicId('action', action.id);
    const lane = action.approver === 'customer' ? ('customer' as const) : ('staff' as const);
    if (!check.ok) {
      if (check.reason === 'expired' && action.state === 'awaiting_approval') {
        await this.expire(tx, effects, action, now);
      } else if (SUPERSEDING.has(check.reason) && action.state === 'awaiting_approval') {
        const reason = check.reason === 'tool_changed' ? current.toolReason : check.reason;
        await tx
          .update(schema.actions)
          .set({ state: 'superseded', reason, updatedAt: now })
          .where(eq(schema.actions.id, action.id));
        effects.add(
          action.tenantId,
          action.conversationId,
          await this.journal.append(tx, action.tenantId, action.conversationId, [
            {
              lane,
              type: 'approval.updated',
              data: { approvalId: publicId, status: 'superseded' },
            },
          ]),
        );
        await appendAudit(tx, {
          actorType: approver.kind,
          actorId: approver.publicId,
          action: 'ai.action.superseded',
          targetType: 'action',
          targetId: publicId,
          outcome: 'success',
          occurredAt: now,
          data: { tool: action.toolName, reason },
        });
      } else {
        await appendAudit(tx, {
          actorType: approver.kind,
          actorId: approver.publicId,
          action: 'ai.action.approval_refused',
          targetType: 'action',
          targetId: publicId,
          outcome: 'denied',
          occurredAt: now,
          data: { tool: action.toolName, reason: check.reason, channel: approver.channel },
        });
      }
      return check.reason;
    }
    const approved = input.decision === 'approve';
    await tx.insert(schema.actionApprovals).values({
      tenantId: action.tenantId,
      actionId: action.id,
      decision: approved ? 'approved' : 'declined',
      approverKind: approver.kind,
      approverId: approver.publicId,
      clientRequestId: input.clientRequestId,
      argumentsHash: action.argumentsHash,
      toolRevision: action.toolRevision,
      resourceRevision: action.resourceRevision,
      ownerEpoch: action.ownerEpoch,
      stepUp: approver.stepUp,
      channel: approver.channel,
      evidence: approver.evidence,
      reason: input.reason ?? null,
      decidedAt: now,
    });
    await tx
      .update(schema.actions)
      .set({
        state: approved ? 'approved' : 'declined',
        ...(approved ? {} : { reason: 'declined' }),
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.actions.id, action.id));
    if (approved) {
      await enqueueOutbox(tx, action.tenantId, {
        topic: ACTION_EXECUTE_TOPIC,
        aggregateType: 'action',
        aggregateId: action.id,
        payload: { actionId: action.id },
      });
    }
    effects.add(
      action.tenantId,
      action.conversationId,
      await this.journal.append(tx, action.tenantId, action.conversationId, [
        {
          lane,
          type: 'approval.updated',
          data: { approvalId: publicId, status: approved ? 'approved' : 'denied' },
        },
      ]),
    );
    await appendAudit(tx, {
      actorType: approver.kind,
      actorId: approver.publicId,
      action: approved ? 'ai.action.approved' : 'ai.action.declined',
      targetType: 'action',
      targetId: publicId,
      outcome: 'success',
      occurredAt: now,
      data: {
        tool: action.toolName,
        risk: action.risk,
        channel: approver.channel,
        stepUp: approver.stepUp,
        argumentsHash: action.argumentsHash.toString('hex'),
        toolRevision: action.toolRevision,
        ownerEpoch: action.ownerEpoch,
      },
    });
    return null;
  }

  private async expire(tx: TenantTx, effects: Effects, action: ActionRow, now: Date) {
    const [row] = await tx
      .update(schema.actions)
      .set({ state: 'expired', reason: 'expired', updatedAt: now })
      .where(and(eq(schema.actions.id, action.id), eq(schema.actions.state, 'awaiting_approval')))
      .returning();
    if (!row) return;
    const publicId = toPublicId('action', action.id);
    effects.add(
      action.tenantId,
      action.conversationId,
      await this.journal.append(tx, action.tenantId, action.conversationId, [
        {
          lane: action.approver === 'customer' ? 'customer' : 'staff',
          type: 'approval.updated',
          data: { approvalId: publicId, status: 'expired' },
        },
      ]),
    );
    await appendAudit(tx, {
      actorType: 'system',
      actorId: 'actions',
      action: 'ai.action.expired',
      targetType: 'action',
      targetId: publicId,
      outcome: 'success',
      occurredAt: now,
      data: { tool: action.toolName },
    });
  }

  /** A decision already recorded under this request id (a repeated tap) returns the same result. */
  private async replayed(tx: TenantTx, clientRequestId: string, actionId: string) {
    const [previous] = await tx
      .select()
      .from(schema.actionApprovals)
      .where(eq(schema.actionApprovals.clientRequestId, clientRequestId));
    if (!previous) return null;
    if (previous.actionId !== actionId) throw new AppError('IDEMPOTENCY_CONFLICT');
    return previous;
  }

  // ── Customers (widget) ────────────────────────────────────────────────────────────────

  private async customerControl(tx: TenantTx, claims: WidgetClaims, conversationPublicId: string) {
    const [control] = await tx
      .select()
      .from(schema.conversationControls)
      .where(
        eq(schema.conversationControls.id, fromPublicId('conversation', conversationPublicId)),
      );
    if (
      !control ||
      control.principalId !== claims.principalId ||
      control.brandId !== claims.brandId
    ) {
      throw new AppError('NOT_FOUND', { detail: 'Conversation not found.' });
    }
    return control;
  }

  private async actionIn(
    tx: TenantTx,
    conversationId: string,
    actionPublicId: string,
    lock = false,
  ) {
    const query = tx
      .select()
      .from(schema.actions)
      .where(
        and(
          eq(schema.actions.id, fromPublicId('action', actionPublicId)),
          eq(schema.actions.conversationId, conversationId),
        ),
      );
    const [action] = lock ? await query.for('update') : await query;
    if (!action) throw new AppError('NOT_FOUND', { detail: 'Request not found.' });
    return action;
  }

  private customerTx<T>(claims: WidgetClaims, work: (tx: TenantTx) => Promise<T>) {
    return withTenant(
      this.db,
      { tenantId: claims.tenantId, actorId: toPublicId('customer', claims.principalId) },
      work,
    );
  }

  /** An action of the customer's own conversation, as they may see it. */
  async getForCustomer(claims: WidgetClaims, conversationId: string, actionId: string) {
    return this.customerTx(claims, async (tx) => {
      const control = await this.customerControl(tx, claims, conversationId);
      const action = await this.actionIn(tx, control.id, actionId);
      return this.view(tx, action, false);
    });
  }

  /**
   * The customer's decision on their own request. A customer can never approve an action that
   * needs staff; one that asks the customer to confirm who they are needs a verified identity from
   * the website, signed in within the step-up window.
   */
  async decideAsCustomer(
    claims: WidgetClaims,
    conversationId: string,
    actionId: string,
    input: Decide,
    context: { locale: string | null; origin: string | null },
  ): Promise<Action> {
    const effects = new Effects();
    const view = await this.customerTx(claims, async (tx) => {
      const control = await this.customerControl(tx, claims, conversationId);
      const action = await this.actionIn(tx, control.id, actionId, true);
      if (await this.replayed(tx, input.clientRequestId, action.id))
        return this.view(tx, action, false);
      // The identity check is for the customer's own requests; a staff action is refused below.
      if (action.approver === 'customer' && action.stepUp && input.decision === 'approve') {
        const [session] = await tx
          .select()
          .from(schema.widgetSessions)
          .where(eq(schema.widgetSessions.id, claims.sessionId));
        const fresh =
          claims.verified &&
          session?.identityKeyId !== null &&
          session !== undefined &&
          this.clock().getTime() - session.createdAt.getTime() <=
            this.config.STEP_UP_MAX_AGE_MINUTES * 60_000;
        if (!fresh) {
          throw new AppError('IDENTITY_REQUIRED', {
            detail: 'Please confirm who you are on the website, then approve again.',
          });
        }
      }
      const refusal = await this.decide(
        tx,
        effects,
        action,
        control,
        {
          kind: 'customer',
          publicId: toPublicId('customer', claims.principalId),
          principalId: claims.principalId,
          channel: 'widget',
          stepUp: action.stepUp,
          evidence: {
            session: toPublicId('session', claims.sessionId),
            widget: claims.widgetId,
            verifiedCustomer: claims.verified,
            locale: context.locale,
            origin: context.origin,
          },
        },
        input,
      );
      if (refusal) return { refusal };
      const [updated] = await tx
        .select()
        .from(schema.actions)
        .where(eq(schema.actions.id, action.id));
      return this.view(tx, updated ?? action, false);
    });
    await effects.flush(this.journal);
    if ('refusal' in view) throw REFUSAL_ERRORS[view.refusal as ApprovalRefusal]();
    return view;
  }

  // ── Staff (inbox) ─────────────────────────────────────────────────────────────────────

  async listForStaff(principal: StaffPrincipal, conversationId: string): Promise<Action[]> {
    return this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(
        tx,
        principal,
        conversationId,
        'conversations.read',
      );
      const rows = await tx
        .select()
        .from(schema.actions)
        .where(eq(schema.actions.conversationId, found.control.id))
        .orderBy(desc(schema.actions.createdAt))
        .limit(50);
      const views: Action[] = [];
      for (const row of rows) views.push(await this.view(tx, row, true));
      return views;
    });
  }

  /**
   * A staff member's decision: `tools.approve` and the tool's own permission where the
   * conversation lives, and a fresh sign-in for money and irreversible actions.
   */
  async decideAsStaff(
    principal: StaffPrincipal,
    conversationId: string,
    actionId: string,
    input: Decide,
  ): Promise<Action> {
    const effects = new Effects();
    const view = await this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(
        tx,
        principal,
        conversationId,
        'conversations.read',
      );
      const action = await this.actionIn(tx, found.control.id, actionId, true);
      if (await this.replayed(tx, input.clientRequestId, action.id))
        return this.view(tx, action, true);
      if (action.approver === 'staff') {
        enforce(
          authorizeActionApproval(
            principal,
            { risk: action.risk, requiredPermission: action.requiredPermission },
            found.resource,
            {
              now: this.clock(),
              stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
            },
          ),
        );
      }
      const refusal = await this.decide(
        tx,
        effects,
        action,
        found.control,
        {
          kind: 'staff',
          publicId: toPublicId('staff', principal.staffMemberId),
          principalId: null,
          channel: 'inbox',
          stepUp: action.risk === 'money' || action.risk === 'irreversible',
          evidence: { mfa: principal.mfa },
        },
        input,
      );
      if (refusal) return { refusal };
      const [updated] = await tx
        .select()
        .from(schema.actions)
        .where(eq(schema.actions.id, action.id));
      return this.view(tx, updated ?? action, true);
    });
    await effects.flush(this.journal);
    if ('refusal' in view) throw REFUSAL_ERRORS[view.refusal as ApprovalRefusal]();
    return view;
  }

  // ── Text approvals (channels without cards) ───────────────────────────────────────────

  /**
   * "APPROVE 4F2A9C" from the customer of the conversation. Only their own pending requests that
   * need no identity check; true when the message was such an answer (no AI reply follows).
   */
  async decideByText(
    tenantId: string,
    control: ControlRow,
    text: string,
    messageRef: string,
  ): Promise<boolean> {
    const parsed = parseTextDecision(text);
    const principalId = control.principalId;
    if (!parsed || !principalId) return false;
    const effects = new Effects();
    const clientRequestId = uuidFromRef(`${control.id}:${messageRef}`);
    const handled = await withTenant(this.db, { tenantId, actorId: 'customer' }, async (tx) => {
      // The same message handled again (an outbox retry): the decision already stands.
      const [previous] = await tx
        .select({ id: schema.actionApprovals.id })
        .from(schema.actionApprovals)
        .where(eq(schema.actionApprovals.clientRequestId, clientRequestId));
      if (previous) return true;
      const pending = await tx
        .select()
        .from(schema.actions)
        .where(
          and(
            eq(schema.actions.conversationId, control.id),
            eq(schema.actions.approver, 'customer'),
            eq(schema.actions.stepUp, false),
            eq(schema.actions.code, parsed.code),
            eq(schema.actions.state, 'awaiting_approval'),
            eq(schema.actions.principalId, principalId),
          ),
        )
        .for('update');
      const action = pending.find((a) => actionCode(toPublicId('action', a.id)) === parsed.code);
      if (!action) return false;
      const [locked] = await tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, control.id));
      const refusal = await this.decide(
        tx,
        effects,
        action,
        locked ?? control,
        {
          kind: 'customer',
          publicId: toPublicId('customer', principalId),
          principalId,
          channel: 'text',
          stepUp: false,
          evidence: { message: messageRef },
        },
        {
          decision: parsed.decision,
          argumentsHash: action.argumentsHash.toString('hex'),
          clientRequestId,
        },
      );
      // Where cards are not shown, the answer is acknowledged in words.
      if (!refusal) {
        const [brand] = control.brandId
          ? await tx
              .select({ name: schema.brands.name })
              .from(schema.brands)
              .where(eq(schema.brands.id, control.brandId))
          : [];
        await this.cards.enqueue(
          tx,
          tenantId,
          locked ?? control,
          approvalPublication(
            action,
            brand?.name ?? 'Support',
            null,
            parsed.decision === 'approve' ? 'approved' : 'denied',
          ),
          `approval-decided:${action.id}`,
        );
      }
      return true;
    });
    await effects.flush(this.journal);
    return handled;
  }

  // ── Expiry (worker) ───────────────────────────────────────────────────────────────────

  /** Approvals nobody decided in time; returns how many expired. */
  async expireOverdue(limit = 100): Promise<number> {
    const due = await expiredActions(this.db, limit, this.clock());
    let count = 0;
    for (const item of due) {
      const effects = new Effects();
      await withTenant(this.db, { tenantId: item.tenantId, actorId: 'actions' }, async (tx) => {
        const [action] = await tx
          .select()
          .from(schema.actions)
          .where(eq(schema.actions.id, item.id))
          .for('update');
        if (action?.state === 'awaiting_approval') {
          await this.expire(tx, effects, action, this.clock());
          count += 1;
        }
      });
      await effects.flush(this.journal);
    }
    return count;
  }
}

/** A stable UUID for a text decision (the message is the request). */
function uuidFromRef(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
