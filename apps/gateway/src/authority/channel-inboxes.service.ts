import { addInboxMembers, listInboxes, setInboxAgentBot } from '@hamnivo/chatwoot';
import type { ChannelInbox, UpdateChannelRequest } from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { authorize, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { channelKindOf } from './adopt.js';
import { AuthorityRegistry } from './registry.js';

/** The inbox cursor that looks for new channel inboxes in a Chatwoot account. */
export const CHANNEL_DISCOVERY_REF = 'all';
export const CHANNEL_DISCOVERY_SECONDS = 300;
/** How often each channel inbox's recent conversations are listed (lost webhooks). */
export const CHANNEL_POLL_SECONDS = 60;

type InboxRow = typeof schema.authorityInboxes.$inferSelect;

function view(row: InboxRow, conversationsThisWeek: number): ChannelInbox {
  const health = row.health ?? null;
  return {
    id: toPublicId('inbox', row.id),
    brandId: row.brandId ? toPublicId('brand', row.brandId) : null,
    kind: channelKindOf(row.channelType),
    name: row.name ?? row.channelType.replace('Channel::', ''),
    address: row.displayAddress,
    status: row.pausedAt ? 'paused' : health && !health.ok ? 'needs_attention' : 'connected',
    problem: health && !health.ok ? (health.message ?? null) : null,
    aiAnswers: row.aiAnswers,
    defaultTeamId: row.defaultTeamId ? toPublicId('team', row.defaultTeamId) : null,
    conversationsThisWeek,
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The email, WhatsApp and Telegram inboxes of a brand's Chatwoot account (ADR 0013). Chatwoot
 * owns them and their credentials; Hamnivo records which exist, whether the AI answers there and
 * which team gets their conversations. The AI's bot is attached to an inbox only while the AI
 * answers on it, so Chatwoot leaves the other channels' conversations with people.
 */
@Injectable()
export class ChannelInboxesService {
  private readonly logger = new Logger(ChannelInboxesService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: AuthorityRegistry,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private decide(principal: StaffPrincipal, resource: object) {
    enforce(
      authorize(principal, 'integrations.manage', resource, {
        now: this.clock(),
        stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
      }),
    );
  }

  /** The brand's connection: the one its web chat inbox belongs to (one account per brand). */
  private async brandConnection(tx: TenantTx, principal: StaffPrincipal, brandPublicId: string) {
    const brandId = fromPublicId('brand', brandPublicId);
    const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
    if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    this.decide(principal, { workspaceId: brand.workspaceId, brandId });
    const [live] = await tx
      .select({ connectionId: schema.authorityInboxes.connectionId })
      .from(schema.authorityInboxes)
      .where(
        and(
          eq(schema.authorityInboxes.brandId, brandId),
          eq(schema.authorityInboxes.purpose, 'live'),
        ),
      );
    return { brand, connectionId: live?.connectionId ?? null };
  }

  async list(principal: StaffPrincipal, brandPublicId: string): Promise<ChannelInbox[]> {
    return this.tx(principal, async (tx) => {
      const { brand, connectionId } = await this.brandConnection(tx, principal, brandPublicId);
      if (!connectionId) return [];
      return this.views(tx, connectionId, brand.id);
    });
  }

  /** "Check for new channels": reads the account's inboxes now instead of at the next poll. */
  async find(principal: StaffPrincipal, brandPublicId: string): Promise<ChannelInbox[]> {
    const found = await this.tx(principal, (tx) =>
      this.brandConnection(tx, principal, brandPublicId),
    );
    if (!found.connectionId) return [];
    try {
      await this.discover(principal.tenantId, found.connectionId);
    } catch (error) {
      throw new AppError('AUTHORITY_UNAVAILABLE', {
        detail: 'Chatwoot could not be reached to look for channels. Please try again.',
        internal: error,
      });
    }
    return this.list(principal, brandPublicId);
  }

  private async views(tx: TenantTx, connectionId: string, brandId: string) {
    const rows = await tx
      .select()
      .from(schema.authorityInboxes)
      .where(
        and(
          eq(schema.authorityInboxes.connectionId, connectionId),
          eq(schema.authorityInboxes.purpose, 'channel'),
          eq(schema.authorityInboxes.status, 'active'),
          or(eq(schema.authorityInboxes.brandId, brandId), isNull(schema.authorityInboxes.brandId)),
        ),
      )
      .orderBy(schema.authorityInboxes.createdAt);
    const counts = rows.length
      ? await tx
          .select({
            inboxId: schema.conversationControls.inboxId,
            n: sql<number>`count(*)::int`,
          })
          .from(schema.conversationControls)
          .where(
            and(
              inArray(
                schema.conversationControls.inboxId,
                rows.map((r) => r.id),
              ),
              gte(
                schema.conversationControls.createdAt,
                new Date(this.clock().getTime() - 7 * 86_400_000),
              ),
            ),
          )
          .groupBy(schema.conversationControls.inboxId)
      : [];
    const byInbox = new Map(counts.map((c) => [c.inboxId, c.n]));
    return rows.map((row) => view(row, byInbox.get(row.id) ?? 0));
  }

  async update(
    principal: StaffPrincipal,
    channelPublicId: string,
    input: UpdateChannelRequest,
  ): Promise<ChannelInbox> {
    const inboxId = fromPublicId('inbox', channelPublicId);
    const changed = await this.tx(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.authorityInboxes)
        .where(
          and(
            eq(schema.authorityInboxes.id, inboxId),
            eq(schema.authorityInboxes.purpose, 'channel'),
          ),
        )
        .for('update');
      if (!row) throw new AppError('NOT_FOUND', { detail: 'Channel not found.' });
      let brandId = row.brandId;
      if (input.brandId !== undefined) {
        const wanted = fromPublicId('brand', input.brandId);
        if (brandId && brandId !== wanted) {
          throw new AppError('VALIDATION_FAILED', {
            detail: 'This channel already answers for a brand.',
            fields: [{ path: 'brandId', message: 'This channel already answers for a brand.' }],
          });
        }
        brandId = wanted;
      }
      if (!brandId) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Choose the brand this channel answers for first.',
          fields: [{ path: 'brandId', message: 'Choose a brand.' }],
        });
      }
      const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
      if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
      this.decide(principal, { workspaceId: brand.workspaceId, brandId });
      // Claimed only for the brand whose Chatwoot account it is in.
      const [live] = await tx
        .select({ id: schema.authorityInboxes.id })
        .from(schema.authorityInboxes)
        .where(
          and(
            eq(schema.authorityInboxes.brandId, brandId),
            eq(schema.authorityInboxes.connectionId, row.connectionId),
            eq(schema.authorityInboxes.purpose, 'live'),
          ),
        );
      if (!live) {
        throw new AppError('VALIDATION_FAILED', {
          detail: "This channel is in another brand's Chatwoot account.",
          fields: [
            { path: 'brandId', message: "This channel is in another brand's Chatwoot account." },
          ],
        });
      }
      let teamId = row.defaultTeamId;
      if (input.defaultTeamId !== undefined) {
        teamId = input.defaultTeamId ? fromPublicId('team', input.defaultTeamId) : null;
        if (teamId) {
          const [team] = await tx
            .select({ id: schema.teams.id })
            .from(schema.teams)
            .where(eq(schema.teams.id, teamId));
          if (!team) {
            throw new AppError('VALIDATION_FAILED', {
              detail: 'That team no longer exists.',
              fields: [{ path: 'defaultTeamId', message: 'That team no longer exists.' }],
            });
          }
        }
      }
      const now = this.clock();
      const pausedAt =
        input.paused === undefined ? row.pausedAt : input.paused ? (row.pausedAt ?? now) : null;
      const aiAnswers = input.aiAnswers ?? row.aiAnswers;
      const [updated] = await tx
        .update(schema.authorityInboxes)
        .set({ brandId, defaultTeamId: teamId, pausedAt, aiAnswers, updatedAt: now })
        .where(eq(schema.authorityInboxes.id, row.id))
        .returning();
      if (!updated) throw new AppError('NOT_FOUND');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'channel.updated',
        targetType: 'authority_inbox',
        targetId: toPublicId('inbox', row.id),
        outcome: 'success',
        data: {
          brandId: toPublicId('brand', brandId),
          aiAnswers,
          defaultTeamId: teamId ? toPublicId('team', teamId) : null,
          paused: pausedAt !== null,
        },
      });
      return { before: row, after: updated };
    });
    const { before, after } = changed;
    // The AI's bot goes on the inbox only while the AI answers there and it is not paused.
    const wantsBot = after.aiAnswers && !after.pausedAt;
    const hadBot = before.aiAnswers && !before.pausedAt;
    if (wantsBot !== hadBot) await this.attachBot(principal.tenantId, after, wantsBot);
    return this.tx(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.authorityInboxes)
        .where(eq(schema.authorityInboxes.id, after.id));
      const [one] = await this.viewsFor(tx, row as InboxRow);
      return one as ChannelInbox;
    });
  }

  private async viewsFor(tx: TenantTx, row: InboxRow) {
    return (await this.views(tx, row.connectionId, row.brandId ?? '')).filter(
      (v) => v.id === toPublicId('inbox', row.id),
    );
  }

  private async attachBot(tenantId: string, inbox: InboxRow, on: boolean): Promise<void> {
    const runtime = await this.registry.get(tenantId, inbox.connectionId);
    const bot = runtime.primaryBot;
    if (on && !bot) return;
    try {
      await setInboxAgentBot({
        baseUrl: runtime.baseUrl,
        token: runtime.integrationToken,
        accountId: runtime.accountId,
        inboxId: inbox.externalInboxId,
        botId: on && bot ? bot.externalBotId : null,
      });
    } catch (error) {
      throw new AppError('AUTHORITY_UNAVAILABLE', {
        detail: on
          ? 'The setting is saved, but Chatwoot could not hand this channel to the AI yet. Please try again.'
          : 'The setting is saved, but Chatwoot could not take this channel from the AI yet. Please try again.',
        internal: error,
      });
    }
  }

  /**
   * Records the channel inboxes the account has. New ones answer for the account's brand (one
   * account per brand); inboxes gone from Chatwoot are disabled, their history kept. Returns how
   * many were added.
   */
  async discover(tenantId: string, connectionId: string): Promise<number> {
    const runtime = await this.registry.get(tenantId, connectionId);
    const found = (
      await listInboxes({
        baseUrl: runtime.baseUrl,
        token: runtime.integrationToken,
        accountId: runtime.accountId,
      })
    ).filter((inbox) => inbox.channelType !== 'Channel::Api');
    const { added, staffUserIds } = await withTenant(
      this.db,
      { tenantId, actorId: 'authority' },
      async (tx) => {
        const known = await tx
          .select()
          .from(schema.authorityInboxes)
          .where(eq(schema.authorityInboxes.connectionId, connectionId));
        const byExternal = new Map(known.map((row) => [row.externalInboxId, row]));
        const brandId =
          known.find((row) => row.purpose === 'live' && row.status === 'active')?.brandId ?? null;
        const now = this.clock();
        const added: number[] = [];
        for (const inbox of found) {
          const row = byExternal.get(inbox.id);
          if (row) {
            if (row.purpose !== 'channel') continue;
            if (row.name !== inbox.name || row.displayAddress !== inbox.address) {
              await tx
                .update(schema.authorityInboxes)
                .set({ name: inbox.name, displayAddress: inbox.address, updatedAt: now })
                .where(eq(schema.authorityInboxes.id, row.id));
            }
            continue;
          }
          await tx.insert(schema.authorityInboxes).values({
            tenantId,
            connectionId,
            brandId,
            purpose: 'channel',
            externalInboxId: inbox.id,
            channelType: inbox.channelType,
            name: inbox.name,
            displayAddress: inbox.address,
          });
          await tx
            .insert(schema.reconcileCursors)
            .values({
              tenantId,
              connectionId,
              scope: 'inbox',
              scopeRef: String(inbox.id),
              intervalSeconds: CHANNEL_POLL_SECONDS,
              nextPollAt: now,
            })
            .onConflictDoNothing();
          added.push(inbox.id);
        }
        const present = new Set(found.map((inbox) => inbox.id));
        for (const row of known) {
          if (
            row.purpose !== 'channel' ||
            row.status !== 'active' ||
            present.has(row.externalInboxId)
          ) {
            continue;
          }
          await tx
            .update(schema.authorityInboxes)
            .set({ status: 'disabled', updatedAt: now })
            .where(eq(schema.authorityInboxes.id, row.id));
          await tx
            .delete(schema.reconcileCursors)
            .where(
              and(
                eq(schema.reconcileCursors.connectionId, connectionId),
                eq(schema.reconcileCursors.scope, 'inbox'),
                eq(schema.reconcileCursors.scopeRef, String(row.externalInboxId)),
              ),
            );
        }
        // The discovery cursor itself, for a connection made before channels existed.
        await tx
          .insert(schema.reconcileCursors)
          .values({
            tenantId,
            connectionId,
            scope: 'inbox',
            scopeRef: CHANNEL_DISCOVERY_REF,
            intervalSeconds: CHANNEL_DISCOVERY_SECONDS,
            nextPollAt: new Date(now.getTime() + CHANNEL_DISCOVERY_SECONDS * 1000),
          })
          .onConflictDoNothing();
        const links = added.length
          ? await tx
              .select({ userId: schema.staffAuthorityLinks.externalUserId })
              .from(schema.staffAuthorityLinks)
              .where(
                and(
                  eq(schema.staffAuthorityLinks.connectionId, connectionId),
                  eq(schema.staffAuthorityLinks.status, 'active'),
                ),
              )
          : [];
        return { added, staffUserIds: links.map((link) => link.userId) };
      },
    );
    if (added.length === 0) return 0;
    this.registry.invalidate(tenantId, connectionId);
    this.logger.log(`found ${added.length} channel inbox(es) on connection ${connectionId}`);
    // Staff already linked join the new inboxes, so they can answer there in Chatwoot as well.
    for (const inboxId of staffUserIds.length ? added : []) {
      await addInboxMembers({
        baseUrl: runtime.baseUrl,
        token: runtime.integrationToken,
        accountId: runtime.accountId,
        inboxId,
        userIds: staffUserIds,
      }).catch((error: unknown) =>
        this.logger.warn(`staff not added to channel inbox ${inboxId}: ${String(error)}`),
      );
    }
    return added.length;
  }

  /** Channel inboxes of a connection that still answer (for the inbox poll). */
  async activeChannel(tx: TenantTx, connectionId: string, inboxRef: string) {
    const external = Number(inboxRef);
    if (!Number.isInteger(external)) return null;
    const [row] = await tx
      .select()
      .from(schema.authorityInboxes)
      .where(
        and(
          eq(schema.authorityInboxes.connectionId, connectionId),
          eq(schema.authorityInboxes.externalInboxId, external),
          eq(schema.authorityInboxes.purpose, 'channel'),
          ne(schema.authorityInboxes.status, 'disabled'),
        ),
      );
    return row ?? null;
  }
}
