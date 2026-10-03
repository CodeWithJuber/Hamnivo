import { ChatwootError } from '@hamnivo/chatwoot';
import type { MessageDeletion, ReactionRequest } from '@hamnivo/contracts';
import { type Db, fromPublicId, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import { Inject, Injectable } from '@nestjs/common';
import canonicalize from 'canonicalize';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { JournalService } from '../authority/journal.service.js';
import {
  authorityUnavailable,
  OutboundMessagesService,
  type OutboundResult,
} from '../authority/outbound.service.js';
import { redactJournaledMessage } from '../authority/redaction.js';
import { AuthorityRegistry } from '../authority/registry.js';
import { authorityMessageUuid } from '../authority/uuid.js';
import { AppError } from '../common/app-error.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { brandSurface } from './settings.service.js';
import { sha256, type WidgetClaims } from './tokens.service.js';

/**
 * What a customer can do to a message after sending it (W22, W23). Chatwoot CE has no customer
 * edits, so editing is not offered. A customer may delete their own message within the brand's
 * window, where the authority keeps a "deleted" marker; outside it, or where the authority cannot,
 * they are told so. Chatwoot has no reactions either: a reaction travels as a short reply quoting
 * the message, which staff read as such, and never asks the assistant for an answer.
 */
@Injectable()
export class WidgetMessagesService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: AuthorityRegistry,
    private readonly journal: JournalService,
    private readonly outbound: OutboundMessagesService,
  ) {}

  private tx<T>(claims: WidgetClaims, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: claims.tenantId, actorId: toPublicId('customer', claims.principalId) },
      work,
    );
  }

  private async own(tx: TenantTx, claims: WidgetClaims, conversationId: string, lock = false) {
    const query = tx
      .select()
      .from(schema.conversationControls)
      .where(
        and(
          eq(schema.conversationControls.id, conversationId),
          eq(schema.conversationControls.principalId, claims.principalId),
        ),
      );
    const [control] = lock ? await query.for('update') : await query;
    if (!control) throw new AppError('NOT_FOUND', { detail: 'Conversation not found.' });
    return control;
  }

  /** Deletes one of the customer's own messages, within the brand's window (W23). */
  async delete(
    claims: WidgetClaims,
    conversationPublicId: string,
    messagePublicId: string,
  ): Promise<MessageDeletion> {
    const conversationId = fromPublicId('conversation', conversationPublicId);
    const notFound = () => new AppError('NOT_FOUND', { detail: 'Message not found.' });
    const now = this.clock();
    const target = await this.tx(claims, async (tx) => {
      const control = await this.own(tx, claims, conversationId);
      // Only the customer's own messages are in their ledger; anything else is "not found".
      const own = await tx
        .select({
          authorityMessageId: schema.messageLedger.authorityMessageId,
          committedAt: schema.messageLedger.committedAt,
          createdAt: schema.messageLedger.createdAt,
        })
        .from(schema.messageLedger)
        .where(
          and(
            eq(schema.messageLedger.conversationId, conversationId),
            eq(schema.messageLedger.senderKind, 'customer'),
            eq(schema.messageLedger.senderId, claims.principalId),
            eq(schema.messageLedger.state, 'committed'),
            isNotNull(schema.messageLedger.authorityMessageId),
          ),
        );
      const mine = own.find(
        (row) =>
          toPublicId(
            'message',
            authorityMessageUuid(control.connectionId, String(row.authorityMessageId)),
          ) === messagePublicId,
      );
      if (!mine?.authorityMessageId) throw notFound();
      const { settings } = await brandSurface(tx, claims.brandId);
      const [redacted] = await tx
        .select({ at: schema.conversationJournal.createdAt })
        .from(schema.conversationJournal)
        .where(
          and(
            eq(schema.conversationJournal.conversationId, conversationId),
            eq(schema.conversationJournal.lane, 'customer'),
            eq(schema.conversationJournal.authorityId, mine.authorityMessageId),
            eq(schema.conversationJournal.eventType, 'message.redacted'),
          ),
        )
        .limit(1);
      return { control, mine, windowMinutes: settings.deletion.windowMinutes, redacted };
    });
    if (target.redacted) {
      return { messageId: messagePublicId, deletedAt: target.redacted.at.toISOString() };
    }
    if (target.windowMinutes === 0) {
      throw new AppError('FEATURE_DISABLED', {
        detail: 'Messages can’t be deleted in this chat.',
      });
    }
    const sentAt = target.mine.committedAt ?? target.mine.createdAt;
    if (now.getTime() - sentAt.getTime() > target.windowMinutes * 60_000) {
      throw new AppError('DELETE_WINDOW_CLOSED', {
        detail: `Messages can be deleted for ${target.windowMinutes} minutes after sending.`,
      });
    }
    const runtime = await this.registry.get(claims.tenantId, target.control.connectionId);
    if (!runtime.authority.capabilities.customerDeletes) {
      throw new AppError('CAPABILITY_UNSUPPORTED', {
        detail: 'This chat can’t delete messages.',
      });
    }
    const authorityId = target.mine.authorityMessageId as number;
    try {
      await runtime.authority.deleteMessage(
        String(target.control.externalConversationId),
        String(authorityId),
        { kind: 'integration' },
      );
    } catch (error) {
      // Already gone in the authority: the marker below is still right.
      if (!(error instanceof ChatwootError && error.status === 404)) {
        throw authorityUnavailable(error, 'The message could not be deleted. Please try again.');
      }
    }
    const entries = await this.tx(claims, async (tx) => {
      await this.own(tx, claims, conversationId, true);
      return redactJournaledMessage(tx, this.journal, {
        tenantId: claims.tenantId,
        conversationId,
        lane: 'customer',
        authorityId,
        messageId: messagePublicId,
      });
    });
    await this.journal.notify(claims.tenantId, conversationId, entries);
    return { messageId: messagePublicId, deletedAt: now.toISOString() };
  }

  /**
   * Reacts to a reply (W22). The reaction is a customer message carrying `hv.reaction` and
   * Chatwoot's `in_reply_to`, sent exactly once through the message ledger; no reply is asked of
   * the assistant.
   */
  async react(
    claims: WidgetClaims,
    conversationPublicId: string,
    messagePublicId: string,
    input: z.output<typeof ReactionRequest>,
  ): Promise<OutboundResult> {
    const conversationId = fromPublicId('conversation', conversationPublicId);
    const target = await this.tx(claims, async (tx) => {
      await this.own(tx, claims, conversationId);
      const j = schema.conversationJournal;
      const [row] = await tx
        .select({ authorityId: j.authorityId, event: j.event })
        .from(j)
        .where(
          and(
            eq(j.conversationId, conversationId),
            eq(j.lane, 'customer'),
            eq(j.eventType, 'message.created'),
            sql`${j.event}->'data'->'message'->>'id' = ${messagePublicId}`,
          ),
        )
        .limit(1);
      const sender = (row?.event as { data?: { message?: { sender?: { kind?: string } } } })?.data
        ?.message?.sender?.kind;
      // Replies from people and the assistant can be reacted to; not one's own messages.
      if (!row?.authorityId || !sender || sender === 'customer' || sender === 'system') {
        throw new AppError('NOT_FOUND', { detail: 'Message not found.' });
      }
      return { authorityId: row.authorityId };
    });
    return this.outbound.send({
      tenantId: claims.tenantId,
      actorId: toPublicId('customer', claims.principalId),
      conversationId,
      sender: { kind: 'customer', id: claims.principalId },
      clientMessageId: input.clientMessageId,
      requestHash: sha256(
        canonicalize({ reaction: input.emoji, messageId: messagePublicId }) ?? '',
      ),
      author: { kind: 'customer' },
      visibility: 'public',
      text: input.emoji,
      contentAttributes: {
        in_reply_to: target.authorityId,
        hv: { v: 1, reaction: { emoji: input.emoji, messageId: messagePublicId } },
      },
      load: (tx) => this.own(tx, claims, conversationId),
    });
  }
}
