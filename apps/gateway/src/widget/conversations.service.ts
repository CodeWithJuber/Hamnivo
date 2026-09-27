import { randomUUID } from 'node:crypto';
import type {
  CustomerConversation,
  HandoffRequest,
  MessagePage,
  SendMessageRequest,
  StartConversationRequest,
} from '@hamnivo/contracts';
import {
  type Db,
  fromPublicId,
  newId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import type { AuthorityMessage } from '@hamnivo/domain';
import { Inject, Injectable } from '@nestjs/common';
import canonicalize from 'canonicalize';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { JournalService } from '../authority/journal.service.js';
import {
  authorityUnavailable,
  OutboundMessagesService,
  type OutboundResult,
} from '../authority/outbound.service.js';
import { type ControlRow, OwnershipService } from '../authority/ownership.service.js';
import { RECONCILE_MIN_SECONDS } from '../authority/reconcile-policy.js';
import { AuthorityRegistry } from '../authority/registry.js';
import { authorityMessageUuid, uuidV5 } from '../authority/uuid.js';
import { contractMessage, publicationFacts } from '../authority/views.js';
import { AppError } from '../common/app-error.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { AgentsService } from '../runtime/agents.service.js';
import { HANDOFF_NOTES } from '../runtime/handoff-notes.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { AuthorityContactsService } from './contacts.service.js';
import { handoffMessage } from './copy.js';
import { sha256, type WidgetClaims } from './tokens.service.js';
import { customerConversation, lastPreview, principalConversations } from './views.js';

/**
 * The customer side of a conversation (W05–W07, W12): start, send (exactly once through the
 * message ledger), history from the authority's customer view, and "talk to a person".
 */
@Injectable()
export class WidgetConversationsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: AuthorityRegistry,
    private readonly contacts: AuthorityContactsService,
    private readonly journal: JournalService,
    private readonly ownership: OwnershipService,
    private readonly outbound: OutboundMessagesService,
    private readonly agents: AgentsService,
  ) {}

  private tx<T>(claims: WidgetClaims, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: claims.tenantId, actorId: toPublicId('customer', claims.principalId) },
      work,
    );
  }

  /** A conversation of this principal, or NOT_FOUND (never "forbidden", which would confirm it exists). */
  private async own(
    tx: TenantTx,
    claims: WidgetClaims,
    conversationId: string,
    lock = false,
  ): Promise<ControlRow> {
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

  private conversationId(publicId: string): string {
    return fromPublicId('conversation', publicId);
  }

  list(claims: WidgetClaims): Promise<CustomerConversation[]> {
    return this.tx(claims, (tx) => principalConversations(tx, claims.principalId));
  }

  get(claims: WidgetClaims, publicId: string): Promise<CustomerConversation> {
    return this.tx(claims, async (tx) => {
      const control = await this.own(tx, claims, this.conversationId(publicId));
      return customerConversation(control, await lastPreview(tx, control.id));
    });
  }

  async start(
    claims: WidgetClaims,
    input: z.output<typeof StartConversationRequest>,
  ): Promise<CustomerConversation> {
    const setup = await this.tx(claims, async (tx) => {
      const [inbox] = await tx
        .select()
        .from(schema.authorityInboxes)
        .where(
          and(
            eq(schema.authorityInboxes.brandId, claims.brandId),
            eq(schema.authorityInboxes.purpose, 'live'),
            eq(schema.authorityInboxes.status, 'active'),
          ),
        );
      const [principal] = await tx
        .select()
        .from(schema.customerPrincipals)
        .where(eq(schema.customerPrincipals.id, claims.principalId));
      return { inbox, principal };
    });
    if (!setup.inbox || !setup.principal) {
      throw new AppError('AUTHORITY_UNAVAILABLE', {
        detail: 'Chat is not set up for this website yet.',
        retryable: false,
      });
    }
    const inbox = setup.inbox;
    const runtime = await this.registry.get(claims.tenantId, inbox.connectionId);
    const conversationId = newId();
    let conversationRef: string;
    let aiOwned = Boolean(runtime.primaryBot);
    let status: 'open' | 'pending' | 'resolved' | 'snoozed' = aiOwned ? 'pending' : 'open';
    let version: number | null = null;
    try {
      const sourceId = await this.contacts.ensure(runtime, inbox, setup.principal);
      ({ conversationRef } = await runtime.authority.openConversation({
        inboxRef: String(inbox.externalInboxId),
        contactSourceId: sourceId,
        attributes: { hv_conversation: toPublicId('conversation', conversationId) },
      }));
      const state = await runtime.authority.getState(conversationRef).catch(() => null);
      if (state) {
        aiOwned = state.owner.kind === 'bot';
        status = state.status;
        version = state.version;
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw authorityUnavailable(error, 'The chat could not be started. Please try again.');
    }
    const handedOver = await this.tx(claims, async (tx) => {
      await tx.insert(schema.conversationControls).values({
        id: conversationId,
        tenantId: claims.tenantId,
        connectionId: inbox.connectionId,
        inboxId: inbox.id,
        brandId: claims.brandId,
        principalId: claims.principalId,
        externalConversationId: Number(conversationRef),
        ownerMode: aiOwned ? 'AI_ACTIVE' : 'WAITING_HUMAN',
        ownerBotId: aiOwned ? (runtime.primaryBot?.id ?? null) : null,
        authorityStatus: status,
        authorityUpdatedAt: version,
      });
      // The reconciler follows the conversation from its first message (webhooks can be lost).
      await tx.insert(schema.reconcileCursors).values({
        tenantId: claims.tenantId,
        connectionId: inbox.connectionId,
        scope: 'conversation',
        scopeRef: conversationRef,
        lastExternalId: 0,
        intervalSeconds: RECONCILE_MIN_SECONDS,
        nextPollAt: new Date(this.clock().getTime() + RECONCILE_MIN_SECONDS * 1000),
      });
      if (!aiOwned) return [];
      // Without a published answering agent (or with the AI stopped), people answer from the start.
      const decision = await this.agents.answering(tx, claims.brandId);
      if (decision.answering) return [];
      const result = await this.ownership.transition(
        tx,
        claims.tenantId,
        conversationId,
        { kind: 'queue' },
        {
          origin: 'hamnivo',
          reason: decision.reason,
          actor: { type: 'system', id: 'ai' },
          handoffNote: HANDOFF_NOTES[decision.reason],
        },
      );
      return result.journal;
    });
    await this.journal.notify(claims.tenantId, conversationId, handedOver);
    const publicId = toPublicId('conversation', conversationId);
    if (input.firstMessage) {
      await this.send(claims, publicId, {
        clientMessageId: input.clientMessageId ?? randomUUID(),
        parts: [{ type: 'text', text: input.firstMessage, format: 'plain' }],
        ...(input.context ? { context: input.context } : {}),
      });
    }
    return this.get(claims, publicId);
  }

  async send(
    claims: WidgetClaims,
    publicId: string,
    input: z.output<typeof SendMessageRequest>,
  ): Promise<OutboundResult> {
    if (input.parts.some((part) => part.type === 'attachment')) {
      throw new AppError('UPLOAD_REJECTED', {
        detail: 'Attachments are not available in this chat yet.',
      });
    }
    const conversationId = this.conversationId(publicId);
    const text = input.parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n\n')
      .trim();
    return this.outbound.send({
      tenantId: claims.tenantId,
      actorId: toPublicId('customer', claims.principalId),
      conversationId,
      sender: { kind: 'customer', id: claims.principalId },
      clientMessageId: input.clientMessageId,
      requestHash: sha256(
        canonicalize({ parts: input.parts, context: input.context ?? null }) ?? '',
      ),
      author: { kind: 'customer' },
      visibility: 'public',
      text,
      contentAttributes: { hv: { v: 1, ...(input.context ? { context: input.context } : {}) } },
      load: (tx) => this.own(tx, claims, conversationId),
      onCommitted: async (tx, control, ledgerId) => {
        await tx
          .update(schema.conversationControls)
          .set({ lastCustomerMessageAt: this.clock() })
          .where(eq(schema.conversationControls.id, conversationId));
        // The AI job decides: a fenced reply while the AI owns the conversation, a suggestion
        // for staff in assist mode, otherwise nothing.
        await enqueueOutbox(tx, claims.tenantId, {
          topic: 'conversation.customer_message',
          aggregateType: 'conversation',
          aggregateId: conversationId,
          payload: { conversationId, ledgerId, epoch: control.ownershipEpoch },
        });
      },
    });
  }

  async history(
    claims: WidgetClaims,
    publicId: string,
    query: { before?: string; limit: number },
  ): Promise<z.infer<typeof MessagePage>> {
    const conversationId = this.conversationId(publicId);
    const context = await this.tx(claims, async (tx) => {
      const control = await this.own(tx, claims, conversationId);
      const [contact] = await tx
        .select()
        .from(schema.authorityContacts)
        .where(
          and(
            eq(schema.authorityContacts.inboxId, control.inboxId),
            eq(schema.authorityContacts.principalId, claims.principalId),
          ),
        );
      const [inbox] = await tx
        .select({ externalInboxId: schema.authorityInboxes.externalInboxId })
        .from(schema.authorityInboxes)
        .where(eq(schema.authorityInboxes.id, control.inboxId));
      const ledger = await tx
        .select({
          clientMessageId: schema.messageLedger.clientMessageId,
          authorityMessageId: schema.messageLedger.authorityMessageId,
        })
        .from(schema.messageLedger)
        .where(
          and(
            eq(schema.messageLedger.conversationId, conversationId),
            eq(schema.messageLedger.senderId, claims.principalId),
          ),
        );
      return {
        control,
        inbox,
        sourceId: contact ? this.contacts.sourceIdOf(claims.tenantId, contact) : null,
        clientIds: new Map(
          ledger
            .filter((l) => l.authorityMessageId !== null)
            .map((l) => [String(l.authorityMessageId), l.clientMessageId]),
        ),
      };
    });
    if (!context.sourceId || !context.inbox)
      return { items: [], olderCursor: null, latestSequence: context.control.journalSeq };
    const runtime = await this.registry.get(claims.tenantId, context.control.connectionId);
    let messages: AuthorityMessage[];
    try {
      messages = await runtime.authority.listMessages(
        String(context.control.externalConversationId),
        {
          view: 'customer',
          contactSourceId: context.sourceId,
          inboxRef: String(context.inbox.externalInboxId),
        },
      );
    } catch (error) {
      throw authorityUnavailable(error, 'History could not be loaded. Please try again.');
    }
    const facts = await this.tx(claims, (tx) => publicationFacts(tx, conversationId, messages));
    const before = query.before
      ? Number(Buffer.from(query.before, 'base64url').toString('utf8'))
      : Number.POSITIVE_INFINITY;
    const visible = messages
      .filter((m) => Number(m.ref) < before)
      .sort((a, b) => Number(b.ref) - Number(a.ref));
    const page = visible.slice(0, query.limit);
    const oldest = page.at(-1);
    return {
      items: page.map((m) =>
        contractMessage({
          message: m,
          id: toPublicId('message', authorityMessageUuid(context.control.connectionId, m.ref)),
          conversationId: publicId,
          sequence: null,
          clientMessageId: context.clientIds.get(m.ref) ?? null,
          delivery: m.direction === 'incoming' ? 'accepted' : null,
          ...(facts.has(m.ref) ? { facts: facts.get(m.ref) } : {}),
        }),
      ),
      olderCursor:
        visible.length > page.length && oldest
          ? Buffer.from(oldest.ref).toString('base64url')
          : null,
      latestSequence: context.control.journalSeq,
    };
  }

  /** "Talk to a person" is always honoured, with honest availability (W11, R12). */
  async handoff(
    claims: WidgetClaims,
    publicId: string,
    input: z.output<typeof HandoffRequest>,
    locale?: string,
  ) {
    const conversationId = this.conversationId(publicId);
    const handoffId = toPublicId(
      'handoff',
      uuidV5(conversationId, `handoff:${input.clientRequestId}`),
    );
    const entries = await this.tx(claims, async (tx) => {
      const control = await this.own(tx, claims, conversationId, true);
      if (control.ownerMode !== 'AI_ACTIVE' && control.ownerMode !== 'PAUSED') return [];
      const note = input.note?.trim();
      const result = await this.ownership.transition(
        tx,
        claims.tenantId,
        conversationId,
        { kind: 'queue' },
        {
          origin: 'hamnivo',
          reason: 'customer_request',
          actor: { type: 'customer', id: toPublicId('customer', claims.principalId) },
          handoffNote: `Handoff: the customer asked for a person.${note ? ` Their note: “${note}”` : ''}`,
        },
      );
      const requested = await this.journal.append(tx, claims.tenantId, conversationId, [
        {
          lane: 'customer',
          type: 'handoff.requested',
          data: { handoffId, availability: 'queued' },
        },
      ]);
      return [...result.journal, ...requested];
    });
    await this.journal.notify(claims.tenantId, conversationId, entries);
    return {
      handoffId,
      availability: 'queued' as const,
      message: handoffMessage(locale),
      followUp: null,
    };
  }

  /** Latest journal head for a conversation the principal owns (for streams). */
  async head(claims: WidgetClaims, publicId: string): Promise<ControlRow> {
    return this.tx(claims, (tx) => this.own(tx, claims, this.conversationId(publicId)));
  }
}
