import { createHash } from 'node:crypto';
import {
  type ClaimedOutboxEvent,
  type Db,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import type { AuthorityMessage } from '@hamnivo/domain';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import { and, eq } from 'drizzle-orm';
import { type JournalEntry, JournalService } from '../authority/journal.service.js';
import { type ControlRow, OwnershipService } from '../authority/ownership.service.js';
import { AuthorityRegistry, type ConnectionRuntime } from '../authority/registry.js';
import { authorityMessageUuid, uuidV5 } from '../authority/uuid.js';
import { contractMessage } from '../authority/views.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';

export const LANGUAGE_MODEL = Symbol('LANGUAGE_MODEL');

interface CustomerMessageEvent {
  conversationId: string;
  ledgerId: string;
  epoch: number;
}

const HISTORY = 20;

/** Why a reply was not published, recorded on the publication for review. */
type AbortReason = 'owner_changed' | 'preflight_owner_mismatch' | 'not_ai_owned';

/**
 * AI replies with fenced publication (ADR 0003, R05/R06). The reply is generated outside any lock,
 * then reserved under the ownership epoch the customer message arrived in. A pre-flight check
 * confirms Chatwoot still shows the Hamnivo bot as owner, and the message is posted with its
 * publication key. A takeover at any point before the post makes the reply unpublishable.
 */
@Injectable()
export class RepliesService {
  private readonly logger = new Logger(RepliesService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LANGUAGE_MODEL) private readonly model: LanguageModel,
    private readonly registry: AuthorityRegistry,
    private readonly journal: JournalService,
    private readonly ownership: OwnershipService,
  ) {}

  private tx<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(this.db, { tenantId, actorId: 'ai' }, work);
  }

  private fenced(control: ControlRow, epoch: number): AbortReason | null {
    if (control.ownerMode !== 'AI_ACTIVE') return 'not_ai_owned';
    if (control.ownershipEpoch !== epoch || control.ownerSyncedEpoch !== control.ownershipEpoch)
      return 'owner_changed';
    return null;
  }

  private prompt(history: AuthorityMessage[]): ModelMessage[] {
    return history
      .filter(
        (m) => !m.private && (m.direction === 'incoming' || m.direction === 'outgoing') && m.text,
      )
      .slice(-HISTORY)
      .map((m) =>
        m.direction === 'incoming'
          ? ({ role: 'user', content: m.text as string } as const)
          : ({ role: 'assistant', content: m.text as string } as const),
      );
  }

  /** Outbox handler for `conversation.customer_message`. Safe to run more than once. */
  async onCustomerMessage(event: ClaimedOutboxEvent): Promise<void> {
    const payload = event.payload as CustomerMessageEvent;
    const tenantId = event.tenantId;
    const sourceKey = `hv1:p:${uuidV5(payload.conversationId, `reply:${payload.ledgerId}`)}`;
    const start = await this.tx(tenantId, async (tx) => {
      const [control] = await tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, payload.conversationId));
      const [publication] = await tx
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.sourceKey, sourceKey));
      return { control, publication };
    });
    if (!start.control) return;
    if (
      start.publication &&
      start.publication.state !== 'reserved' &&
      start.publication.state !== 'unknown'
    )
      return;
    const runtime = await this.registry.get(tenantId, start.control.connectionId);
    const ref = String(start.control.externalConversationId);
    const bot = runtime.bots.find((b) => b.id === start.control?.ownerBotId) ?? runtime.primaryBot;
    if (!bot) return;

    // An earlier attempt may already have posted this reply.
    if (start.publication) {
      const posted = await runtime.authority.findByKey(ref, sourceKey, start.publication.createdAt);
      if (posted) {
        await this.record(tenantId, runtime, payload.conversationId, sourceKey, posted);
        return;
      }
    }
    if (this.fenced(start.control, payload.epoch)) return;

    const history = await runtime.authority.listMessages(ref, { view: 'staff' });
    const { text } = await generateText({
      model: this.model,
      system:
        'You are the AI assistant of this business. Be kind and brief, say plainly that you are an AI, ' +
        'never claim facts you do not have, and offer a person whenever the customer asks.',
      messages: this.prompt(history),
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(30_000),
    });
    const reply = text.trim();
    if (!reply) return;

    const contentHash = createHash('sha256').update(reply).digest();
    const reserved = await this.tx(tenantId, async (tx) => {
      const control = await this.ownership.lock(tx, payload.conversationId);
      const reason = this.fenced(control, payload.epoch);
      const [publication] = await tx
        .insert(schema.publications)
        .values({
          tenantId,
          conversationId: control.id,
          epoch: payload.epoch,
          sourceKey,
          contentHash,
          state: reason ? 'aborted' : 'reserved',
          detail: reason ? { reason, currentEpoch: control.ownershipEpoch } : {},
        })
        .onConflictDoUpdate({
          target: schema.publications.sourceKey,
          set: reason
            ? {
                state: 'aborted',
                detail: { reason, currentEpoch: control.ownershipEpoch },
                updatedAt: this.clock(),
              }
            : { updatedAt: this.clock() },
        })
        .returning();
      return { publication, reason };
    });
    if (reserved.reason || !reserved.publication) {
      this.logger.log(
        `reply for ${payload.conversationId} not published: ${reserved.reason ?? 'no publication'}`,
      );
      return;
    }

    // Pre-flight: Chatwoot must still show the Hamnivo bot as the conversation's owner.
    const state = await runtime.authority.getState(ref);
    if (state.owner.kind !== 'bot' || state.owner.botRef !== String(bot.externalBotId)) {
      await this.abort(tenantId, sourceKey, 'preflight_owner_mismatch', {
        authorityOwner: state.owner,
      });
      return;
    }
    let posted: AuthorityMessage;
    try {
      ({ message: posted } = await runtime.authority.appendMessage({
        conversationRef: ref,
        key: sourceKey,
        author: { kind: 'bot', botRef: String(bot.externalBotId) },
        visibility: 'public',
        text: reply,
      }));
    } catch (error) {
      await this.tx(tenantId, (tx) =>
        tx
          .update(schema.publications)
          .set({ state: 'unknown', updatedAt: this.clock() })
          .where(eq(schema.publications.sourceKey, sourceKey)),
      );
      throw error;
    }
    await this.record(tenantId, runtime, payload.conversationId, sourceKey, posted);
  }

  private async abort(
    tenantId: string,
    sourceKey: string,
    reason: AbortReason,
    detail: Record<string, unknown>,
  ) {
    await this.tx(tenantId, (tx) =>
      tx
        .update(schema.publications)
        .set({ state: 'aborted', detail: { reason, ...detail }, updatedAt: this.clock() })
        .where(
          and(
            eq(schema.publications.sourceKey, sourceKey),
            eq(schema.publications.state, 'reserved'),
          ),
        ),
    );
    this.logger.log(`publication ${sourceKey} aborted: ${reason}`);
  }

  private async record(
    tenantId: string,
    runtime: ConnectionRuntime,
    conversationId: string,
    sourceKey: string,
    posted: AuthorityMessage,
  ): Promise<void> {
    const authorityId = Number(posted.ref);
    const entries: JournalEntry[] = await this.tx(tenantId, async (tx) => {
      await this.ownership.lock(tx, conversationId);
      await tx
        .update(schema.publications)
        .set({
          state: 'sent',
          authorityMessageId: authorityId,
          sentAt: this.clock(),
          updatedAt: this.clock(),
        })
        .where(eq(schema.publications.sourceKey, sourceKey));
      if (await this.journal.hasMessage(tx, conversationId, 'customer', authorityId)) return [];
      return this.journal.append(tx, tenantId, conversationId, [
        {
          lane: 'customer',
          type: 'message.created',
          data: {
            message: contractMessage({
              message: posted,
              id: toPublicId('message', authorityMessageUuid(runtime.connectionId, posted.ref)),
              conversationId: toPublicId('conversation', conversationId),
              sequence: null,
              clientMessageId: null,
              delivery: null,
            }),
          },
          authorityCreatedAt: posted.createdAt,
          authorityId,
        },
      ]);
    });
    await this.journal.notify(tenantId, conversationId, entries);
  }
}
