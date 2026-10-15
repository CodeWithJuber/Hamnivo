import { appendAudit, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import {
  type BusinessHours,
  nextSlaClock,
  type SlaClock,
  type SlaTargets,
  slaView,
} from '@hamnivo/domain';
import { and, eq, sql } from 'drizzle-orm';
import { enqueueOutbox } from '../outbox/outbox.js';

/** Outbox topic of a reply-time deadline (H12): fires when it is due, and checks again. */
export const SLA_DUE_TOPIC = 'conversation.sla_due';
/** Outbox topic that recomputes a brand's running clocks after its targets or hours changed. */
export const SLA_RESYNC_TOPIC = 'brand.sla_resync';

type InboxStateRow = typeof schema.conversationInboxState.$inferSelect;

function clockOf(row: InboxStateRow | undefined): SlaClock | null {
  if (!row?.slaKind || !row.slaStartedAt || !row.slaTargetMinutes) return null;
  return {
    kind: row.slaKind,
    startedAt: row.slaStartedAt,
    targetMinutes: row.slaTargetMinutes,
    pausedAt: row.slaPausedAt,
    pausedMinutes: row.slaPausedMinutes,
    dueAt: row.slaDueAt,
    breachedAt: row.slaBreachedAt,
  };
}

/** The clock as a screen shows it (`InboxSla`), from the stored columns. */
export function slaOf(
  row: Pick<
    InboxStateRow,
    | 'slaKind'
    | 'slaStartedAt'
    | 'slaTargetMinutes'
    | 'slaPausedAt'
    | 'slaPausedMinutes'
    | 'slaDueAt'
    | 'slaBreachedAt'
  > | null,
  hours: BusinessHours | null,
  now: Date,
) {
  const clock = clockOf((row ?? undefined) as InboxStateRow | undefined);
  if (!clock) return null;
  const view = slaView(clock, hours, now);
  return {
    kind: clock.kind,
    state: view.state,
    dueAt: view.dueAt?.toISOString() ?? null,
    businessMinutesLeft: view.businessMinutesLeft,
    breached: view.breached,
    targetMinutes: clock.targetMinutes,
  };
}

/**
 * A person wrote a public reply (H12): it ends the reply-time clock. AI and automation replies
 * never call this, so they do not stop a customer waiting for a person.
 */
export async function recordHumanReply(
  tx: TenantTx,
  tenantId: string,
  conversationId: string,
  at: Date,
): Promise<void> {
  await tx
    .insert(schema.conversationInboxState)
    .values({ tenantId, conversationId, lastHumanReplyAt: at })
    .onConflictDoUpdate({
      target: [
        schema.conversationInboxState.tenantId,
        schema.conversationInboxState.conversationId,
      ],
      set: {
        lastHumanReplyAt: sql`greatest(${schema.conversationInboxState.lastHumanReplyAt}, ${at.toISOString()}::timestamptz)`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Recomputes a conversation's reply-time clock from what is stored (H12) and keeps it. Called
 * after anything that can move it: a customer message, a person's reply, an owner, status or
 * priority change, and when a deadline comes. When the deadline moves, a check is queued for the
 * new time; when it has just passed, that is audited (and the inbox alerts the team).
 * Returns whether the conversation has just gone overdue.
 */
export async function syncSla(
  tx: TenantTx,
  tenantId: string,
  conversationId: string,
  now: Date,
): Promise<{ breached: boolean }> {
  const [row] = await tx
    .select({
      control: {
        ownerMode: schema.conversationControls.ownerMode,
        authorityStatus: schema.conversationControls.authorityStatus,
        lastCustomerMessageAt: schema.conversationControls.lastCustomerMessageAt,
        ownerChangedAt: schema.conversationControls.ownerChangedAt,
        createdAt: schema.conversationControls.createdAt,
        brandId: schema.conversationControls.brandId,
      },
      state: schema.conversationInboxState,
      hours: schema.brands.businessHours,
      policy: { enabled: schema.slaPolicies.enabled, targets: schema.slaPolicies.targets },
    })
    .from(schema.conversationControls)
    .leftJoin(
      schema.conversationInboxState,
      eq(schema.conversationInboxState.conversationId, schema.conversationControls.id),
    )
    .leftJoin(schema.brands, eq(schema.brands.id, schema.conversationControls.brandId))
    .leftJoin(
      schema.slaPolicies,
      and(
        eq(schema.slaPolicies.brandId, schema.conversationControls.brandId),
        eq(schema.slaPolicies.tenantId, schema.conversationControls.tenantId),
      ),
    )
    .where(eq(schema.conversationControls.id, conversationId));
  if (!row) return { breached: false };
  const state = row.state ?? undefined;
  const previous = clockOf(state);
  const hours = (row.hours ?? null) as BusinessHours | null;
  const { clock, resetHumanReply } = nextSlaClock({
    clock: previous,
    facts: {
      ownerMode: row.control.ownerMode,
      status: row.control.authorityStatus,
      priority: state?.priority ?? null,
      lastCustomerMessageAt: row.control.lastCustomerMessageAt,
      lastHumanReplyAt: state?.lastHumanReplyAt ?? null,
      ownerChangedAt: row.control.ownerChangedAt,
      createdAt: row.control.createdAt,
    },
    policy: row.policy?.enabled ? (row.policy.targets as SlaTargets) : null,
    hours,
    now,
  });
  const same = (a: Date | null | undefined, b: Date | null | undefined) =>
    (a?.getTime() ?? null) === (b?.getTime() ?? null);
  const unchanged =
    !resetHumanReply &&
    (previous === null
      ? clock === null
      : clock !== null &&
        previous.kind === clock.kind &&
        previous.targetMinutes === clock.targetMinutes &&
        previous.pausedMinutes === clock.pausedMinutes &&
        same(previous.startedAt, clock.startedAt) &&
        same(previous.pausedAt, clock.pausedAt) &&
        same(previous.dueAt, clock.dueAt) &&
        same(previous.breachedAt, clock.breachedAt));
  if (unchanged) return { breached: false };
  const values = {
    slaKind: clock?.kind ?? null,
    slaStartedAt: clock?.startedAt ?? null,
    slaTargetMinutes: clock?.targetMinutes ?? null,
    slaPausedAt: clock?.pausedAt ?? null,
    slaPausedMinutes: clock?.pausedMinutes ?? 0,
    slaDueAt: clock?.dueAt ?? null,
    slaBreachedAt: clock?.breachedAt ?? null,
    ...(resetHumanReply ? { lastHumanReplyAt: null } : {}),
  };
  await tx
    .insert(schema.conversationInboxState)
    .values({ tenantId, conversationId, ...values })
    .onConflictDoUpdate({
      target: [
        schema.conversationInboxState.tenantId,
        schema.conversationInboxState.conversationId,
      ],
      set: { ...values, updatedAt: now },
    });
  // A deadline still ahead gets a check at that time; a stale check finds another deadline and
  // does nothing.
  if (clock?.dueAt && !clock.breachedAt && !same(previous?.dueAt, clock.dueAt)) {
    await enqueueOutbox(tx, tenantId, {
      topic: SLA_DUE_TOPIC,
      aggregateType: 'conversation',
      aggregateId: conversationId,
      payload: { conversationId, dueAt: clock.dueAt.toISOString() },
      availableAt: clock.dueAt,
    });
  }
  const breached = clock?.breachedAt != null && !same(previous?.breachedAt, clock.breachedAt);
  if (breached && clock) {
    await appendAudit(tx, {
      actorType: 'system',
      actorId: 'sla',
      action: 'conversation.sla_breached',
      targetType: 'conversation',
      targetId: toPublicId('conversation', conversationId),
      outcome: 'success',
      data: { kind: clock.kind, targetMinutes: clock.targetMinutes },
    });
  }
  return { breached };
}
