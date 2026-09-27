import type { BulkRequest, BulkResult, ErrorCode } from '@hamnivo/contracts';
import { appendAudit, toPublicId } from '@hamnivo/db';
import type { Permission, StaffPrincipal } from '@hamnivo/policy';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { enforce } from '../identity/staff.guard.js';
import { InboxAccess } from './access.js';
import { AnnotationsService } from './annotations.service.js';
import { AssignmentService } from './assignment.service.js';
import { StatusService } from './status.service.js';

type Action = z.output<typeof BulkRequest>['action'];
type ItemResult = z.infer<typeof BulkResult>['results'][number];

/** The permission each bulk action needs on every conversation, on top of conversations.bulk. */
function permissionOf(action: Action): Permission {
  switch (action.type) {
    case 'assign':
    case 'team':
      return action.type === 'assign' && action.to.kind === 'me'
        ? 'conversations.takeover'
        : 'conversations.assign';
    case 'status':
      return 'conversations.status';
    case 'tags':
      return 'conversations.tag';
  }
}

/**
 * Bulk operations (H15): one change applied to each selected conversation separately, with the
 * same checks as a single change and a result per conversation. A dry run reports which ones
 * would be allowed. Failures do not stop the others, and retrying sends only the failed ones.
 */
@Injectable()
export class BulkService {
  constructor(
    private readonly access: InboxAccess,
    private readonly assignment: AssignmentService,
    private readonly status: StatusService,
    private readonly annotations: AnnotationsService,
  ) {}

  async apply(
    principal: StaffPrincipal,
    input: z.output<typeof BulkRequest>,
  ): Promise<z.infer<typeof BulkResult>> {
    const ids = [...new Set(input.conversationIds)];
    const permission = permissionOf(input.action);
    const results: ItemResult[] = [];
    for (const id of ids) {
      try {
        const epoch = await this.access.tx(principal, async (tx) => {
          const found = await this.access.authorized(tx, principal, id, 'conversations.read');
          enforce(this.access.decide(principal, 'conversations.bulk', found.resource));
          enforce(this.access.decide(principal, permission, found.resource));
          return found.control.ownershipEpoch;
        });
        if (input.dryRun) {
          results.push({ conversationId: id, outcome: 'eligible', code: null, detail: null });
          continue;
        }
        const changed = await this.one(principal, id, input.action, epoch);
        results.push({
          conversationId: id,
          outcome: changed ? 'done' : 'unchanged',
          code: null,
          detail: null,
        });
      } catch (error) {
        const code: ErrorCode = error instanceof AppError ? error.code : 'INTERNAL';
        results.push({
          conversationId: id,
          outcome: 'failed',
          code,
          detail: error instanceof AppError ? (error.details.detail ?? null) : null,
        });
      }
    }
    const count = (outcome: ItemResult['outcome']) =>
      results.filter((r) => r.outcome === outcome).length;
    const summary = {
      done: count('done'),
      unchanged: count('unchanged'),
      eligible: count('eligible'),
      failed: count('failed'),
    };
    if (!input.dryRun) {
      await this.access.tx(principal, (tx) =>
        appendAudit(tx, {
          actorType: 'staff',
          actorId: toPublicId('staff', principal.staffMemberId),
          action: 'inbox.bulk_applied',
          targetType: 'inbox',
          targetId: null,
          outcome: summary.failed > 0 && summary.done === 0 ? 'failed' : 'success',
          data: { action: input.action.type, ...summary },
        }),
      );
    }
    return { dryRun: input.dryRun, results, summary };
  }

  /** Applies the action to one conversation; false when it already was that way. */
  private async one(
    principal: StaffPrincipal,
    id: string,
    action: Action,
    epoch: number,
  ): Promise<boolean> {
    switch (action.type) {
      case 'assign': {
        // The epoch seen at the check: a change made meanwhile by someone else is not overwritten.
        const after = await this.assignment.assign(principal, id, {
          to: action.to,
          expectedEpoch: epoch,
        });
        return after.ownershipEpoch !== epoch;
      }
      case 'team':
        await this.assignment.setTeam(principal, id, action.teamId);
        return true;
      case 'status':
        await this.status.set(principal, id, {
          status: action.status,
          ...(action.snoozedUntil ? { snoozedUntil: action.snoozedUntil } : {}),
        });
        return true;
      case 'tags': {
        const current = await this.annotations.tags(principal, id);
        const remove = new Set(action.remove.map((t) => t.toLowerCase()));
        const next = [
          ...current.labels.filter((t) => !remove.has(t.toLowerCase())),
          ...action.add.filter(
            (t) => !current.labels.some((c) => c.toLowerCase() === t.toLowerCase()),
          ),
        ];
        const same =
          next.length === current.labels.length && next.every((t) => current.labels.includes(t));
        if (same) return false;
        await this.annotations.setTags(principal, id, next);
        return true;
      }
    }
  }
}
