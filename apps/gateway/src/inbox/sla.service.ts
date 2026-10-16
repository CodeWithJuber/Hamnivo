import type { SetSlaPolicyRequest, SlaOverdue, SlaPolicy } from '@hamnivo/contracts';
import {
  appendAudit,
  type ClaimedOutboxEvent,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { authorize, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { JournalService } from '../authority/journal.service.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { SLA_RESYNC_TOPIC, syncSla } from './sla.js';
import { teamTakesBrand } from './team-queue.js';

const NO_TARGETS: SlaPolicy['targets'] = {
  urgent: { firstReplyMinutes: null, nextReplyMinutes: null },
  high: { firstReplyMinutes: null, nextReplyMinutes: null },
  medium: { firstReplyMinutes: null, nextReplyMinutes: null },
  low: { firstReplyMinutes: null, nextReplyMinutes: null },
};

const NO_ESCALATION: SlaOverdue = {
  alertLeads: false,
  moveAfterMinutes: null,
  moveTo: { kind: 'queue' },
};

type PolicyRow = typeof schema.slaPolicies.$inferSelect;

function policyOf(row: PolicyRow): SlaPolicy {
  return {
    enabled: row.enabled,
    targets: row.targets,
    overdue: {
      alertLeads: row.overdueAlertLeads,
      moveAfterMinutes: row.overdueMoveAfterMinutes,
      moveTo: row.overdueMoveTeamId
        ? { kind: 'team', teamId: toPublicId('team', row.overdueMoveTeamId) }
        : { kind: 'queue' },
    },
    updatedAt: row.updatedAt.toISOString(),
  };
}

const RESYNC_BATCH = 200;

/**
 * Asks the brand's open conversations to recompute their reply-time clocks (H12), after its targets
 * or hours changed at `changedAt`.
 */
export async function queueSlaResync(
  tx: TenantTx,
  tenantId: string,
  brandId: string,
  changedAt: Date,
) {
  await enqueueOutbox(tx, tenantId, {
    topic: SLA_RESYNC_TOPIC,
    aggregateType: 'brand',
    aggregateId: brandId,
    payload: { brandId, changedAt: changedAt.toISOString() },
  });
}

/**
 * Reply-time targets (H12): the brand's targets, set by people who configure its inbox, and the
 * worker's side, which checks a conversation when its deadline comes and recomputes a brand's
 * clocks after its targets or business hours changed.
 */
@Injectable()
export class SlaService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly journal: JournalService,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private async brand(tx: TenantTx, principal: StaffPrincipal, brandPublicId: string) {
    let brandId: string;
    try {
      brandId = fromPublicId('brand', brandPublicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    }
    const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
    if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    enforce(
      authorize(
        principal,
        'inbox.manage',
        { workspaceId: brand.workspaceId, brandId },
        {
          now: this.clock(),
          stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
        },
      ),
    );
    return brand;
  }

  async get(principal: StaffPrincipal, brandPublicId: string): Promise<SlaPolicy> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandPublicId);
      const [row] = await tx
        .select()
        .from(schema.slaPolicies)
        .where(eq(schema.slaPolicies.brandId, brand.id));
      return row
        ? policyOf(row)
        : { enabled: false, targets: NO_TARGETS, overdue: NO_ESCALATION, updatedAt: null };
    });
  }

  async set(
    principal: StaffPrincipal,
    brandPublicId: string,
    input: SetSlaPolicyRequest,
  ): Promise<SlaPolicy> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandPublicId);
      const now = this.clock();
      const values = {
        enabled: input.enabled,
        targets: input.targets,
        ...(input.overdue ? await this.overdueColumns(tx, brand, input.overdue) : {}),
        updatedBy: principal.staffMemberId,
        updatedAt: now,
      };
      const [row] = await tx
        .insert(schema.slaPolicies)
        .values({ tenantId: principal.tenantId, brandId: brand.id, ...values })
        .onConflictDoUpdate({
          target: [schema.slaPolicies.tenantId, schema.slaPolicies.brandId],
          set: values,
        })
        .returning();
      if (!row) throw new Error('sla policy upsert returned nothing');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'brand.sla_policy.updated',
        targetType: 'brand',
        targetId: toPublicId('brand', brand.id),
        outcome: 'success',
        data: {
          enabled: input.enabled,
          targets: input.targets,
          ...(input.overdue ? { overdue: input.overdue } : {}),
        },
      });
      await queueSlaResync(tx, principal.tenantId, brand.id, now);
      return policyOf(row);
    });
  }

  /**
   * What happens to overdue conversations, as stored (ADR 0016). The team they are moved to must
   * be able to take the brand's conversations, as when a person puts one in a team's queue.
   */
  private async overdueColumns(tx: TenantTx, brand: { workspaceId: string }, overdue: SlaOverdue) {
    let teamId: string | null = null;
    // A team only matters when conversations are moved; without the move none is kept.
    if (overdue.moveTo.kind === 'team' && overdue.moveAfterMinutes !== null) {
      const unusable = new AppError('VALIDATION_FAILED', {
        fields: [
          {
            path: 'overdue.moveTo.teamId',
            message: 'This team cannot take conversations of this brand.',
          },
        ],
      });
      try {
        teamId = fromPublicId('team', overdue.moveTo.teamId);
      } catch {
        throw unusable;
      }
      const [team] = await tx.select().from(schema.teams).where(eq(schema.teams.id, teamId));
      if (!teamTakesBrand(team, brand.workspaceId)) throw unusable;
    }
    return {
      overdueAlertLeads: overdue.alertLeads,
      overdueMoveAfterMinutes: overdue.moveAfterMinutes,
      overdueMoveTeamId: teamId,
    };
  }

  /** A deadline came: recompute under the conversation's lock; a moved deadline does nothing. */
  async onDue(event: ClaimedOutboxEvent): Promise<void> {
    const { conversationId } = event.payload as { conversationId: string };
    const breached = await withTenant(
      this.db,
      { tenantId: event.tenantId, actorId: 'sla' },
      async (tx) => {
        const [locked] = await tx
          .select({ id: schema.conversationControls.id })
          .from(schema.conversationControls)
          .where(eq(schema.conversationControls.id, conversationId))
          .for('update');
        if (!locked) return false;
        return (await syncSla(tx, event.tenantId, conversationId, this.clock())).breached;
      },
    );
    if (breached) await this.journal.signalInbox(event.tenantId, conversationId);
  }

  /** The brand's targets or hours changed: every open conversation recomputes its clock. */
  async onResync(event: ClaimedOutboxEvent): Promise<void> {
    const { brandId, changedAt } = event.payload as { brandId: string; changedAt?: string };
    const escalateFrom = changedAt ? new Date(changedAt) : event.createdAt;
    let after: string | null = null;
    for (;;) {
      const cursor: string | null = after;
      const ids: { id: string }[] = await withTenant(
        this.db,
        { tenantId: event.tenantId, actorId: 'sla' },
        (tx) =>
          tx
            .select({ id: schema.conversationControls.id })
            .from(schema.conversationControls)
            .where(
              and(
                eq(schema.conversationControls.brandId, brandId),
                inArray(schema.conversationControls.authorityStatus, [
                  'open',
                  'pending',
                  'snoozed',
                ]),
                cursor ? gt(schema.conversationControls.id, cursor) : undefined,
              ),
            )
            .orderBy(asc(schema.conversationControls.id))
            .limit(RESYNC_BATCH),
      );
      for (const { id } of ids) {
        const breached = await withTenant(
          this.db,
          { tenantId: event.tenantId, actorId: 'sla' },
          async (tx) => {
            await tx
              .select({ id: schema.conversationControls.id })
              .from(schema.conversationControls)
              .where(eq(schema.conversationControls.id, id))
              .for('update');
            // Deadlines the change itself put behind the conversation are not escalated.
            return (await syncSla(tx, event.tenantId, id, this.clock(), { escalateFrom })).breached;
          },
        );
        if (breached) await this.journal.signalInbox(event.tenantId, id);
      }
      if (ids.length < RESYNC_BATCH) return;
      after = ids.at(-1)?.id ?? null;
    }
  }
}
