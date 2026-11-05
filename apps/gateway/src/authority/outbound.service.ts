import { ChatwootError } from '@hamnivo/chatwoot';
import type { Message } from '@hamnivo/contracts';
import { type Db, newId, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import type {
  AppendMessageInput,
  AuthorityMessage,
  MessageAuthor,
  OutgoingAttachment,
} from '@hamnivo/domain';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import { supersedeAiDrafts } from '../inbox/ai-drafts.js';
import { recordHumanReply, syncSla } from '../inbox/sla.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { type JournalEntry, JournalService } from './journal.service.js';
import { type ControlRow, OwnershipService } from './ownership.service.js';
import { AuthorityRegistry } from './registry.js';
import { authorityMessageUuid } from './uuid.js';
import { contractMessage } from './views.js';

const IN_FLIGHT_MS = 30_000;

export function authorityUnavailable(error: unknown, detail: string): AppError {
  const retryable = !(error instanceof ChatwootError) || error.retryable;
  return new AppError('AUTHORITY_UNAVAILABLE', {
    detail,
    retryable,
    ...(retryable ? { retryAfter: 2 } : {}),
    internal: error,
  });
}

export interface OutboundInput {
  tenantId: string;
  actorId: string;
  conversationId: string;
  sender: { kind: 'customer' | 'staff'; id: string };
  clientMessageId: string;
  requestHash: Buffer;
  author: MessageAuthor;
  visibility: 'public' | 'private';
  text: string;
  contentAttributes?: Record<string, unknown>;
  /** A WhatsApp template message (D14); `text` is its rendered transcript. */
  template?: AppendMessageInput['template'];
  /**
   * Files that travel with the message (W09), read after `load` ran, so they can be claimed in
   * the same transaction as the ledger reservation.
   */
  attachments?: () => OutgoingAttachment[];
  /** Loads (and authorizes) the conversation inside the reservation transaction. */
  load: (tx: TenantTx) => Promise<ControlRow>;
  /** False for a message that asks for no answer (a customer's reaction, W22). */
  expectsReply?: boolean;
  /** Runs in the commit transaction, only for the call that committed the message. */
  onCommitted?: (tx: TenantTx, control: ControlRow, ledgerId: string) => Promise<void>;
}

export interface OutboundResult {
  message: Message;
  status: 'accepted' | 'duplicate';
}

/**
 * Exactly-once writes to the authority through the message ledger (W12). A request is reserved
 * under (conversation, sender, client message id) with its hash; the same id with another body is
 * IDEMPOTENCY_CONFLICT; after a timeout the outcome is resolved by looking the key up in Chatwoot,
 * never by writing blindly again.
 */
@Injectable()
export class OutboundMessagesService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: AuthorityRegistry,
    private readonly journal: JournalService,
    private readonly ownership: OwnershipService,
  ) {}

  private tx<T>(input: OutboundInput, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(this.db, { tenantId: input.tenantId, actorId: input.actorId }, work);
  }

  /** The journaled copy of a message (to answer a duplicate send), if still retained. */
  async journaled(
    tx: TenantTx,
    conversationId: string,
    authorityId: number,
  ): Promise<Message | null> {
    const j = schema.conversationJournal;
    const [row] = await tx
      .select({ event: j.event })
      .from(j)
      .where(
        and(
          eq(j.conversationId, conversationId),
          eq(j.authorityId, authorityId),
          eq(j.eventType, 'message.created'),
        ),
      );
    return (
      ((row?.event as { data?: { message?: Message } } | undefined)?.data?.message as Message) ??
      null
    );
  }

  async send(input: OutboundInput): Promise<OutboundResult> {
    const now = this.clock();
    const reserved = await this.tx(input, async (tx) => {
      const control = await input.load(tx);
      const ledgerId = newId();
      const [inserted] = await tx
        .insert(schema.messageLedger)
        .values({
          id: ledgerId,
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          senderKind: input.sender.kind,
          senderId: input.sender.id,
          clientMessageId: input.clientMessageId,
          requestHash: input.requestHash,
          sourceKey: `hv1:${input.visibility === 'private' ? 'n' : 'm'}:${ledgerId}`,
          expectsReply: input.expectsReply ?? true,
        })
        .onConflictDoNothing()
        .returning();
      const [row] = inserted
        ? [inserted]
        : await tx
            .select()
            .from(schema.messageLedger)
            .where(
              and(
                eq(schema.messageLedger.conversationId, input.conversationId),
                eq(schema.messageLedger.senderKind, input.sender.kind),
                eq(schema.messageLedger.senderId, input.sender.id),
                eq(schema.messageLedger.clientMessageId, input.clientMessageId),
              ),
            );
      if (!row) throw new Error('ledger row missing');
      if (!row.requestHash.equals(input.requestHash)) {
        throw new AppError('IDEMPOTENCY_CONFLICT', {
          detail: 'This message id was already used for a different message.',
        });
      }
      const replay =
        row.state === 'committed' && row.authorityMessageId !== null
          ? await this.journaled(tx, input.conversationId, row.authorityMessageId)
          : null;
      return { control, row, fresh: Boolean(inserted), replay };
    });
    if (reserved.replay) return { message: reserved.replay, status: 'duplicate' };
    const { control, row } = reserved;
    const runtime = await this.registry.get(input.tenantId, control.connectionId);
    const ref = String(control.externalConversationId);

    let committed: AuthorityMessage | null = null;
    if (!reserved.fresh) {
      committed = await runtime.authority
        .findByKey(ref, row.sourceKey, row.createdAt)
        .catch(() => null);
      if (
        !committed &&
        row.state === 'pending' &&
        now.getTime() - row.createdAt.getTime() < IN_FLIGHT_MS
      ) {
        throw new AppError('AUTHORITY_UNAVAILABLE', {
          detail: 'The message is still being delivered.',
          retryable: true,
          retryAfter: 2,
        });
      }
    }
    if (!committed) {
      const files = input.attachments?.() ?? [];
      try {
        ({ message: committed } = await runtime.authority.appendMessage({
          conversationRef: ref,
          key: row.sourceKey,
          author: input.author,
          visibility: input.visibility,
          text: input.text,
          ...(input.contentAttributes ? { contentAttributes: input.contentAttributes } : {}),
          ...(files.length > 0 ? { attachments: files } : {}),
          ...(input.template ? { template: input.template } : {}),
        }));
      } catch (error) {
        const retryable = !(error instanceof ChatwootError) || error.retryable;
        await this.tx(input, (tx) =>
          tx
            .update(schema.messageLedger)
            .set({
              state: retryable ? 'unknown' : 'failed',
              errorCode: error instanceof ChatwootError ? `chatwoot_${error.status}` : 'network',
              updatedAt: this.clock(),
            })
            .where(eq(schema.messageLedger.id, row.id)),
        );
        throw authorityUnavailable(
          error,
          'The message was not confirmed yet. Sending it again is safe.',
        );
      }
    }
    const authorityMessage = committed;
    const { message, entries } = await this.tx(input, (tx) =>
      this.commit(tx, input, row.id, authorityMessage, control.connectionId),
    );
    await this.journal.notify(input.tenantId, input.conversationId, entries);
    return { message, status: reserved.fresh ? 'accepted' : 'duplicate' };
  }

  private async commit(
    tx: TenantTx,
    input: OutboundInput,
    ledgerId: string,
    authorityMessage: AuthorityMessage,
    connectionId: string,
  ): Promise<{ message: Message; entries: JournalEntry[] }> {
    const control = await this.ownership.lock(tx, input.conversationId);
    const authorityId = Number(authorityMessage.ref);
    const now = this.clock();
    const [transitioned] = await tx
      .update(schema.messageLedger)
      .set({
        state: 'committed',
        authorityMessageId: authorityId,
        committedAt: now,
        updatedAt: now,
      })
      .where(
        and(eq(schema.messageLedger.id, ledgerId), ne(schema.messageLedger.state, 'committed')),
      )
      .returning({ id: schema.messageLedger.id });
    const view = contractMessage({
      message: authorityMessage,
      id: toPublicId('message', authorityMessageUuid(connectionId, authorityMessage.ref)),
      conversationId: toPublicId('conversation', input.conversationId),
      sequence: null,
      clientMessageId: input.clientMessageId,
      delivery: 'accepted',
    });
    const lane = input.visibility === 'private' ? 'staff' : 'customer';
    let entries: JournalEntry[] = [];
    if (!(await this.journal.hasMessage(tx, input.conversationId, lane, authorityId))) {
      entries = await this.journal.append(tx, input.tenantId, input.conversationId, [
        {
          lane,
          type: 'message.created',
          data: { message: view },
          authorityCreatedAt: authorityMessage.createdAt,
          authorityId,
        },
      ]);
    }
    // A person's public reply ends the reply-time clock (H12). Recorded where the message is first
    // journaled: here, or in the processor when Chatwoot's webhook came first.
    if (entries.length > 0 && input.sender.kind === 'staff' && input.visibility === 'public') {
      await recordHumanReply(tx, input.tenantId, input.conversationId, now);
      await syncSla(tx, input.tenantId, input.conversationId, now);
      // A person answered by hand: a pending AI draft is no longer needed (HNV-09-05). Approving a
      // draft decides it before sending, so the draft being sent is never pending here.
      await supersedeAiDrafts(tx, input.conversationId, 'answered', now);
    }
    if (transitioned && input.onCommitted) await input.onCommitted(tx, control, ledgerId);
    const journaledMessage = (entries[0]?.event.data as { message?: Message } | undefined)?.message;
    return {
      message:
        journaledMessage ?? (await this.journaled(tx, input.conversationId, authorityId)) ?? view,
      entries,
    };
  }
}
