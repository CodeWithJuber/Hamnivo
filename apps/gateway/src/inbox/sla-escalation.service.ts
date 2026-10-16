import {
  appendAudit,
  type ClaimedOutboxEvent,
  type Db,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { type BusinessHours, decideSlaMove } from '@hamnivo/domain';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { JournalService } from '../authority/journal.service.js';
import { OwnershipService } from '../authority/ownership.service.js';
import { uuidV5 } from '../authority/uuid.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import type { Mailer } from '../platform/mailer.js';
import { APP_DB, CLOCK, type Clock, CONFIG, MAILER } from '../tokens.js';
import { resourceOf } from './access.js';
import { AvailabilityService } from './availability.service.js';
import { leadsAt } from './eligible.js';
import { clockOf, type OverdueStep, SLA_ALERT_TOPIC, SLA_MOVE_TOPIC, syncSla } from './sla.js';
import { putInTeam, teamTakesBrand } from './team-queue.js';

/** At most one overdue email per lead and brand in this time, however many go overdue at once. */
const MAIL_WINDOW_MS = 15 * 60_000;
const LEAD_MAIL = 'sla.lead_mail';

const KIND_NAMES = { first_reply: 'first reply', next_reply: 'next reply' } as const;

/**
 * Escalating overdue conversations (H12, ADR 0016): when a conversation goes past its reply-time
 * target, the people who can assign it hear it (in Studio, from the inbox stream; by email when
 * they are not online), and when nobody has replied after the brand's extra working minutes it
 * goes back to the queue, or to the brand's chosen team, to be offered to the next person. Each
 * step first checks that the same overdue clock is still there and nobody has acted on it.
 */
@Injectable()
export class SlaEscalationService {
  private readonly logger = new Logger(SlaEscalationService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly ownership: OwnershipService,
    private readonly journal: JournalService,
    private readonly availability: AvailabilityService,
  ) {}

  private async load(tx: TenantTx, conversationId: string) {
    const [row] = await tx
      .select({
        control: schema.conversationControls,
        state: schema.conversationInboxState,
        brand: schema.brands,
        policy: schema.slaPolicies,
      })
      .from(schema.conversationControls)
      .leftJoin(
        schema.conversationInboxState,
        eq(schema.conversationInboxState.conversationId, schema.conversationControls.id),
      )
      .innerJoin(schema.brands, eq(schema.brands.id, schema.conversationControls.brandId))
      .leftJoin(
        schema.slaPolicies,
        and(
          eq(schema.slaPolicies.brandId, schema.conversationControls.brandId),
          eq(schema.slaPolicies.tenantId, schema.conversationControls.tenantId),
        ),
      )
      .where(eq(schema.conversationControls.id, conversationId));
    return row;
  }

  /** The leads of a conversation that went overdue hear it by email when they are not online. */
  async onAlert(event: ClaimedOutboxEvent): Promise<void> {
    const step = event.payload as unknown as OverdueStep;
    const mail = await withTenant(
      this.db,
      { tenantId: event.tenantId, actorId: 'sla' },
      async (tx) => {
        const [claimed] = await tx
          .insert(schema.processedEvents)
          .values({ tenantId: event.tenantId, consumer: SLA_ALERT_TOPIC, eventId: event.id })
          .onConflictDoNothing()
          .returning({ eventId: schema.processedEvents.eventId });
        if (!claimed) return null;
        const row = await this.load(tx, step.conversationId);
        if (!row) return null;
        const { control, state, brand, policy } = row;
        const status = control.authorityStatus;
        if (status !== 'open' && status !== 'pending') return null;
        if (state?.slaBreachedAt?.toISOString() !== step.breachedAt) return null;
        if (!policy?.enabled || !policy.overdueAlertLeads) return null;
        const now = this.clock();
        // The owner already hears it in Studio as their own overdue conversation.
        const leads = (
          await leadsAt(tx, resourceOf(control, brand.workspaceId, state.teamId), now)
        ).filter((lead) => lead.staffMemberId !== control.ownerStaffId);
        if (leads.length === 0) return null;
        const statuses = await this.availability.statuses(
          tx,
          event.tenantId,
          leads.map((lead) => lead.staffMemberId),
        );
        const recipients: string[] = [];
        for (const lead of leads) {
          if (statuses.get(lead.staffMemberId) === 'online') continue;
          if (await this.mailedRecently(tx, event.tenantId, brand.id, lead.staffMemberId, now)) {
            continue;
          }
          recipients.push(lead.email);
        }
        if (recipients.length === 0) return null;
        const [owner] = control.ownerStaffId
          ? await tx
              .select({ name: schema.staffMembers.displayName })
              .from(schema.staffMembers)
              .where(eq(schema.staffMembers.id, control.ownerStaffId))
          : [];
        const [team] = policy.overdueMoveTeamId
          ? await tx
              .select()
              .from(schema.teams)
              .where(eq(schema.teams.id, policy.overdueMoveTeamId))
          : [];
        // What the move will do, by the same rules as the move itself: a conversation someone has
        // goes back to the queue or to the chosen team; one already waiting only to another team.
        const toTeam =
          team && teamTakesBrand(team, brand.workspaceId) && team.id !== state.teamId ? team : null;
        const where =
          policy.overdueMoveAfterMinutes === null
            ? null
            : toTeam
              ? `to the ${toTeam.name} team`
              : control.ownerMode === 'HUMAN_ACTIVE'
                ? 'back to the queue'
                : null;
        return {
          brand: brand.name,
          recipients,
          target: state.slaTargetMinutes,
          owner: owner?.name ?? null,
          move:
            where && policy.overdueMoveAfterMinutes !== null
              ? { minutes: policy.overdueMoveAfterMinutes, where }
              : null,
        };
      },
    );
    if (!mail) return;
    const origin = this.config.PUBLIC_CONSOLE_ORIGIN.replace(/\/$/, '');
    const link = `${origin}/inbox/${toPublicId('conversation', step.conversationId)}`;
    const lines = [
      `A conversation of ${mail.brand} has waited longer than its ${KIND_NAMES[step.kind]} target${mail.target ? ` (${mail.target} min)` : ''}.`,
      mail.owner ? `${mail.owner} has it but has not replied yet.` : 'Nobody has taken it yet.',
      ...(mail.move
        ? [
            `If nobody replies within ${mail.move.minutes} more working minutes, Hamnivo moves it ${mail.move.where}.`,
          ]
        : []),
      '',
      `Open the conversation:\n${link}`,
      '',
      `All overdue conversations:\n${origin}/inbox?queue=overdue`,
    ];
    for (const to of mail.recipients) {
      await this.mailer
        .send({
          to,
          template: 'inbox.sla_overdue',
          subject: `${mail.brand}: a conversation is past its reply-time target`,
          text: lines.join('\n'),
        })
        .catch((error: unknown) => this.logger.warn(`overdue email failed: ${String(error)}`));
    }
  }

  /**
   * Whether this lead was emailed about the brand's overdue conversations in the last 15 minutes;
   * if not, it is recorded that they are now. The record is kept per 15-minute window, and the
   * window before is checked too, so two emails never go out minutes apart across a boundary.
   */
  private async mailedRecently(
    tx: TenantTx,
    tenantId: string,
    brandId: string,
    staffMemberId: string,
    now: Date,
  ): Promise<boolean> {
    const window = Math.floor(now.getTime() / MAIL_WINDOW_MS);
    const key = (n: number) => uuidV5(brandId, `${staffMemberId}:${n}`);
    const [earlier] = await tx
      .select({ at: schema.processedEvents.processedAt })
      .from(schema.processedEvents)
      .where(
        and(
          eq(schema.processedEvents.consumer, LEAD_MAIL),
          eq(schema.processedEvents.eventId, key(window - 1)),
        ),
      );
    if (earlier && now.getTime() - earlier.at.getTime() < MAIL_WINDOW_MS) return true;
    const [first] = await tx
      .insert(schema.processedEvents)
      .values({ tenantId, consumer: LEAD_MAIL, eventId: key(window), processedAt: now })
      .onConflictDoNothing()
      .returning({ eventId: schema.processedEvents.eventId });
    return !first;
  }

  /**
   * The brand's extra working minutes have passed: an overdue conversation nobody has replied to
   * goes back to the queue (or to the chosen team) as a new hand-off, under the conversation's
   * lock and only if it is still the same overdue clock with the same owner and team.
   */
  async onMove(event: ClaimedOutboxEvent): Promise<void> {
    const step = event.payload as unknown as OverdueStep;
    let entries: Awaited<ReturnType<OwnershipService['transition']>>['journal'] | null = null;
    try {
      entries = await withTenant(
        this.db,
        { tenantId: event.tenantId, actorId: 'sla' },
        async (tx) => {
          const [locked] = await tx
            .select({ id: schema.conversationControls.id })
            .from(schema.conversationControls)
            .where(eq(schema.conversationControls.id, step.conversationId))
            .for('update');
          if (!locked) return null;
          const now = this.clock();
          // A reply already recorded ends the clock before anything is moved.
          await syncSla(tx, event.tenantId, step.conversationId, now);
          const row = await this.load(tx, step.conversationId);
          if (!row) return null;
          const { control, state, brand, policy } = row;
          const [team] = policy?.overdueMoveTeamId
            ? await tx
                .select()
                .from(schema.teams)
                .where(eq(schema.teams.id, policy.overdueMoveTeamId))
            : [];
          const clock = clockOf(state ?? undefined);
          const decision = decideSlaMove({
            queued: {
              breachedAt: new Date(step.breachedAt),
              epoch: step.epoch,
              teamId: step.teamId,
              // Queued before snoozes were part of a step: the clock as it is now.
              pausedMinutes: step.pausedMinutes ?? clock?.pausedMinutes ?? 0,
            },
            current: {
              status: control.authorityStatus,
              ownerMode: control.ownerMode,
              epoch: control.ownershipEpoch,
              teamId: state?.teamId ?? null,
              clock,
            },
            move:
              policy?.enabled && policy.overdueMoveAfterMinutes !== null
                ? {
                    afterMinutes: policy.overdueMoveAfterMinutes,
                    teamId: policy.overdueMoveTeamId,
                    teamUsable: teamTakesBrand(team, brand.workspaceId),
                  }
                : null,
            hours: (brand.businessHours ?? null) as BusinessHours | null,
            now,
          });
          if (decision.kind === 'wait') {
            await enqueueOutbox(tx, event.tenantId, {
              topic: SLA_MOVE_TOPIC,
              aggregateType: 'conversation',
              aggregateId: step.conversationId,
              payload: { ...step },
              availableAt: decision.until,
            });
            return null;
          }
          if (decision.kind === 'skip') {
            this.logger.debug(`overdue ${step.conversationId} not moved: ${decision.why}`);
            return null;
          }
          if (decision.teamId) {
            await putInTeam(tx, event.tenantId, step.conversationId, decision.teamId, now);
          }
          const minutes = policy?.overdueMoveAfterMinutes ?? 0;
          const target = clock
            ? `${KIND_NAMES[clock.kind]} target (${clock.targetMinutes} min)`
            : 'reply-time target';
          const result = await this.ownership.transition(
            tx,
            event.tenantId,
            step.conversationId,
            { kind: 'queue' },
            {
              origin: 'hamnivo',
              reason: 'sla_moved',
              actor: { type: 'system', id: 'sla' },
              expectedEpoch: step.epoch,
              requeue: decision.requeue,
              handoffNote: `Moved by Hamnivo: nobody replied within the ${target} and ${minutes} more working minutes.`,
            },
          );
          await appendAudit(tx, {
            actorType: 'system',
            actorId: 'sla',
            action: 'conversation.sla_moved',
            targetType: 'conversation',
            targetId: toPublicId('conversation', step.conversationId),
            outcome: 'success',
            data: {
              kind: step.kind,
              from: control.ownerStaffId ? toPublicId('staff', control.ownerStaffId) : null,
              fromTeam: state?.teamId ? toPublicId('team', state.teamId) : null,
              toTeam: decision.teamId
                ? toPublicId('team', decision.teamId)
                : state?.teamId
                  ? toPublicId('team', state.teamId)
                  : null,
              afterMinutes: minutes,
            },
          });
          return result.journal;
        },
      );
    } catch (error) {
      // Someone took or moved it at the same moment: they acted, so it stays with them.
      if (error instanceof AppError && error.code === 'OWNERSHIP_CHANGED') return;
      throw error;
    }
    if (entries === null) return;
    if (entries.length > 0) await this.journal.notify(event.tenantId, step.conversationId, entries);
    await this.journal.signalInbox(event.tenantId, step.conversationId);
  }
}
