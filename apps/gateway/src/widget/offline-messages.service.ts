import { randomBytes } from 'node:crypto';
import {
  type OfflineMessageRequest,
  type OfflineMessageResponse,
  ticketReference,
} from '@hamnivo/contracts';
import { type Db, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, gt } from 'drizzle-orm';
import { uuidV5 } from '../authority/uuid.js';
import { AppError } from '../common/app-error.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { makeTicket } from '../tickets/tickets.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { WidgetConversationsService } from './conversations.service.js';
import { maskEmail } from './notifications.service.js';
import { brandSurface } from './settings.service.js';
import { sha256, type WidgetClaims } from './tokens.service.js';

/** The worker sends the confirmation email for a ticket's address (W11, H19). */
export const TICKET_CONFIRM_TOPIC = 'customer.ticket_confirm';

/** Messages one customer may leave with the contact form in an hour. */
const MESSAGES_PER_HOUR = 5;
/** One confirmation to an address in this time, however many messages name it. */
const CONFIRMATION_GAP_MS = 10 * 60_000;

/**
 * The contact form for when nobody can answer (W11). What the customer writes becomes a ticket
 * (H19): a conversation with a number, waiting for people unless the brand lets its AI assistant
 * answer first. One email asks the customer to confirm the address they typed, without repeating
 * what they wrote; answers go to that address only once it is confirmed.
 */
@Injectable()
export class OfflineMessagesService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly conversations: WidgetConversationsService,
  ) {}

  private tx<T>(claims: WidgetClaims, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: claims.tenantId, actorId: toPublicId('customer', claims.principalId) },
      work,
    );
  }

  async send(
    claims: WidgetClaims,
    input: OfflineMessageRequest,
    country: string | null,
  ): Promise<OfflineMessageResponse> {
    const now = this.clock();
    const { form, recent } = await this.tx(claims, async (tx) => {
      const surface = await brandSurface(tx, claims.brandId);
      const [row] = await tx
        .select({ n: count() })
        .from(schema.ticketFollowups)
        .where(
          and(
            eq(schema.ticketFollowups.principalId, claims.principalId),
            gt(schema.ticketFollowups.createdAt, new Date(now.getTime() - 3_600_000)),
          ),
        );
      return { form: surface.forms.offline, recent: row?.n ?? 0 };
    });
    if (!form.enabled) {
      throw new AppError('FEATURE_DISABLED', { detail: 'This chat has no contact form.' });
    }
    if (recent >= MESSAGES_PER_HOUR) {
      throw new AppError('RATE_LIMITED', {
        detail: 'You have left several messages already. Please wait for an answer.',
        retryAfter: 3600,
      });
    }
    let ticket: { number: number; email: string; confirmationSent: boolean } | null = null;
    const opened = await this.conversations.open(claims, {
      country,
      form: 'offline',
      answers: input.answers,
      aiFirst: form.aiFirst,
      onRecorded: async (tx, conversationId, accepted) => {
        const email = accepted?.email;
        // The contract makes the email field required, so a form without one cannot be saved.
        if (!email) throw new Error('contact form answers without an email');
        const { number } = await makeTicket(
          tx,
          claims.tenantId,
          conversationId,
          'offline_form',
          now,
        );
        // One confirmation to an address in a while, however many messages name it.
        const [asked] = await tx
          .select({ id: schema.ticketFollowups.id })
          .from(schema.ticketFollowups)
          .where(
            and(
              eq(schema.ticketFollowups.brandId, claims.brandId),
              eq(schema.ticketFollowups.email, email),
              gt(schema.ticketFollowups.createdAt, new Date(now.getTime() - CONFIRMATION_GAP_MS)),
            ),
          )
          .limit(1);
        const [followup] = await tx
          .insert(schema.ticketFollowups)
          .values({
            tenantId: claims.tenantId,
            brandId: claims.brandId,
            conversationId,
            principalId: claims.principalId,
            email,
            // Replaced by the hash of the emailed token when the confirmation goes out.
            confirmTokenHash: sha256(randomBytes(32).toString('hex')),
          })
          .returning({ id: schema.ticketFollowups.id });
        if (!followup) throw new Error('ticket follow-up insert returned nothing');
        if (!asked) {
          await enqueueOutbox(tx, claims.tenantId, {
            topic: TICKET_CONFIRM_TOPIC,
            aggregateType: 'conversation',
            aggregateId: conversationId,
            payload: { followupId: followup.id },
          });
        }
        ticket = { number, email, confirmationSent: !asked };
      },
    });
    const made = ticket as { number: number; email: string; confirmationSent: boolean } | null;
    if (!made) throw new Error('contact form ticket was not recorded');
    const publicId = toPublicId('conversation', opened.conversationId);
    if (opened.accepted?.question) {
      await this.conversations.send(claims, publicId, {
        // Derived from the request, so a retry of the same form posts the message once.
        clientMessageId: uuidV5(opened.conversationId, `offline:${input.clientRequestId}`),
        parts: [{ type: 'text', text: opened.accepted.question, format: 'plain' }],
        ...(input.context ? { context: input.context } : {}),
      });
    }
    return {
      conversation: await this.conversations.get(claims, publicId),
      reference: ticketReference(made.number),
      email: maskEmail(made.email),
      confirmationSent: made.confirmationSent,
    };
  }
}
