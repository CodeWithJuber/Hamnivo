import { randomUUID } from 'node:crypto';
import type {
  CustomerConversation,
  FeedbackRequest,
  FormAnswers,
  HandoffRequest,
  MessagePage,
  SendMessageRequest,
  StartConversationRequest,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  newId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import type { AuthorityMessage } from '@hamnivo/domain';
import { Inject, Injectable, Logger } from '@nestjs/common';
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
import { queueAutomationEvent } from '../automations/events.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { teamsForBrand } from '../decisions/team-routing.service.js';
import { supersedeAiDrafts } from '../inbox/ai-drafts.js';
import { AvailabilityService } from '../inbox/availability.service.js';
import { syncSla } from '../inbox/sla.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { AgentsService } from '../runtime/agents.service.js';
import { HANDOFF_NOTES } from '../runtime/handoff-notes.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { parseAppearance } from './appearance.js';
import { WidgetAttachmentsService } from './attachments.service.js';
import { assertConsent } from './consent.js';
import { AuthorityContactsService } from './contacts.service.js';
import { handoffOutcome } from './copy.js';
import { type AcceptedAnswers, acceptAnswers, answersNote } from './forms.js';
import { isStudioOrigin } from './origins.js';
import {
  advanceCustomerRead,
  markCustomerSeenSynced,
  staffSeenAt,
  unreadCounts,
} from './read-state.js';
import { brandSurface } from './settings.service.js';
import { sha256, type WidgetClaims } from './tokens.service.js';
import { customerConversation, lastPreview, principalConversations, ticketFacts } from './views.js';

/**
 * The customer side of a conversation (W05–W07, W12): start, send (exactly once through the
 * message ledger), history from the authority's customer view, and "talk to a person".
 */
@Injectable()
export class WidgetConversationsService {
  private readonly logger = new Logger(WidgetConversationsService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly registry: AuthorityRegistry,
    private readonly contacts: AuthorityContactsService,
    private readonly journal: JournalService,
    private readonly ownership: OwnershipService,
    private readonly outbound: OutboundMessagesService,
    private readonly agents: AgentsService,
    private readonly entitlements: EntitlementsService,
    private readonly attachments: WidgetAttachmentsService,
    private readonly availability: AvailabilityService,
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
      const unread = await unreadCounts(tx, [control.id]);
      const tickets = await ticketFacts(tx, [control.id]);
      return customerConversation(
        control,
        await lastPreview(tx, control.id),
        unread.get(control.id) ?? 0,
        tickets.get(control.id),
      );
    });
  }

  async start(
    claims: WidgetClaims,
    input: z.output<typeof StartConversationRequest>,
    /** The request's country (CF-IPCountry), only to decide whether consent is asked (W27). */
    country: string | null = null,
  ): Promise<CustomerConversation> {
    const opened = await this.open(claims, {
      country,
      form: 'prechat',
      answers: input.prechat ?? {},
      aiFirst: true,
    });
    const publicId = toPublicId('conversation', opened.conversationId);
    // Without a typed message, the pre-chat form's question is what the customer asked (W26).
    const firstMessage = input.firstMessage ?? opened.accepted?.question ?? undefined;
    if (firstMessage) {
      await this.send(claims, publicId, {
        clientMessageId: input.clientMessageId ?? randomUUID(),
        parts: [{ type: 'text', text: firstMessage, format: 'plain' }],
        ...(input.context ? { context: input.context } : {}),
      });
    }
    return this.get(claims, publicId);
  }

  /**
   * Opens a conversation for the customer: consent first where the brand asks for it (W27), the
   * form's answers checked (W26 before a chat, W11 for the contact form), then the conversation in
   * the authority and Hamnivo's record of it. A department answer sets the team, and staff get a
   * private note with the answers. `aiFirst: false` hands the conversation to people at once.
   */
  async open(
    claims: WidgetClaims,
    options: {
      country: string | null;
      form: 'prechat' | 'offline';
      answers: FormAnswers;
      aiFirst: boolean;
      /** Runs in the transaction that records the conversation (the contact form's ticket). */
      onRecorded?: (
        tx: TenantTx,
        conversationId: string,
        accepted: AcceptedAnswers | null,
      ) => Promise<void>;
    },
  ): Promise<{ conversationId: string; accepted: AcceptedAnswers | null }> {
    // The plan's conversations for the period (A08): checked before anything is opened.
    await this.entitlements.assertCanStartConversation(claims.tenantId);
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
      let [principal] = await tx
        .select()
        .from(schema.customerPrincipals)
        .where(eq(schema.customerPrincipals.id, claims.principalId));
      const surface = await brandSurface(tx, claims.brandId);
      await assertConsent(tx, surface, claims.principalId, options.country);
      const form = options.form === 'prechat' ? surface.forms.prechat : surface.forms.offline;
      const asked =
        options.form === 'offline' ||
        (form.enabled && !(surface.forms.prechat.skipVerified && principal?.kind === 'verified'));
      const accepted = asked
        ? acceptAnswers(
            form.fields,
            options.answers,
            options.form === 'prechat' ? 'prechat' : 'answers',
          )
        : null;
      // A name typed by an anonymous visitor names them for staff; a signed-in customer keeps
      // the name their website gave.
      if (
        principal &&
        accepted?.name &&
        (principal.kind === 'anonymous' || !principal.displayName)
      ) {
        [principal] = await tx
          .update(schema.customerPrincipals)
          .set({ displayName: accepted.name })
          .where(eq(schema.customerPrincipals.id, principal.id))
          .returning();
      }
      const teamId = accepted?.teamId
        ? await this.chosenTeam(tx, claims.brandId, accepted.teamId)
        : null;
      return { inbox, principal, accepted, teamId };
    });
    if (!setup.inbox || !setup.principal) {
      throw new AppError('AUTHORITY_UNAVAILABLE', {
        detail: 'Chat is not set up for this website yet.',
        retryable: false,
      });
    }
    const { inbox, accepted } = setup;
    const runtime = await this.registry.get(claims.tenantId, inbox.connectionId);
    const conversationId = newId();
    let conversationRef: string;
    let contactRef: string | null = null;
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
        contactRef = state.contactRef;
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw authorityUnavailable(error, 'The chat could not be started. Please try again.');
    }
    // The answers go on the contact too, for staff working in Chatwoot; a failure here loses
    // nothing, since the note below carries the same answers.
    if (accepted && contactRef && (accepted.name || Object.keys(accepted.attributes).length > 0)) {
      await runtime.authority
        .updateContact(contactRef, {
          ...(accepted.name ? { name: accepted.name } : {}),
          attributes: accepted.attributes,
        })
        .catch((error: unknown) =>
          this.logger.warn(`form answers not added to the contact: ${String(error)}`),
        );
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
      // A chat the owner opened from Studio to try the widget is a test: reports and counts skip it.
      const [session] = await tx
        .select({ hostOrigin: schema.widgetSessions.hostOrigin })
        .from(schema.widgetSessions)
        .where(eq(schema.widgetSessions.id, claims.sessionId));
      if (isStudioOrigin(this.config.PUBLIC_CONSOLE_ORIGIN, session?.hostOrigin)) {
        await tx.insert(schema.testConversations).values({
          tenantId: claims.tenantId,
          conversationId,
          brandId: claims.brandId,
        });
      }
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
      if (setup.teamId) await this.chooseTeam(tx, claims, conversationId, setup.teamId);
      const note = accepted
        ? answersNote(
            options.form === 'prechat'
              ? 'Before the chat, the customer answered:'
              : 'The customer left a message with the contact form while nobody could answer:',
            accepted,
          )
        : null;
      if (note) {
        await enqueueOutbox(tx, claims.tenantId, {
          topic: 'conversation.note',
          aggregateType: 'conversation',
          aggregateId: conversationId,
          payload: {
            conversationId,
            key: `hv1:n:${uuidV5(conversationId, `form:${options.form}`)}`,
            text: note,
          },
        });
      }
      await options.onRecorded?.(tx, conversationId, accepted);
      if (!aiOwned) return [];
      // Without a published answering agent (or with the AI stopped), people answer from the start.
      const decision = await this.agents.answering(tx, claims.brandId);
      if (decision.answering && options.aiFirst) return [];
      const result = await this.ownership.transition(
        tx,
        claims.tenantId,
        conversationId,
        { kind: 'queue' },
        decision.answering
          ? {
              origin: 'hamnivo',
              reason: 'customer_request',
              actor: { type: 'customer', id: toPublicId('customer', claims.principalId) },
              handoffNote:
                'The customer left a message with the contact form while nobody could answer. Reply here; they get an email once they confirm their address.',
            }
          : {
              origin: 'hamnivo',
              reason: decision.reason,
              actor: { type: 'system', id: 'ai' },
              handoffNote: HANDOFF_NOTES[decision.reason],
            },
      );
      return result.journal;
    });
    await this.journal.notify(claims.tenantId, conversationId, handedOver);
    return { conversationId, accepted };
  }

  /** The team a department answer leads to, while it can still take the brand's chats. */
  private async chosenTeam(tx: TenantTx, brandId: string, teamPublicId: string) {
    let teamId: string;
    try {
      teamId = fromPublicId('team', teamPublicId);
    } catch {
      return null;
    }
    const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
    if (!brand) return null;
    const teams = await teamsForBrand(tx, brand);
    return teams.some((row) => row.team.id === teamId) ? teamId : null;
  }

  /**
   * The customer chose a department (W26): the conversation goes to that team through the inbox's
   * own path, and routing leaves a team it did not choose alone.
   */
  private async chooseTeam(
    tx: TenantTx,
    claims: WidgetClaims,
    conversationId: string,
    teamId: string,
  ): Promise<void> {
    await tx
      .insert(schema.conversationInboxState)
      .values({ tenantId: claims.tenantId, conversationId, teamId })
      .onConflictDoUpdate({
        target: [
          schema.conversationInboxState.tenantId,
          schema.conversationInboxState.conversationId,
        ],
        set: { teamId, updatedAt: this.clock() },
      });
    await enqueueOutbox(tx, claims.tenantId, {
      topic: 'conversation.team_changed',
      aggregateType: 'conversation',
      aggregateId: conversationId,
      payload: { conversationId, teamId, actorStaffMemberId: null },
    });
    await appendAudit(tx, {
      actorType: 'customer',
      actorId: toPublicId('customer', claims.principalId),
      action: 'conversation.routed',
      targetType: 'conversation',
      targetId: toPublicId('conversation', conversationId),
      outcome: 'success',
      data: { from: null, team: toPublicId('team', teamId), source: 'customer_choice' },
    });
  }

  async send(
    claims: WidgetClaims,
    publicId: string,
    input: z.output<typeof SendMessageRequest>,
    /** What the first message starts for the brand's automations: a chat, or a contact form message. */
    start: 'chat_started' | 'offline_message' = 'chat_started',
  ): Promise<OutboundResult> {
    const conversationId = this.conversationId(publicId);
    const text = input.parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n\n')
      .trim();
    // Files are claimed for this message with the ledger reservation (W09): scanned, still in
    // quarantine, sent only with it. A retry with the same message id may claim them again.
    const uploadIds = input.parts.flatMap((part) =>
      part.type === 'attachment' ? [part.uploadId] : [],
    );
    let files: Awaited<ReturnType<WidgetAttachmentsService['reserve']>> | null = null;
    const result = await this.outbound.send({
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
      attachments: () => files?.files ?? [],
      load: async (tx) => {
        const control = await this.own(tx, claims, conversationId);
        if (uploadIds.length > 0) {
          files = await this.attachments.reserve(
            tx,
            claims,
            conversationId,
            uploadIds,
            input.clientMessageId,
          );
        }
        return control;
      },
      onCommitted: async (tx, control, ledgerId) => {
        await tx
          .update(schema.conversationControls)
          .set({ lastCustomerMessageAt: this.clock() })
          .where(eq(schema.conversationControls.id, conversationId));
        // A customer waiting for a person starts or continues the reply-time clock (H12).
        await syncSla(tx, claims.tenantId, conversationId, this.clock());
        // A pending AI draft answered what they said before (HNV-09-05).
        await supersedeAiDrafts(tx, conversationId, 'customer_wrote', this.clock());
        // The AI job decides: a fenced reply while the AI owns the conversation, a suggestion
        // for staff in assist mode, otherwise nothing.
        await enqueueOutbox(tx, claims.tenantId, {
          topic: 'conversation.customer_message',
          aggregateType: 'conversation',
          aggregateId: conversationId,
          payload: { conversationId, ledgerId, epoch: control.ownershipEpoch },
        });
        // A new conversation is routed to a team once the customer's first words are in (J02).
        if (control.lastCustomerMessageAt === null) {
          await enqueueOutbox(tx, claims.tenantId, {
            topic: 'conversation.route',
            aggregateType: 'conversation',
            aggregateId: conversationId,
            payload: { conversationId, trigger: 'new_conversation', ref: `new:${ledgerId}` },
          });
          await queueAutomationEvent(tx, claims.tenantId, control.brandId, {
            conversationId,
            event: start,
            ref: `message:${ledgerId}`,
          });
        }
        // Each message starts the clock again for the brand's "waiting for a reply" rules (G21).
        await queueAutomationEvent(tx, claims.tenantId, control.brandId, {
          conversationId,
          event: 'customer_message',
          ref: `message:${ledgerId}`,
          ledgerId,
        });
      },
    });
    const claimed = files as Awaited<ReturnType<WidgetAttachmentsService['reserve']>> | null;
    if (claimed?.ids.length) await this.attachments.markSent(claims, claimed.ids);
    return result;
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
        staffSeenAt: await staffSeenAt(tx, conversationId),
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
    if (Number.isNaN(before)) {
      throw new AppError('VALIDATION_FAILED', { detail: 'Unknown history cursor.' });
    }
    // Read only where the authority reported staff saw the conversation after the message (W06).
    const seen = context.staffSeenAt?.getTime() ?? null;
    const deliveryOf = (m: AuthorityMessage) =>
      m.direction !== 'incoming'
        ? null
        : seen !== null && m.createdAt.getTime() < seen
          ? ('read' as const)
          : ('accepted' as const);
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
          delivery: deliveryOf(m),
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
    const now = this.clock();
    let outcome = handoffOutcome(undefined, locale, now);
    const entries = await this.tx(claims, async (tx) => {
      const control = await this.own(tx, claims, conversationId, true);
      const [brand] = control.brandId
        ? await tx.select().from(schema.brands).where(eq(schema.brands.id, control.brandId))
        : [];
      const [look] = brand
        ? await tx
            .select({ appearance: schema.brandAppearance.appearance })
            .from(schema.brandAppearance)
            .where(eq(schema.brandAppearance.brandId, brand.id))
        : [];
      // A person is "available" only when someone who can answer this brand is online right now.
      const staffOnline =
        brand !== undefined &&
        (await this.availability.anyOnline(tx, claims.tenantId, {
          workspaceId: brand.workspaceId,
          brandId: brand.id,
        }));
      outcome = handoffOutcome(
        brand,
        locale,
        now,
        parseAppearance(look?.appearance).offlineText,
        staffOnline,
      );
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
          data: { handoffId, availability: outcome.availability },
        },
      ]);
      return [...result.journal, ...requested];
    });
    await this.journal.notify(claims.tenantId, conversationId, entries);
    return { handoffId, ...outcome };
  }

  /**
   * Reopens a resolved conversation without writing (W15). Chatwoot's own rule applies: pending
   * with the bot when the AI owned it, otherwise open for people. An AI that may no longer answer
   * (agent unpublished, AI stopped) hands the conversation to people.
   */
  async reopen(claims: WidgetClaims, publicId: string): Promise<CustomerConversation> {
    const conversationId = this.conversationId(publicId);
    const before = await this.tx(claims, (tx) => this.own(tx, claims, conversationId));
    if (before.authorityStatus !== 'resolved') return this.get(claims, publicId);
    const runtime = await this.registry.get(claims.tenantId, before.connectionId);
    const status = before.ownerMode === 'AI_ACTIVE' && runtime.primaryBot ? 'pending' : 'open';
    try {
      await runtime.authority.setStatus(String(before.externalConversationId), status, {
        kind: 'integration',
      });
    } catch (error) {
      throw authorityUnavailable(
        error,
        'The conversation could not be reopened. Please try again.',
      );
    }
    const entries = await this.tx(claims, async (tx) => {
      const control = await this.own(tx, claims, conversationId, true);
      if (control.authorityStatus !== 'resolved') return [];
      await tx
        .update(schema.conversationControls)
        .set({ authorityStatus: status, updatedAt: this.clock() })
        .where(eq(schema.conversationControls.id, conversationId));
      const out = await this.journal.append(tx, claims.tenantId, conversationId, [
        { lane: 'customer', type: 'conversation.reopened', data: {} },
      ]);
      if (control.ownerMode === 'AI_ACTIVE' && control.brandId) {
        const decision = await this.agents.answering(tx, control.brandId);
        if (!decision.answering) {
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
          out.push(...result.journal);
        }
      }
      return out;
    });
    await this.journal.notify(claims.tenantId, conversationId, entries);
    return this.get(claims, publicId);
  }

  /**
   * Stores the customer's rating of a resolved conversation (W15); a new rating replaces the
   * previous one. Staff see it as a private note in the conversation.
   */
  async feedback(
    claims: WidgetClaims,
    publicId: string,
    input: z.output<typeof FeedbackRequest>,
  ): Promise<void> {
    const conversationId = this.conversationId(publicId);
    await this.tx(claims, async (tx) => {
      const control = await this.own(tx, claims, conversationId);
      if (control.authorityStatus !== 'resolved') {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'A conversation can be rated once it is resolved.',
        });
      }
      const comment = input.comment?.trim() || null;
      const now = this.clock();
      await tx
        .insert(schema.conversationFeedback)
        .values({
          tenantId: claims.tenantId,
          conversationId,
          principalId: claims.principalId,
          rating: input.rating,
          comment,
        })
        .onConflictDoUpdate({
          target: [
            schema.conversationFeedback.tenantId,
            schema.conversationFeedback.conversationId,
            schema.conversationFeedback.principalId,
          ],
          set: { rating: input.rating, comment, updatedAt: now },
        });
      await enqueueOutbox(tx, claims.tenantId, {
        topic: 'conversation.note',
        aggregateType: 'conversation',
        aggregateId: conversationId,
        payload: {
          conversationId,
          key: `hv1:n:${uuidV5(conversationId, `feedback:${claims.principalId}:${now.getTime()}`)}`,
          text: `Customer rating: ${input.rating} out of 5.${comment ? ` Comment: “${comment}”` : ''}`,
        },
      });
    });
  }

  /**
   * The customer saw the conversation up to a sequence (W05, W06): unread counts drop, and
   * Chatwoot is told the contact saw it (at most every 15 seconds), so staff see their replies
   * as read there. Telling Chatwoot is best effort; the read point is kept either way.
   */
  async markRead(claims: WidgetClaims, publicId: string, upToSequence: number): Promise<void> {
    const conversationId = this.conversationId(publicId);
    const now = this.clock();
    const due = await this.tx(claims, async (tx) => {
      const control = await this.own(tx, claims, conversationId);
      const result = await advanceCustomerRead(tx, control, claims.principalId, upToSequence, now);
      const recent = result.syncedAt && now.getTime() - result.syncedAt.getTime() < 15_000;
      if (!result.advanced || recent) return null;
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
      if (!contact || !inbox) return null;
      await markCustomerSeenSynced(tx, conversationId, now);
      return {
        control,
        sourceId: this.contacts.sourceIdOf(claims.tenantId, contact),
        inboxRef: String(inbox.externalInboxId),
      };
    });
    if (!due) return;
    try {
      const runtime = await this.registry.get(claims.tenantId, due.control.connectionId);
      await runtime.authority.markSeenByContact(String(due.control.externalConversationId), {
        contactSourceId: due.sourceId,
        inboxRef: due.inboxRef,
      });
    } catch (error) {
      this.logger.warn(`could not tell the authority the customer saw ${publicId}: ${error}`);
    }
  }

  /** Latest journal head for a conversation the principal owns (for streams). */
  async head(claims: WidgetClaims, publicId: string): Promise<ControlRow> {
    return this.tx(claims, (tx) => this.own(tx, claims, this.conversationId(publicId)));
  }
}
