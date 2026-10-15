import type { SetSlaPolicyRequest, SlaPolicy } from '@hamnivo/contracts';
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

const NO_TARGETS: SlaPolicy['targets'] = {
  urgent: { firstReplyMinutes: null, nextReplyMinutes: null },
  high: { firstReplyMinutes: null, nextReplyMinutes: null },
  medium: { firstReplyMinutes: null, nextReplyMinutes: null },
  low: { firstReplyMinutes: null, nextReplyMinutes: null },
};

const RESYNC_BATCH = 200;

/** Asks the brand's open conversations to recompute their reply-time clocks (H12). */
export async function queueSlaResync(tx: TenantTx, tenantId: string, brandId: string) {
  await enqueueOutbox(tx, tenantId, {
    topic: SLA_RESYNC_TOPIC,
    aggregateType: 'brand',
    aggregateId: brandId,
    payload: { brandId },
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
        ? { enabled: row.enabled, targets: row.targets, updatedAt: row.updatedAt.toISOString() }
        : { enabled: false, targets: NO_TARGETS, updatedAt: null };
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
        data: { enabled: input.enabled, targets: input.targets },
      });
      await queueSlaResync(tx, principal.tenantId, brand.id);
      return { enabled: row.enabled, targets: row.targets, updatedAt: row.updatedAt.toISOString() };
    });
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
    const { brandId } = event.payload as { brandId: string };
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
            return (await syncSla(tx, event.tenantId, id, this.clock())).breached;
          },
        );
        if (breached) await this.journal.signalInbox(event.tenantId, id);
      }
      if (ids.length < RESYNC_BATCH) return;
      after = ids.at(-1)?.id ?? null;
    }
  }
}
