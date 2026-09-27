import { type ClaimedOutboxEvent, type Db, schema, withTenant } from '@hamnivo/db';
import type { OwnerMode } from '@hamnivo/db/schema';
import type { ActorCredential } from '@hamnivo/domain';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { APP_DB } from '../tokens.js';
import type { OwnerTarget } from './ownership.service.js';
import { AuthorityRegistry } from './registry.js';
import { StaffLinksService } from './staff-links.service.js';
import { uuidV5 } from './uuid.js';

interface NoteRequested {
  conversationId: string;
  /** `hv1:n:…`, so a repeated delivery finds the note instead of posting it twice. */
  key: string;
  text: string;
}

interface OwnerChanged {
  conversationId: string;
  epoch: number;
  previousMode: OwnerMode;
  target: OwnerTarget;
  reason: string;
  handoffNote?: string;
  /** Who assigned it (a colleague assigning someone else); defaults to the new owner. */
  actorStaffMemberId?: string;
}

interface TeamChanged {
  conversationId: string;
  teamId: string | null;
  /** The staff member who chose the team; null when routing did (J02). */
  actorStaffMemberId: string | null;
}

/**
 * Applies Hamnivo's ownership changes in Chatwoot (outbox topic `conversation.owner_changed`),
 * each with the credential of whoever acts: the staff member's own user for takeovers, the bot for
 * handing off, the integration user otherwise. Safe to repeat; superseded changes are skipped.
 */
@Injectable()
export class AuthoritySyncService {
  private readonly logger = new Logger(AuthoritySyncService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    private readonly registry: AuthorityRegistry,
    private readonly staffLinks: StaffLinksService,
  ) {}

  /** Posts a private note for the people handling a conversation (outbox `conversation.note`). */
  async applyNote(event: ClaimedOutboxEvent): Promise<void> {
    const payload = event.payload as NoteRequested;
    const [control] = await withTenant(this.db, { tenantId: event.tenantId }, (tx) =>
      tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, payload.conversationId)),
    );
    if (!control) return;
    const runtime = await this.registry.get(event.tenantId, control.connectionId);
    const ref = String(control.externalConversationId);
    if (await runtime.authority.findByKey(ref, payload.key)) return;
    await runtime.authority.appendMessage({
      conversationRef: ref,
      key: payload.key,
      author: { kind: 'integration' },
      visibility: 'private',
      text: payload.text,
    });
  }

  /**
   * Applies a team assignment in Chatwoot (outbox `conversation.team_changed`): the Hamnivo team's
   * Chatwoot team is created on first use with the members who have a Chatwoot user, then the
   * conversation is assigned as the staff member who chose the team. Superseded changes are skipped.
   */
  async applyTeamChange(event: ClaimedOutboxEvent): Promise<void> {
    const payload = event.payload as TeamChanged;
    const tenantId = event.tenantId;
    const loaded = await withTenant(this.db, { tenantId }, async (tx) => {
      const [control] = await tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, payload.conversationId));
      if (!control) return null;
      const [state] = await tx
        .select({ teamId: schema.conversationInboxState.teamId })
        .from(schema.conversationInboxState)
        .where(eq(schema.conversationInboxState.conversationId, control.id));
      if ((state?.teamId ?? null) !== payload.teamId) return null;
      if (!payload.teamId) return { control, team: null, link: null, members: [] };
      const [team] = await tx
        .select()
        .from(schema.teams)
        .where(eq(schema.teams.id, payload.teamId));
      if (!team) return null;
      const [link] = await tx
        .select()
        .from(schema.teamAuthorityLinks)
        .where(
          and(
            eq(schema.teamAuthorityLinks.teamId, team.id),
            eq(schema.teamAuthorityLinks.connectionId, control.connectionId),
          ),
        );
      const members = await tx
        .select({ externalUserId: schema.staffAuthorityLinks.externalUserId })
        .from(schema.teamMembers)
        .innerJoin(
          schema.staffAuthorityLinks,
          and(
            eq(schema.staffAuthorityLinks.staffMemberId, schema.teamMembers.staffMemberId),
            eq(schema.staffAuthorityLinks.connectionId, control.connectionId),
            eq(schema.staffAuthorityLinks.status, 'active'),
          ),
        )
        .where(eq(schema.teamMembers.teamId, team.id));
      return { control, team, link: link ?? null, members };
    });
    if (!loaded) return;
    const { control, team } = loaded;
    const runtime = await this.registry.get(tenantId, control.connectionId);
    let teamRef: string | null = null;
    if (team) {
      teamRef = loaded.link
        ? String(loaded.link.externalTeamId)
        : (await runtime.authority.ensureTeam(team.name)).ref;
      if (!loaded.link) {
        const externalTeamId = Number(teamRef);
        await withTenant(this.db, { tenantId }, (tx) =>
          tx
            .insert(schema.teamAuthorityLinks)
            .values({
              tenantId,
              teamId: team.id,
              connectionId: control.connectionId,
              externalTeamId,
            })
            .onConflictDoNothing(),
        );
      }
      await runtime.authority.addTeamMembers(
        teamRef,
        loaded.members.map((m) => String(m.externalUserId)),
      );
    }
    // Routing acts as the integration; a person as their own Chatwoot user.
    const actor: ActorCredential = payload.actorStaffMemberId
      ? {
          kind: 'staff',
          userRef: String(await this.staffLinks.ensure(runtime, payload.actorStaffMemberId)),
        }
      : { kind: 'integration' };
    await runtime.authority.assignTeam(String(control.externalConversationId), teamRef, actor);
  }

  async applyOwnerChange(event: ClaimedOutboxEvent): Promise<void> {
    const payload = event.payload as OwnerChanged;
    const tenantId = event.tenantId;
    const [control] = await withTenant(this.db, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, payload.conversationId)),
    );
    if (!control) return;
    if (control.ownershipEpoch !== payload.epoch || control.ownerSyncedEpoch >= payload.epoch) {
      // A newer change supersedes this one (its own event will sync), or it was already applied.
      return;
    }
    const runtime = await this.registry.get(tenantId, control.connectionId);
    const authority = runtime.authority;
    const ref = String(control.externalConversationId);
    const target = payload.target;
    switch (target.kind) {
      case 'staff': {
        const userId = await this.staffLinks.ensure(runtime, target.staffMemberId);
        const actorId =
          payload.actorStaffMemberId && payload.actorStaffMemberId !== target.staffMemberId
            ? await this.staffLinks.ensure(runtime, payload.actorStaffMemberId)
            : userId;
        await authority.setOwner(
          ref,
          { kind: 'user', userRef: String(userId) },
          { kind: 'staff', userRef: String(actorId) },
        );
        break;
      }
      case 'ai': {
        const bot = runtime.bots.find((b) => b.id === target.botId) ?? runtime.primaryBot;
        if (!bot) throw new Error('No AI bot is attached to this connection');
        await authority.setOwner(
          ref,
          { kind: 'bot', botRef: String(bot.externalBotId) },
          { kind: 'integration' },
        );
        break;
      }
      case 'queue': {
        if (payload.previousMode === 'AI_ACTIVE' && runtime.primaryBot) {
          // Chatwoot's bot handoff: the bot lets go and the conversation opens for people.
          await authority.setStatus(ref, 'open', {
            kind: 'bot',
            botRef: String(runtime.primaryBot.externalBotId),
          });
        } else {
          await authority.setOwner(ref, { kind: 'none' }, { kind: 'integration' });
          await authority.setStatus(ref, 'open', { kind: 'integration' });
        }
        break;
      }
      case 'external':
        break;
    }
    if (payload.handoffNote) {
      const key = `hv1:n:${uuidV5(control.id, `handoff:${payload.epoch}`)}`;
      if (!(await authority.findByKey(ref, key))) {
        await authority.appendMessage({
          conversationRef: ref,
          key,
          author: { kind: 'integration' },
          visibility: 'private',
          text: payload.handoffNote,
        });
      }
    }
    await withTenant(this.db, { tenantId }, (tx) =>
      tx
        .update(schema.conversationControls)
        .set({ ownerSyncedEpoch: payload.epoch })
        .where(
          and(
            eq(schema.conversationControls.id, control.id),
            eq(schema.conversationControls.ownershipEpoch, payload.epoch),
          ),
        ),
    );
    this.logger.log(
      `owner of ${control.id} synced to Chatwoot at epoch ${payload.epoch} (${target.kind})`,
    );
  }
}
