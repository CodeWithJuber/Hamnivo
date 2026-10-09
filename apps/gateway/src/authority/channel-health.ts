import {
  appendAudit,
  type ClaimedOutboxEvent,
  type Db,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { authorize, rolePatterns } from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppConfig } from '../config.js';
import { scopeFromRow } from '../identity/principal.service.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import type { Mailer } from '../platform/mailer.js';
import { APP_DB, CLOCK, type Clock, CONFIG, MAILER } from '../tokens.js';
import { channelKindOf } from './adopt.js';

/** Outbox topic of a channel going down or coming back (A11). */
export const CHANNEL_HEALTH_TOPIC = 'channel.health';
/** A channel down this long is worth an email; a shorter blip is not. */
export const CHANNEL_ALERT_AFTER_MS = 15 * 60_000;

type InboxRow = typeof schema.authorityInboxes.$inferSelect;
type Health = NonNullable<InboxRow['health']>;

interface HealthEvent {
  inboxId: string;
  state: 'down' | 'up';
  /** When the channel went down (its health's checkedAt), to tell this incident from the next. */
  since: string;
  /** Up: whether the team was told it was down, so it hears that it works again. */
  alerted?: boolean;
}

/**
 * Records that a channel stopped or started working: audited at once, and queued for the team.
 * Going down is queued 15 minutes ahead and only sent if the channel is still down then, so a
 * blip tells nobody; coming back is sent at once, to whoever heard it was down.
 */
export async function recordHealthChange(
  tx: TenantTx,
  tenantId: string,
  before: InboxRow,
  health: Health,
  now: Date,
): Promise<void> {
  const state = health.ok ? 'up' : 'down';
  await appendAudit(tx, {
    actorType: 'system',
    actorId: 'authority',
    action: health.ok ? 'channel.recovered' : 'channel.unhealthy',
    targetType: 'authority_inbox',
    targetId: toPublicId('inbox', before.id),
    outcome: health.ok ? 'success' : 'failed',
    data: { problem: health.message ?? null },
  });
  const payload: HealthEvent = {
    inboxId: before.id,
    state,
    since: health.ok ? (before.health?.checkedAt ?? now.toISOString()) : health.checkedAt,
    ...(health.ok ? { alerted: Boolean(before.health?.alertedAt) } : {}),
  };
  await enqueueOutbox(tx, tenantId, {
    topic: CHANNEL_HEALTH_TOPIC,
    aggregateType: 'authority_inbox',
    aggregateId: before.id,
    payload: payload as unknown as Record<string, unknown>,
    ...(health.ok ? {} : { availableAt: new Date(now.getTime() + CHANNEL_ALERT_AFTER_MS) }),
  });
}

const KIND_NAMES = { email: 'Email', whatsapp: 'WhatsApp', telegram: 'Telegram', other: 'Channel' };

/**
 * Emails the people who manage a brand's integrations when one of its channels has not worked for
 * 15 minutes, and again once it works. Each event is handled once (processed_events).
 */
@Injectable()
export class ChannelHealthNotices {
  private readonly logger = new Logger(ChannelHealthNotices.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  async onEvent(event: ClaimedOutboxEvent): Promise<void> {
    const change = event.payload as unknown as HealthEvent;
    const mail = await withTenant(
      this.db,
      { tenantId: event.tenantId, actorId: 'authority' },
      async (tx) => {
        const [claimed] = await tx
          .insert(schema.processedEvents)
          .values({ tenantId: event.tenantId, consumer: CHANNEL_HEALTH_TOPIC, eventId: event.id })
          .onConflictDoNothing()
          .returning({ eventId: schema.processedEvents.eventId });
        if (!claimed) return null;
        const [row] = await tx
          .select({ inbox: schema.authorityInboxes, brand: schema.brands })
          .from(schema.authorityInboxes)
          .innerJoin(schema.brands, eq(schema.brands.id, schema.authorityInboxes.brandId))
          .where(eq(schema.authorityInboxes.id, change.inboxId));
        if (!row || row.inbox.status !== 'active' || row.inbox.pausedAt) return null;
        const health = row.inbox.health;
        if (change.state === 'down') {
          // Still down since the same moment: not a blip, and not a later incident's job.
          if (!health || health.ok || health.checkedAt !== change.since) return null;
          await tx
            .update(schema.authorityInboxes)
            .set({ health: { ...health, alertedAt: this.clock().toISOString() } })
            .where(eq(schema.authorityInboxes.id, row.inbox.id));
        } else if (!change.alerted || !health?.ok) {
          return null;
        }
        const recipients = await this.managers(tx, row.brand);
        return { inbox: row.inbox, brand: row.brand, recipients };
      },
    );
    if (!mail) return;
    const kind = KIND_NAMES[channelKindOf(mail.inbox.channelType)];
    const channel = `${kind} channel "${mail.inbox.name ?? kind}"${mail.inbox.displayAddress ? ` (${mail.inbox.displayAddress})` : ''}`;
    const link = `${this.config.PUBLIC_CONSOLE_ORIGIN.replace(/\/$/, '')}/channels?brand=${toPublicId('brand', mail.brand.id)}`;
    const down = change.state === 'down';
    const subject = down
      ? `${mail.brand.name}: the ${kind} channel needs attention`
      : `${mail.brand.name}: the ${kind} channel works again`;
    const text = down
      ? `The ${channel} of ${mail.brand.name} has not worked for more than 15 minutes, so new messages there may not reach your team.\n\nWhat the chat engine says: ${mail.inbox.health?.message ?? 'it could not reach the channel.'}\n\nOpen Channels to fix it (for email, choose Fix sign-in and enter the password again):\n${link}`
      : `The ${channel} of ${mail.brand.name} works again. New messages reach your team as before.\n\n${link}`;
    for (const to of mail.recipients) {
      await this.mailer
        .send({
          to,
          template: down ? 'channel.unhealthy' : 'channel.recovered',
          subject,
          text,
        })
        .catch((error: unknown) =>
          this.logger.warn(`channel health email failed: ${String(error)}`),
        );
    }
  }

  /** Active staff whose grants let them manage this brand's integrations. */
  private async managers(
    tx: TenantTx,
    brand: typeof schema.brands.$inferSelect,
  ): Promise<string[]> {
    const rows = await tx
      .select({ member: schema.staffMembers, grant: schema.grants, role: schema.roleDefinitions })
      .from(schema.grants)
      .innerJoin(schema.staffMembers, eq(schema.staffMembers.id, schema.grants.staffMemberId))
      .innerJoin(schema.roleDefinitions, eq(schema.roleDefinitions.id, schema.grants.roleId))
      .where(and(isNull(schema.grants.revokedAt), eq(schema.staffMembers.status, 'active')));
    const now = this.clock();
    const emails = new Set<string>();
    for (const { member, grant, role } of rows) {
      const decision = authorize(
        {
          kind: 'staff',
          tenantId: member.tenantId,
          staffMemberId: member.id,
          status: 'active',
          mfa: true,
          authenticatedAt: now,
          grants: [
            {
              id: grant.id,
              permissions: rolePatterns(role),
              scope: scopeFromRow(grant.scopeType, grant.scopeId),
              expiresAt: grant.expiresAt,
              revokedAt: null,
            },
          ],
        },
        'integrations.manage',
        { workspaceId: brand.workspaceId, brandId: brand.id },
        { now },
      );
      if (decision.allowed) emails.add(member.email);
    }
    return [...emails];
  }
}
