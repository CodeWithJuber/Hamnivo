import {
  type AlertSoundChoice,
  DEFAULT_ALERT_SETTINGS,
  type InboxAlertSettings,
  type InboxPreferences,
  type UnreadSummary,
  type UpdateInboxAlertSettings,
} from '@hamnivo/contracts';
import { schema, type TenantTx } from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import { CLOCK, type Clock } from '../tokens.js';
import { InboxAccess } from './access.js';
import { type AlertChat, type AlertDecision, type AlertMessage, deriveAlerts } from './alerts.js';
import { AvailabilityService } from './availability.service.js';
import { InboxSignals } from './signals.service.js';
import { concernsStaff, markRead, unreadChats } from './unread.js';

type PreferenceRow = typeof schema.staffInboxPreferences.$inferSelect;

function settingsOf(row: PreferenceRow | undefined): InboxAlertSettings {
  if (!row) return structuredClone(DEFAULT_ALERT_SETTINGS);
  return {
    sounds: {
      muted: row.soundMuted,
      volume: row.soundVolume,
      newChat: row.soundNewChat as AlertSoundChoice,
      customerMessage: row.soundCustomerMessage as AlertSoundChoice,
      assigned: row.soundAssigned as AlertSoundChoice,
    },
    desktop: { enabled: row.desktopEnabled, showPreview: row.desktopPreview },
  };
}

/**
 * Alerts for the staff inbox: what each person chose (sounds, volume, mute, desktop alerts),
 * unread chats from the read markers the server keeps, and the alerts the inbox stream sends.
 */
@Injectable()
export class InboxAlertsService {
  constructor(
    private readonly access: InboxAccess,
    private readonly availability: AvailabilityService,
    private readonly signals: InboxSignals,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async preferences(principal: StaffPrincipal): Promise<InboxPreferences> {
    const [row] = await this.access.tx(principal, (tx) =>
      tx
        .select()
        .from(schema.staffInboxPreferences)
        .where(eq(schema.staffInboxPreferences.staffMemberId, principal.staffMemberId)),
    );
    return { alerts: settingsOf(row), availability: await this.availability.get(principal) };
  }

  async update(
    principal: StaffPrincipal,
    patch: UpdateInboxAlertSettings,
  ): Promise<InboxPreferences> {
    const sounds = patch.sounds ?? {};
    const desktop = patch.desktop ?? {};
    const values = {
      ...(sounds.muted !== undefined ? { soundMuted: sounds.muted } : {}),
      ...(sounds.volume !== undefined ? { soundVolume: sounds.volume } : {}),
      ...(sounds.newChat !== undefined ? { soundNewChat: sounds.newChat } : {}),
      ...(sounds.customerMessage !== undefined
        ? { soundCustomerMessage: sounds.customerMessage }
        : {}),
      ...(sounds.assigned !== undefined ? { soundAssigned: sounds.assigned } : {}),
      ...(desktop.enabled !== undefined ? { desktopEnabled: desktop.enabled } : {}),
      ...(desktop.showPreview !== undefined ? { desktopPreview: desktop.showPreview } : {}),
    };
    if (Object.keys(values).length === 0) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: '(body)', message: 'Send at least one setting to change.' }],
      });
    }
    await this.access.tx(principal, (tx) =>
      tx
        .insert(schema.staffInboxPreferences)
        .values({
          tenantId: principal.tenantId,
          staffMemberId: principal.staffMemberId,
          ...values,
        })
        .onConflictDoUpdate({
          target: [
            schema.staffInboxPreferences.tenantId,
            schema.staffInboxPreferences.staffMemberId,
          ],
          set: { ...values, updatedAt: this.clock() },
        }),
    );
    return this.preferences(principal);
  }

  /** Chats that need this person (ones they may answer), for the tab title and favicon. */
  async unread(principal: StaffPrincipal): Promise<UnreadSummary> {
    const scope = this.access.scope(principal, 'conversations.reply');
    if (!scope) return { chats: 0 };
    const chats = await this.access.tx(principal, (tx) =>
      unreadChats(tx, principal.staffMemberId, scope),
    );
    return { chats };
  }

  /** Marks the customer's messages so far as read by this person. */
  async read(principal: StaffPrincipal, publicId: string): Promise<void> {
    const found = await this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(tx, principal, publicId, 'conversations.read');
      await markRead(
        tx,
        principal.tenantId,
        principal.staffMemberId,
        found.control.id,
        found.control.journalSeq,
        this.clock(),
      );
      return found;
    });
    // The person's other tabs and windows show the chat as read too.
    await this.signals.changed(
      principal.tenantId,
      [found.control.id],
      'read',
      principal.staffMemberId,
    );
  }

  /**
   * The alerts for chats that changed since `since`, for one person's inbox stream. `chats` are
   * the changed conversations the person may see; only those that concern them can alert.
   */
  async derive(
    principal: StaffPrincipal,
    tx: TenantTx,
    chats: AlertChat[],
    since: Date,
    /** Keys the caller's stream has already handled. */
    seen: ReadonlySet<string>,
  ): Promise<AlertDecision> {
    const concerning = chats.filter(
      (chat) =>
        (chat.canReply !== false && concernsStaff(chat, principal.staffMemberId)) || chat.leadAlert,
    );
    if (concerning.length === 0) return { alerts: [], looked: [] };
    const j = schema.conversationJournal;
    // The newest customer message of each chat, whatever its age: an alert says what they wrote.
    const rows = await tx
      .selectDistinctOn([j.conversationId], {
        conversationId: j.conversationId,
        event: j.event,
        createdAt: j.createdAt,
      })
      .from(j)
      .where(
        and(
          inArray(
            j.conversationId,
            concerning.map((chat) => chat.id),
          ),
          eq(j.lane, 'customer'),
          eq(j.eventType, 'message.created'),
          sql`${j.event}->'data'->'message'->'sender'->>'kind' = 'customer'`,
        ),
      )
      .orderBy(j.conversationId, desc(j.seq));
    const messages: AlertMessage[] = rows.map((row) => {
      const message = (
        row.event as {
          data?: { message?: { id?: string; parts?: { type: string; text?: string }[] } };
        }
      ).data?.message;
      return {
        conversationId: row.conversationId,
        messageId: message?.id ?? `${row.conversationId}:${row.createdAt.getTime()}`,
        text: message?.parts?.find((part) => part.type === 'text')?.text ?? null,
        at: row.createdAt,
      };
    });
    return deriveAlerts({ me: principal.staffMemberId, since, chats: concerning, messages, seen });
  }
}
