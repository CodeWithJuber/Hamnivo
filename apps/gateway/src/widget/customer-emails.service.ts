import type { Message, MessagePart } from '@hamnivo/contracts';
import {
  type ClaimedOutboxEvent,
  type Db,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gt, ne } from 'drizzle-orm';
import { AuthorityRegistry } from '../authority/registry.js';
import { authorityMessageUuid } from '../authority/uuid.js';
import { contractMessage, publicationFacts } from '../authority/views.js';
import type { AppConfig } from '../config.js';
import type { Mailer } from '../platform/mailer.js';
import { APP_DB, CLOCK, type Clock, CONFIG, MAILER } from '../tokens.js';
import { AuthorityContactsService } from './contacts.service.js';
import { type EmailKind, UnsubscribeTokens } from './notifications.service.js';
import { NOTIFY_COPY, type NotifyCopy, notifyLocale } from './notifications-copy.js';
import { originAllowed } from './origins.js';
import { brandSurface } from './settings.service.js';

/** A conversation emails its customer about waiting replies at most once in this time. */
const REPLY_EMAIL_GAP_MS = 30 * 60_000;

type Kind = 'transcript' | 'reply_waiting';

/** One transcript line per message; files, places and contacts are named, never attached. */
export function transcriptLine(message: Message, copy: NotifyCopy, when: string): string {
  const who =
    message.sender.kind === 'customer'
      ? copy.you
      : message.sender.kind === 'human_agent'
        ? `${message.sender.displayName} (${copy.supportAgent})`
        : message.sender.kind === 'ai_agent'
          ? `${message.sender.displayName} (${copy.aiAssistant})`
          : message.sender.displayName;
  const text = message.parts
    .map((part: MessagePart) => {
      switch (part.type) {
        case 'text':
          return part.text;
        case 'attachment':
          return `[${copy.file}: ${part.name}]`;
        case 'location':
          return `[${copy.place}: ${part.label ? `${part.label} ` : ''}(${part.latitude.toFixed(5)}, ${part.longitude.toFixed(5)})]`;
        case 'contact':
          return `[${copy.contact}: ${[part.name, part.phone, part.email].filter(Boolean).join(', ')}]`;
        case 'reaction':
          return `[${copy.reacted}: ${part.emoji}]`;
        case 'notice':
          return part.notice === 'message_deleted' ? `[${copy.deleted}]` : part.text;
        case 'card':
          return part.fallbackText;
        case 'unknown':
          return part.fallbackText ?? '';
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n');
  return `${when} — ${who}: ${text}`;
}

/**
 * Sends the customer emails a verified customer asked for (W25): a transcript when a conversation
 * closes, and "a reply is waiting" when a reply stays unread. Each email is recorded once by its
 * key, so a redelivered job sends nothing twice; choices are checked again just before sending.
 */
@Injectable()
export class CustomerEmailsService {
  private readonly logger = new Logger(CustomerEmailsService.name);
  private readonly tokens: UnsubscribeTokens;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly registry: AuthorityRegistry,
    private readonly contacts: AuthorityContactsService,
  ) {
    this.tokens = new UnsubscribeTokens(config);
  }

  private unsubscribeUrl(tenantId: string, principalId: string, kind: EmailKind): string {
    const token = this.tokens.sign({ t: tenantId, p: principalId, k: kind });
    return `${this.config.PUBLIC_API_ORIGIN.replace(/\/$/, '')}/v1/notifications/unsubscribe?token=${token}`;
  }

  private async record(
    tenantId: string,
    input: {
      principalId: string;
      conversationId: string;
      kind: Kind;
      dedupeKey: string;
      status: 'sent' | 'skipped';
      skipReason?: string;
    },
  ): Promise<void> {
    await withTenant(this.db, { tenantId, actorId: 'notifications' }, (tx) =>
      tx
        .insert(schema.customerNotifications)
        .values({ tenantId, ...input, skipReason: input.skipReason ?? null })
        .onConflictDoNothing(),
    );
  }

  /** Who the email is for, if they still want it; otherwise why not. */
  private async recipient(tx: TenantTx, conversationId: string, kind: Kind, dedupeKey: string) {
    const [done] = await tx
      .select({ id: schema.customerNotifications.id })
      .from(schema.customerNotifications)
      .where(eq(schema.customerNotifications.dedupeKey, dedupeKey));
    if (done) return { skip: 'already_handled' as const };
    const [control] = await tx
      .select()
      .from(schema.conversationControls)
      .where(eq(schema.conversationControls.id, conversationId));
    if (!control?.principalId || !control.brandId) return { skip: 'no_customer' as const };
    const [principal] = await tx
      .select()
      .from(schema.customerPrincipals)
      .where(eq(schema.customerPrincipals.id, control.principalId));
    const [brand] = await tx
      .select()
      .from(schema.brands)
      .where(eq(schema.brands.id, control.brandId));
    const [prefs] = await tx
      .select()
      .from(schema.customerNotificationPreferences)
      .where(eq(schema.customerNotificationPreferences.principalId, control.principalId));
    const { settings } = await brandSurface(tx, control.brandId);
    const base = { control, principal, brand };
    if (!principal || !brand) return { skip: 'no_customer' as const, ...base };
    if (!settings.notifications.email) return { skip: 'turned_off_by_brand' as const, ...base };
    if (principal.kind !== 'verified' || !principal.email || !principal.emailVerifiedAt) {
      return { skip: 'no_verified_email' as const, ...base };
    }
    const wanted = kind === 'transcript' ? prefs?.transcript : prefs?.replyWaiting;
    if (!wanted) return { skip: 'turned_off' as const, ...base };
    return { skip: null, control, principal, brand, email: principal.email };
  }

  async onTranscript(event: ClaimedOutboxEvent): Promise<void> {
    const { conversationId, seq } = event.payload as { conversationId: string; seq: number };
    const tenantId = event.tenantId;
    const dedupeKey = `transcript:${conversationId}:${seq}`;
    const context = await withTenant(
      this.db,
      { tenantId, actorId: 'notifications' },
      async (tx) => {
        const who = await this.recipient(tx, conversationId, 'transcript', dedupeKey);
        if (who.skip !== null || !('email' in who)) return { who };
        const [contact] = await tx
          .select()
          .from(schema.authorityContacts)
          .where(
            and(
              eq(schema.authorityContacts.inboxId, who.control.inboxId),
              eq(schema.authorityContacts.principalId, who.principal.id),
            ),
          );
        const [inbox] = await tx
          .select({ externalInboxId: schema.authorityInboxes.externalInboxId })
          .from(schema.authorityInboxes)
          .where(eq(schema.authorityInboxes.id, who.control.inboxId));
        return {
          who,
          sourceId: contact ? this.contacts.sourceIdOf(tenantId, contact) : null,
          inbox,
        };
      },
    );
    const { who } = context;
    if (who.skip === 'already_handled') return;
    if (who.skip !== null || !('email' in who)) {
      if ('control' in who && who.control?.principalId) {
        await this.record(tenantId, {
          principalId: who.control.principalId,
          conversationId,
          kind: 'transcript',
          dedupeKey,
          status: 'skipped',
          skipReason: who.skip,
        });
      }
      return;
    }
    if (!('sourceId' in context) || !context.sourceId || !context.inbox) return;
    const runtime = await this.registry.get(tenantId, who.control.connectionId);
    // Only what the customer could see: Chatwoot's customer view leaves private notes out.
    const listed = await runtime.authority.listMessages(
      String(who.control.externalConversationId),
      {
        view: 'customer',
        contactSourceId: context.sourceId,
        inboxRef: String(context.inbox.externalInboxId),
      },
    );
    const facts = await withTenant(this.db, { tenantId }, (tx) =>
      publicationFacts(tx, conversationId, listed),
    );
    const lang = notifyLocale(who.principal.locale);
    const copy = NOTIFY_COPY[lang];
    const timeZone = who.brand.businessHours?.timezone ?? 'UTC';
    const format = new Intl.DateTimeFormat(lang, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    });
    const lines = [...listed]
      .sort((a, b) => Number(a.ref) - Number(b.ref))
      .map((m) =>
        contractMessage({
          message: m,
          id: toPublicId('message', authorityMessageUuid(who.control.connectionId, m.ref)),
          conversationId: toPublicId('conversation', conversationId),
          sequence: null,
          clientMessageId: null,
          delivery: null,
          ...(facts.has(m.ref) ? { facts: facts.get(m.ref) } : {}),
        }),
      )
      .map((m) => transcriptLine(m, copy, format.format(new Date(m.createdAt))));
    const unsubscribe = this.unsubscribeUrl(tenantId, who.principal.id, 'transcript');
    await this.mailer.send({
      to: who.email,
      subject: copy.transcriptSubject(who.brand.name),
      text: [
        copy.transcriptIntro(who.brand.name),
        '',
        ...lines,
        '',
        '—',
        copy.why(who.brand.name),
        `${copy.stop} ${unsubscribe}`,
      ].join('\n'),
      template: 'customer.transcript',
      headers: {
        'List-Unsubscribe': `<${unsubscribe}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    await this.record(tenantId, {
      principalId: who.principal.id,
      conversationId,
      kind: 'transcript',
      dedupeKey,
      status: 'sent',
    });
  }

  async onReplyWaiting(event: ClaimedOutboxEvent): Promise<void> {
    const { conversationId, authorityId } = event.payload as {
      conversationId: string;
      authorityId: number;
    };
    const tenantId = event.tenantId;
    const dedupeKey = `reply:${conversationId}:${authorityId}`;
    const now = this.clock();
    const context = await withTenant(
      this.db,
      { tenantId, actorId: 'notifications' },
      async (tx) => {
        const who = await this.recipient(tx, conversationId, 'reply_waiting', dedupeKey);
        if (who.skip !== null || !('email' in who)) return { who, reason: who.skip };
        const j = schema.conversationJournal;
        const [reply] = await tx
          .select({ seq: j.seq })
          .from(j)
          .where(
            and(
              eq(j.conversationId, conversationId),
              eq(j.lane, 'customer'),
              eq(j.eventType, 'message.created'),
              eq(j.authorityId, authorityId),
            ),
          );
        const [read] = await tx
          .select({ seq: schema.conversationReadState.customerReadSeq })
          .from(schema.conversationReadState)
          .where(eq(schema.conversationReadState.conversationId, conversationId));
        if (!reply) return { who, reason: 'unknown_reply' as const };
        if ((read?.seq ?? 0) >= reply.seq) return { who, reason: 'read' as const };
        const n = schema.customerNotifications;
        const [recent] = await tx
          .select({ id: n.id })
          .from(n)
          .where(
            and(
              eq(n.conversationId, conversationId),
              eq(n.kind, 'reply_waiting'),
              eq(n.status, 'sent'),
              gt(n.createdAt, new Date(now.getTime() - REPLY_EMAIL_GAP_MS)),
            ),
          )
          .limit(1);
        if (recent) return { who, reason: 'recently_notified' as const };
        // Where the customer chats: their latest website that the brand still allows.
        const [session] = await tx
          .select({ hostOrigin: schema.widgetSessions.hostOrigin })
          .from(schema.widgetSessions)
          .where(
            and(
              eq(schema.widgetSessions.principalId, who.principal.id),
              ne(schema.widgetSessions.hostOrigin, 'unknown'),
            ),
          )
          .orderBy(desc(schema.widgetSessions.lastUsedAt))
          .limit(1);
        const site =
          session && originAllowed(who.brand.allowedOrigins, session.hostOrigin)
            ? session.hostOrigin
            : null;
        return { who, reason: null, site };
      },
    );
    const { who, reason } = context;
    if (reason === 'already_handled') return;
    const principalId = 'control' in who ? who.control?.principalId : null;
    if (reason !== null || !('email' in who)) {
      if (principalId) {
        await this.record(tenantId, {
          principalId,
          conversationId,
          kind: 'reply_waiting',
          dedupeKey,
          status: 'skipped',
          skipReason: reason ?? 'no_verified_email',
        });
      }
      return;
    }
    const lang = notifyLocale(who.principal.locale);
    const copy = NOTIFY_COPY[lang];
    const unsubscribe = this.unsubscribeUrl(tenantId, who.principal.id, 'reply_waiting');
    const site = 'site' in context ? context.site : null;
    await this.mailer.send({
      to: who.email,
      subject: copy.replySubject(who.brand.name),
      text: [
        copy.replyBody(who.brand.name),
        ...(site ? ['', `${copy.openChat} ${site}`] : []),
        '',
        '—',
        copy.why(who.brand.name),
        `${copy.stop} ${unsubscribe}`,
      ].join('\n'),
      template: 'customer.reply_waiting',
      headers: {
        'List-Unsubscribe': `<${unsubscribe}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    await this.record(tenantId, {
      principalId: who.principal.id,
      conversationId,
      kind: 'reply_waiting',
      dedupeKey,
      status: 'sent',
    });
    this.logger.log(`reply-waiting email sent for conversation ${conversationId}`);
  }
}
