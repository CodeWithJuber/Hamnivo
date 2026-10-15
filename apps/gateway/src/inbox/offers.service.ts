import type {
  DeclineOfferRequest,
  OfferDecisionResult,
  OfferList,
  RoutingProfile,
  RoutingProfileList,
  SetRoutingProfileRequest,
} from '@hamnivo/contracts';
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
import {
  chooseOfferee,
  LANGUAGE_SLICES,
  type LanguageSlice,
  MAX_OFFER_ROUNDS,
  type OfferCandidate,
} from '@hamnivo/domain';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { JournalService } from '../authority/journal.service.js';
import {
  type ControlRow,
  currentOwnerOf,
  OwnershipService,
} from '../authority/ownership.service.js';
import { AppError } from '../common/app-error.js';
import { enforce } from '../identity/staff.guard.js';
import { LanguageService } from '../language/language.service.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { InboxAccess, resourceOf } from './access.js';
import { AvailabilityService } from './availability.service.js';
import { eligibleStaffAt } from './eligible.js';
import { cancelOffer, OFFER_TIMEOUT_TOPIC } from './offers.js';
import { unreadCounts } from './unread.js';
import { lastMessages, selectRows, toInboxConversation } from './views.js';

type OfferRow = typeof schema.conversationOffers.$inferSelect;
type TeamRow = typeof schema.teams.$inferSelect;

const o = schema.conversationOffers;
const c = schema.conversationControls;

const WAITING = ['WAITING_HUMAN', 'PAUSED'] as const;
const waiting = (mode: string) => (WAITING as readonly string[]).includes(mode);
const isOpen = (status: string) => status === 'open' || status === 'pending';

/** Email is answered over hours, not seconds: it waits in the team's queue as before. */
const NOT_OFFERED = new Set(['Channel::Email']);

/**
 * Hand-off offered to one person at a time (HNV-10-03, HNV-10-06, H02). When a conversation waits
 * in a team that works in `offer` mode, the best person who can take it now is offered it for the
 * team's offer time: online, not holding another offer, under their open-chat limit, speaking the
 * customer's language, with the fewest open chats. They accept it (it becomes theirs) or decline
 * it with a reason; a decline or no answer offers it to the next person, and after three people it
 * waits in the team's queue and the team is told. An offer is not ownership (ADR 0015): the
 * conversation stays in the queue meanwhile, and anyone may still claim it.
 *
 * Every step runs under the conversation's row lock and checks the hand-off it belongs to (the
 * ownership epoch), so a late timeout, a second click or a claim racing an accept change nothing.
 */
@Injectable()
export class OffersService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: InboxAccess,
    private readonly availability: AvailabilityService,
    private readonly ownership: OwnershipService,
    private readonly journal: JournalService,
    private readonly language: LanguageService,
  ) {}

  private tx<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(this.db, { tenantId, actorId: 'offers' }, work);
  }

  // ---------------------------------------------------------------- worker

  /** After routing or a team change: offer the conversation if its team offers conversations. */
  async afterRoute(event: ClaimedOutboxEvent): Promise<void> {
    const { conversationId } = event.payload as { conversationId: string };
    await this.offerNext(event.tenantId, conversationId);
  }

  /** `conversation.offer_next`: offer the conversation to the next person now. */
  async onNext(event: ClaimedOutboxEvent): Promise<void> {
    const { conversationId } = event.payload as { conversationId: string };
    await this.offerNext(event.tenantId, conversationId);
  }

  /** An offer's time is up: it expires, and the next person is offered the conversation. */
  async onTimeout(event: ClaimedOutboxEvent): Promise<void> {
    const { conversationId, offerId } = event.payload as {
      conversationId: string;
      offerId: string;
    };
    const changed = await this.tx(event.tenantId, async (tx) => {
      const [control] = await tx.select().from(c).where(eq(c.id, conversationId)).for('update');
      if (!control) return false;
      const [offer] = await tx.select().from(o).where(eq(o.id, offerId));
      // Accepted, declined or cancelled in time: nothing to do.
      if (offer?.state !== 'pending') return false;
      const now = this.clock();
      await tx
        .update(o)
        .set({ state: 'expired', decidedAt: now, updatedAt: now })
        .where(eq(o.id, offer.id));
      await appendAudit(tx, {
        actorType: 'system',
        actorId: 'offers',
        action: 'conversation.offer_expired',
        targetType: 'conversation',
        targetId: toPublicId('conversation', conversationId),
        outcome: 'success',
        data: {
          offer: toPublicId('offer', offer.id),
          staffMemberId: toPublicId('staff', offer.staffMemberId),
          round: offer.round,
        },
      });
      await this.offerIn(tx, event.tenantId, conversationId);
      return true;
    });
    if (changed) await this.journal.signalInbox(event.tenantId, conversationId);
  }

  /** Offers the conversation to the next person, or ends the offers; signals when it changed. */
  async offerNext(tenantId: string, conversationId: string): Promise<void> {
    const changed = await this.tx(tenantId, (tx) => this.offerIn(tx, tenantId, conversationId));
    if (changed) await this.journal.signalInbox(tenantId, conversationId);
  }

  /**
   * The offer step, in the caller's transaction: locks the conversation, ends a pending offer that
   * no longer fits (another team, another hand-off), then offers it to the best person who has not
   * been offered this hand-off yet. With nobody left, or after three people, the offers end and the
   * conversation waits in the team's queue. Returns whether anything changed.
   */
  private async offerIn(tx: TenantTx, tenantId: string, conversationId: string): Promise<boolean> {
    const [control] = await tx.select().from(c).where(eq(c.id, conversationId)).for('update');
    if (!control) return false;
    const now = this.clock();
    const epoch = control.ownershipEpoch;
    const [state] = await tx
      .select()
      .from(schema.conversationInboxState)
      .where(eq(schema.conversationInboxState.conversationId, conversationId));
    const [team] = state?.teamId
      ? await tx.select().from(schema.teams).where(eq(schema.teams.id, state.teamId))
      : [];
    const offering =
      isOpen(control.authorityStatus) &&
      waiting(control.ownerMode) &&
      team?.status === 'active' &&
      team.assignmentMode === 'offer';

    let changed = false;
    const [pending] = await tx
      .select()
      .from(o)
      .where(and(eq(o.conversationId, conversationId), eq(o.state, 'pending')));
    if (pending) {
      if (offering && pending.teamId === team?.id && pending.handoffEpoch === epoch) return false;
      await cancelOffer(
        tx,
        pending,
        !waiting(control.ownerMode) || pending.handoffEpoch !== epoch
          ? 'owner_changed'
          : control.authorityStatus === 'resolved'
            ? 'resolved'
            : control.authorityStatus === 'snoozed'
              ? 'snoozed'
              : 'team_changed',
        now,
      );
      changed = true;
    }
    if (!offering || !state || !team) return changed;
    if (state.offersEndedEpoch === epoch) return changed;

    const offered = await tx
      .select({ staffMemberId: o.staffMemberId })
      .from(o)
      .where(and(eq(o.conversationId, conversationId), eq(o.handoffEpoch, epoch)));
    const [inbox] = await tx
      .select({ channelType: schema.authorityInboxes.channelType })
      .from(schema.authorityInboxes)
      .where(eq(schema.authorityInboxes.id, control.inboxId));
    const chosen =
      offered.length >= MAX_OFFER_ROUNDS || NOT_OFFERED.has(inbox?.channelType ?? '')
        ? null
        : chooseOfferee(await this.candidates(tx, tenantId, control, team, now), {
            ...(await this.languageOf(tx, control)),
            exclude: new Set(offered.map((row) => row.staffMemberId)),
          });

    if (!chosen) {
      await tx
        .update(schema.conversationInboxState)
        .set({ offersEndedAt: now, offersEndedEpoch: epoch, updatedAt: now })
        .where(eq(schema.conversationInboxState.conversationId, conversationId));
      await appendAudit(tx, {
        actorType: 'system',
        actorId: 'offers',
        action: 'conversation.offers_ended',
        targetType: 'conversation',
        targetId: toPublicId('conversation', conversationId),
        outcome: 'success',
        data: { team: toPublicId('team', team.id), offered: offered.length },
      });
      return true;
    }

    const expiresAt = new Date(now.getTime() + team.offerTimeoutSeconds * 1000);
    const [offer] = await tx
      .insert(o)
      .values({
        tenantId,
        conversationId,
        teamId: team.id,
        staffMemberId: chosen.id,
        handoffEpoch: epoch,
        round: offered.length + 1,
        offeredAt: now,
        expiresAt,
        timeoutSeconds: team.offerTimeoutSeconds,
      })
      .returning();
    if (!offer) throw new Error('offer insert returned nothing');
    await enqueueOutbox(tx, tenantId, {
      topic: OFFER_TIMEOUT_TOPIC,
      aggregateType: 'conversation',
      aggregateId: conversationId,
      payload: { conversationId, offerId: offer.id },
      availableAt: expiresAt,
    });
    await appendAudit(tx, {
      actorType: 'system',
      actorId: 'offers',
      action: 'conversation.offered',
      targetType: 'conversation',
      targetId: toPublicId('conversation', conversationId),
      outcome: 'success',
      data: {
        offer: toPublicId('offer', offer.id),
        staffMemberId: toPublicId('staff', chosen.id),
        team: toPublicId('team', team.id),
        round: offer.round,
        openChats: chosen.openChats,
      },
    });
    return true;
  }

  /** The team's people who may take the conversation over, with what choosing among them needs. */
  private async candidates(
    tx: TenantTx,
    tenantId: string,
    control: ControlRow,
    team: TeamRow,
    now: Date,
  ): Promise<OfferCandidate[]> {
    const members = await tx
      .select({ staffMemberId: schema.teamMembers.staffMemberId })
      .from(schema.teamMembers)
      .where(eq(schema.teamMembers.teamId, team.id));
    if (members.length === 0) return [];
    const [brand] = control.brandId
      ? await tx
          .select({ workspaceId: schema.brands.workspaceId })
          .from(schema.brands)
          .where(eq(schema.brands.id, control.brandId))
      : [];
    const inTeam = new Set(members.map((m) => m.staffMemberId));
    const eligible = await eligibleStaffAt(
      tx,
      resourceOf(control, brand?.workspaceId ?? null, team.id),
      now,
      ['conversations.read', 'conversations.takeover'],
    );
    const ids = eligible.map((s) => s.staffMemberId).filter((id) => inTeam.has(id));
    if (ids.length === 0) return [];
    const statuses = await this.availability.statuses(tx, tenantId, ids);
    const profiles = await tx
      .select()
      .from(schema.staffRoutingProfiles)
      .where(inArray(schema.staffRoutingProfiles.staffMemberId, ids));
    const open = await tx
      .select({ staffMemberId: c.ownerStaffId, count: sql<number>`count(*)::int` })
      .from(c)
      .where(
        and(
          eq(c.ownerMode, 'HUMAN_ACTIVE'),
          inArray(c.ownerStaffId, ids),
          inArray(c.authorityStatus, ['open', 'pending']),
        ),
      )
      .groupBy(c.ownerStaffId);
    const offers = await tx
      .select({
        staffMemberId: o.staffMemberId,
        holding: sql<boolean>`bool_or(${o.state} = 'pending')`,
        last: sql<string>`max(${o.offeredAt})`,
      })
      .from(o)
      .where(inArray(o.staffMemberId, ids))
      .groupBy(o.staffMemberId);
    return ids.map((id) => {
      const profile = profiles.find((p) => p.staffMemberId === id);
      const offer = offers.find((row) => row.staffMemberId === id);
      return {
        id,
        status: statuses.get(id) ?? 'offline',
        languages: (profile?.languages ?? []).filter((l): l is LanguageSlice =>
          (LANGUAGE_SLICES as readonly string[]).includes(l),
        ),
        openChats: Number(open.find((row) => row.staffMemberId === id)?.count ?? 0),
        maxOpenChats: profile?.maxOpenChats ?? null,
        holdingOffer: Boolean(offer?.holding),
        lastOfferedAt: offer?.last ? new Date(offer.last) : null,
      };
    });
  }

  /** The customer's language: what routing judged from their words, otherwise what they chose. */
  private async languageOf(
    tx: TenantTx,
    control: ControlRow,
  ): Promise<{ language: LanguageSlice | null; alternatives: LanguageSlice[] }> {
    const [decided] = await tx
      .select({ language: schema.decisionRecords.language })
      .from(schema.decisionRecords)
      .where(
        and(
          eq(schema.decisionRecords.conversationId, control.id),
          isNotNull(schema.decisionRecords.language),
        ),
      )
      .orderBy(desc(schema.decisionRecords.createdAt))
      .limit(1);
    const known = (value: string | null | undefined): value is LanguageSlice =>
      (LANGUAGE_SLICES as readonly string[]).includes(value ?? '');
    if (known(decided?.language)) return { language: decided.language, alternatives: [] };
    if (!control.principalId) return { language: null, alternatives: [] };
    const { slice, alternatives } = await this.language.forRouting(tx, control.principalId, '');
    return { language: slice, alternatives };
  }

  // ---------------------------------------------------------------- the person offered

  /** The conversations offered to me now, soonest to expire first. */
  async list(principal: StaffPrincipal): Promise<OfferList> {
    const scope = this.access.scope(principal);
    if (!scope) return { items: [] };
    return this.access.tx(principal, async (tx) => {
      const rows = await selectRows(tx)
        .where(
          and(
            eq(o.staffMemberId, principal.staffMemberId),
            inArray(c.ownerMode, [...WAITING]),
            inArray(c.authorityStatus, ['open', 'pending']),
            InboxAccess.condition(scope),
          ),
        )
        .orderBy(asc(o.expiresAt));
      const ids = rows.map((row) => row.control.id);
      const last = await lastMessages(tx, ids);
      const unread = await unreadCounts(
        tx,
        principal.staffMemberId,
        rows.map((row) => ({
          id: row.control.id,
          ownerMode: row.control.ownerMode,
          ownerStaffId: row.control.ownerStaffId,
        })),
      );
      const now = this.clock();
      return {
        items: rows.map((row) =>
          toInboxConversation(row, last.get(row.control.id), unread.get(row.control.id) ?? 0, now),
        ),
      };
    });
  }

  /** My pending offer, its conversation locked, or NOT_FOUND. */
  private async mine(
    tx: TenantTx,
    principal: StaffPrincipal,
    offerPublicId: string,
    permission: 'conversations.read' | 'conversations.takeover',
  ) {
    let offerId: string;
    try {
      offerId = fromPublicId('offer', offerPublicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Offer not found.' });
    }
    const [seen] = await tx.select().from(o).where(eq(o.id, offerId));
    if (!seen || seen.staffMemberId !== principal.staffMemberId) {
      throw new AppError('NOT_FOUND', { detail: 'Offer not found.' });
    }
    const found = await this.access.authorized(
      tx,
      principal,
      toPublicId('conversation', seen.conversationId),
      permission,
      true,
    );
    // Read again under the conversation's lock: a timeout or a claim may have ended it meanwhile.
    const [offer] = await tx.select().from(o).where(eq(o.id, offerId));
    return { offer: offer as OfferRow, control: found.control };
  }

  /** Why an offer can no longer be decided, naming who has the conversation when someone does. */
  private async closed(tx: TenantTx, offer: OfferRow, control: ControlRow): Promise<AppError> {
    const owner = await currentOwnerOf(tx, control);
    const detail =
      control.ownerMode === 'HUMAN_ACTIVE' && owner.displayName
        ? `${owner.displayName} already has this conversation.`
        : offer.state === 'expired'
          ? 'The time to accept ran out; the conversation was offered to someone else.'
          : 'This offer is no longer open.';
    return new AppError('OFFER_CLOSED', { detail, currentOwner: owner });
  }

  private open(offer: OfferRow, control: ControlRow): boolean {
    return (
      offer.state === 'pending' &&
      offer.handoffEpoch === control.ownershipEpoch &&
      waiting(control.ownerMode) &&
      isOpen(control.authorityStatus)
    );
  }

  /** Accepts the offer: the conversation becomes mine, fenced to the hand-off it was offered for. */
  async accept(principal: StaffPrincipal, offerPublicId: string): Promise<OfferDecisionResult> {
    const outcome = await this.access.tx(principal, async (tx) => {
      const { offer, control } = await this.mine(
        tx,
        principal,
        offerPublicId,
        'conversations.takeover',
      );
      if (!this.open(offer, control)) throw await this.closed(tx, offer, control);
      const now = this.clock();
      await tx
        .update(o)
        .set({ state: 'accepted', decidedAt: now, updatedAt: now })
        .where(eq(o.id, offer.id));
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'conversation.offer_accepted',
        targetType: 'conversation',
        targetId: toPublicId('conversation', control.id),
        outcome: 'success',
        data: { offer: offerPublicId, round: offer.round },
      });
      return this.ownership.transition(
        tx,
        principal.tenantId,
        control.id,
        { kind: 'staff', staffMemberId: principal.staffMemberId },
        {
          origin: 'hamnivo',
          reason: 'offer_accepted',
          actor: { type: 'staff', id: toPublicId('staff', principal.staffMemberId) },
          actorStaffMemberId: principal.staffMemberId,
          expectedEpoch: offer.handoffEpoch,
        },
      );
    });
    if (outcome.journal.length > 0) {
      await this.journal.notify(principal.tenantId, outcome.control.id, outcome.journal);
    } else {
      await this.journal.signalInbox(principal.tenantId, outcome.control.id);
    }
    return { conversationId: toPublicId('conversation', outcome.control.id), state: 'accepted' };
  }

  /**
   * Declines the offer with a reason: the next person is offered the conversation at once. Going
   * offline also makes me away, so I am not offered the next one.
   */
  async decline(
    principal: StaffPrincipal,
    offerPublicId: string,
    input: z.output<typeof DeclineOfferRequest>,
  ): Promise<OfferDecisionResult> {
    const conversationId = await this.access.tx(principal, async (tx) => {
      const { offer, control } = await this.mine(
        tx,
        principal,
        offerPublicId,
        'conversations.read',
      );
      if (!this.open(offer, control)) throw await this.closed(tx, offer, control);
      await this.declineIn(tx, principal, offer, input.reason, input.note ?? null);
      return control.id;
    });
    await this.journal.signalInbox(principal.tenantId, conversationId);
    return { conversationId: toPublicId('conversation', conversationId), state: 'declined' };
  }

  private async declineIn(
    tx: TenantTx,
    principal: StaffPrincipal,
    offer: OfferRow,
    reason: z.output<typeof DeclineOfferRequest>['reason'],
    note: string | null,
  ): Promise<void> {
    const now = this.clock();
    await tx
      .update(o)
      .set({
        state: 'declined',
        declineReason: reason,
        declineNote: note,
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(o.id, offer.id));
    await appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action: 'conversation.offer_declined',
      targetType: 'conversation',
      targetId: toPublicId('conversation', offer.conversationId),
      outcome: 'success',
      data: { offer: toPublicId('offer', offer.id), round: offer.round, reason },
    });
    if (reason === 'going_offline') {
      await tx
        .insert(schema.staffInboxPreferences)
        .values({
          tenantId: principal.tenantId,
          staffMemberId: principal.staffMemberId,
          availability: 'away',
        })
        .onConflictDoUpdate({
          target: [
            schema.staffInboxPreferences.tenantId,
            schema.staffInboxPreferences.staffMemberId,
          ],
          set: { availability: 'away', updatedAt: now },
        });
    }
    await this.offerIn(tx, principal.tenantId, offer.conversationId);
  }

  /**
   * I set myself away or offline: what is offered to me now goes to the next person rather than
   * waiting for my offer's time to run out.
   */
  async releaseMine(principal: StaffPrincipal): Promise<void> {
    const pending = await this.access.tx(principal, (tx) =>
      tx
        .select({ id: o.id })
        .from(o)
        .where(and(eq(o.staffMemberId, principal.staffMemberId), eq(o.state, 'pending'))),
    );
    for (const { id } of pending) {
      const conversationId = await this.access.tx(principal, async (tx) => {
        const [seen] = await tx.select().from(o).where(eq(o.id, id));
        if (!seen) return null;
        await tx.select({ id: c.id }).from(c).where(eq(c.id, seen.conversationId)).for('update');
        const [offer] = await tx.select().from(o).where(eq(o.id, id));
        if (offer?.state !== 'pending') return null;
        await this.declineIn(tx, principal, offer, 'going_offline', null);
        return offer.conversationId;
      });
      if (conversationId) await this.journal.signalInbox(principal.tenantId, conversationId);
    }
  }

  // ---------------------------------------------------------------- routing profiles

  private profileOf(
    staff: { id: string; displayName: string },
    row: typeof schema.staffRoutingProfiles.$inferSelect | undefined,
  ): RoutingProfile {
    return {
      staffMemberId: toPublicId('staff', staff.id),
      displayName: staff.displayName,
      languages: (row?.languages ?? []).filter((l): l is LanguageSlice =>
        (LANGUAGE_SLICES as readonly string[]).includes(l),
      ),
      maxOpenChats: row?.maxOpenChats ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  /** Every active person's languages and open-chat limit, by name. */
  async profiles(principal: StaffPrincipal): Promise<RoutingProfileList> {
    return this.access.tx(principal, async (tx) => {
      const staff = await tx
        .select({ id: schema.staffMembers.id, displayName: schema.staffMembers.displayName })
        .from(schema.staffMembers)
        .where(eq(schema.staffMembers.status, 'active'))
        .orderBy(asc(schema.staffMembers.displayName));
      const rows = await tx.select().from(schema.staffRoutingProfiles);
      return {
        items: staff.map((s) =>
          this.profileOf(
            s,
            rows.find((row) => row.staffMemberId === s.id),
          ),
        ),
      };
    });
  }

  async setProfile(
    principal: StaffPrincipal,
    staffPublicId: string,
    input: z.output<typeof SetRoutingProfileRequest>,
  ): Promise<RoutingProfile> {
    enforce(this.access.decide(principal, 'teams.manage', {}));
    let staffMemberId: string;
    try {
      staffMemberId = fromPublicId('staff', staffPublicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Staff member not found.' });
    }
    return this.access.tx(principal, async (tx) => {
      const [staff] = await tx
        .select({ id: schema.staffMembers.id, displayName: schema.staffMembers.displayName })
        .from(schema.staffMembers)
        .where(
          and(eq(schema.staffMembers.id, staffMemberId), eq(schema.staffMembers.status, 'active')),
        );
      if (!staff) throw new AppError('NOT_FOUND', { detail: 'Staff member not found.' });
      const values = {
        languages: [...new Set(input.languages)],
        maxOpenChats: input.maxOpenChats,
        updatedBy: principal.staffMemberId,
        updatedAt: this.clock(),
      };
      const [row] = await tx
        .insert(schema.staffRoutingProfiles)
        .values({ tenantId: principal.tenantId, staffMemberId, ...values })
        .onConflictDoUpdate({
          target: [schema.staffRoutingProfiles.tenantId, schema.staffRoutingProfiles.staffMemberId],
          set: values,
        })
        .returning();
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'staff.routing_profile_updated',
        targetType: 'staff',
        targetId: staffPublicId,
        outcome: 'success',
        data: { languages: values.languages, maxOpenChats: values.maxOpenChats },
      });
      return this.profileOf(staff, row);
    });
  }
}
