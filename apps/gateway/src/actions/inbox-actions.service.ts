import type { Action, ResolveActionRequest } from '@hamnivo/contracts';
import { appendAudit, fromPublicId, schema, toPublicId } from '@hamnivo/db';
import { authorizeActionApproval, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { InboxAccess } from '../inbox/access.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { CLOCK, type Clock, CONFIG } from '../tokens.js';
import { ActionApprovals } from './approvals.service.js';
import { ActionExecutor } from './executor.service.js';

export const ACTION_RECONCILE_TOPIC = 'action.reconcile';

/**
 * Staff tools for actions whose outcome is open (HNV-13-05): "Check status" asks the tool's own
 * records (in the worker, where tools run) and never sends the action again; when a tool cannot be
 * checked, a person who checked the other system records the result.
 */
@Injectable()
export class InboxActions {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: InboxAccess,
    private readonly approvals: ActionApprovals,
    private readonly executor: ActionExecutor,
  ) {}

  private options() {
    return { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000 };
  }

  async check(
    principal: StaffPrincipal,
    conversationId: string,
    actionId: string,
  ): Promise<Action> {
    return this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(tx, principal, conversationId, 'tools.approve');
      const [action] = await tx
        .select()
        .from(schema.actions)
        .where(
          and(
            eq(schema.actions.id, fromPublicId('action', actionId)),
            eq(schema.actions.conversationId, found.control.id),
          ),
        );
      if (!action) throw new AppError('NOT_FOUND', { detail: 'Action not found.' });
      if (action.operationId && ['executing', 'unknown'].includes(action.state)) {
        await enqueueOutbox(tx, principal.tenantId, {
          topic: ACTION_RECONCILE_TOPIC,
          aggregateType: 'action',
          aggregateId: action.id,
          payload: { operationId: action.operationId },
        });
        await appendAudit(tx, {
          actorType: 'staff',
          actorId: toPublicId('staff', principal.staffMemberId),
          action: 'ai.action.check_requested',
          targetType: 'action',
          targetId: actionId,
          outcome: 'success',
          data: { tool: action.toolName },
        });
      }
      return this.approvals.view(tx, action, true);
    });
  }

  async resolve(
    principal: StaffPrincipal,
    conversationId: string,
    actionId: string,
    input: z.output<typeof ResolveActionRequest>,
  ): Promise<Action> {
    const action = await this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(
        tx,
        principal,
        conversationId,
        'conversations.read',
      );
      const [row] = await tx
        .select()
        .from(schema.actions)
        .where(
          and(
            eq(schema.actions.id, fromPublicId('action', actionId)),
            eq(schema.actions.conversationId, found.control.id),
          ),
        );
      if (!row) throw new AppError('NOT_FOUND', { detail: 'Action not found.' });
      enforce(
        authorizeActionApproval(
          principal,
          { risk: row.risk, requiredPermission: row.requiredPermission },
          found.resource,
          this.options(),
        ),
      );
      return row;
    });
    await this.executor.resolveManually(principal.tenantId, action.id, {
      outcome: input.outcome,
      note: input.note,
      staffPublicId: toPublicId('staff', principal.staffMemberId),
    });
    return this.access.tx(principal, async (tx) => {
      const [row] = await tx.select().from(schema.actions).where(eq(schema.actions.id, action.id));
      return this.approvals.view(tx, row ?? action, true);
    });
  }
}
