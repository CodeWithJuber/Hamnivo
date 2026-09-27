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
import { and, eq, inArray } from 'drizzle-orm';
import { type JournalEntry, JournalService } from '../authority/journal.service.js';
import { type ControlRow, OwnershipService } from '../authority/ownership.service.js';
import { AuthorityRegistry } from '../authority/registry.js';
import { authorityMessageUuid, uuidV5 } from '../authority/uuid.js';
import { contractMessage } from '../authority/views.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { type CardPublication, cardKey } from './cards.js';
import { canonicalDigest } from './common.js';

export const CARD_TOPIC = 'commerce.card';
/** A post claimed this recently is assumed to be still in flight. */
const IN_FLIGHT_MS = 30_000;

interface CardDetail {
  kind: 'card';
  card: CardPublication['ref'];
  part: CardPublication['part'];
  senderName: string;
  reason?: string;
}

/**
 * Records a card post that Chatwoot confirmed (webhook or reconciler seeing the message first).
 * Card posts are publications under an `hv1:c:` key: system records, never judged as late AI
 * replies, since they only show what the customer or staff asked for.
 */
export async function confirmCardPublication(
  tx: TenantTx,
  key: string,
  message: Pick<AuthorityMessage, 'ref'>,
  now: Date,
): Promise<void> {
  const authorityId = Number(message.ref);
  if (!Number.isSafeInteger(authorityId)) return;
  await tx
    .update(schema.publications)
    .set({ state: 'sent', authorityMessageId: authorityId, sentAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.publications.sourceKey, key),
        inArray(schema.publications.state, ['reserved', 'unknown']),
      ),
    );
}

/**
 * Posts commerce cards into the conversation as the brand's Hamnivo bot (Chatwoot stays the
 * conversation authority). A card is reserved in the same transaction as the record it shows and
 * relayed through the outbox, so it is posted at least once and shown exactly once.
 */
@Injectable()
export class CommerceCardsService {
  private readonly logger = new Logger(CommerceCardsService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: AuthorityRegistry,
    private readonly journal: JournalService,
    private readonly ownership: OwnershipService,
  ) {}

  /** Reserves a card post; `occasion` makes the key unique per record and moment. */
  async enqueue(
    tx: TenantTx,
    tenantId: string,
    control: Pick<ControlRow, 'id' | 'ownershipEpoch'>,
    publication: CardPublication,
    occasion: string,
  ): Promise<string> {
    const sourceKey = cardKey(uuidV5(control.id, `card:${occasion}`));
    const detail: CardDetail = {
      kind: 'card',
      card: publication.ref,
      part: publication.part,
      senderName: publication.senderName,
    };
    const [inserted] = await tx
      .insert(schema.publications)
      .values({
        tenantId,
        conversationId: control.id,
        epoch: control.ownershipEpoch,
        state: 'reserved',
        sourceKey,
        contentHash: canonicalDigest(publication.part),
        detail,
      })
      .onConflictDoNothing()
      .returning({ id: schema.publications.id });
    if (inserted) {
      await enqueueOutbox(tx, tenantId, {
        topic: CARD_TOPIC,
        aggregateType: 'conversation',
        aggregateId: control.id,
        payload: { conversationId: control.id, sourceKey },
      });
    }
    return sourceKey;
  }

  /** Outbox handler for `commerce.card`. Safe to run more than once. */
  async onCardEvent(event: ClaimedOutboxEvent): Promise<void> {
    const payload = event.payload as { sourceKey: string };
    await this.publish(event.tenantId, payload.sourceKey, event.attempts);
  }

  /** Posts a reserved card now (also used right after the request that created it). */
  async publish(tenantId: string, sourceKey: string, attempt = 1): Promise<void> {
    const now = this.clock();
    const loaded = await withTenant(this.db, { tenantId, actorId: 'commerce' }, async (tx) => {
      const [publication] = await tx
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.sourceKey, sourceKey))
        .for('update');
      if (!publication) return null;
      const [control] = await tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, publication.conversationId));
      if (!control) return null;
      if (publication.state === 'sent' || publication.state === 'aborted') {
        return { publication, control, claim: 'done' as const };
      }
      // Another process is posting it right now: let the outbox come back later instead of
      // posting a second copy.
      if (
        publication.state === 'unknown' &&
        now.getTime() - publication.updatedAt.getTime() < IN_FLIGHT_MS
      ) {
        return { publication, control, claim: 'busy' as const };
      }
      await tx
        .update(schema.publications)
        .set({ state: 'unknown', updatedAt: now })
        .where(eq(schema.publications.id, publication.id));
      return {
        publication,
        control,
        claim:
          publication.state === 'reserved' && attempt <= 1
            ? ('fresh' as const)
            : ('retry' as const),
      };
    });
    if (!loaded || loaded.claim === 'done') return;
    if (loaded.claim === 'busy') throw new Error(`card ${sourceKey} is being posted`);
    const { publication, control } = loaded;
    const detail = publication.detail as CardDetail;
    const runtime = await this.registry.get(tenantId, control.connectionId);
    const bot = runtime.primaryBot ?? runtime.bots[0];
    if (!bot) {
      await this.setState(tenantId, sourceKey, 'aborted', { ...detail, reason: 'no_bot' });
      this.logger.warn(`card ${sourceKey} not posted: no bot on the connection`);
      return;
    }
    const ref = String(control.externalConversationId);
    let posted: AuthorityMessage | null = null;
    if (loaded.claim === 'retry') {
      posted = await runtime.authority
        .findByKey(ref, sourceKey, publication.createdAt)
        .catch(() => null);
    }
    if (!posted) {
      try {
        ({ message: posted } = await runtime.authority.appendMessage({
          conversationRef: ref,
          key: sourceKey,
          author: { kind: 'bot', botRef: String(bot.externalBotId) },
          visibility: 'public',
          text: detail.part.fallbackText,
          contentAttributes: { hv: { v: 1, card: detail.card } },
        }));
      } catch (error) {
        await this.setState(tenantId, sourceKey, 'unknown');
        throw error;
      }
    }
    const message = posted;
    const entries: JournalEntry[] = await withTenant(
      this.db,
      { tenantId, actorId: 'commerce' },
      async (tx) => {
        await this.ownership.lock(tx, control.id);
        await confirmCardPublication(tx, sourceKey, message, this.clock());
        const authorityId = Number(message.ref);
        if (await this.journal.hasMessage(tx, control.id, 'customer', authorityId)) return [];
        return this.journal.append(tx, tenantId, control.id, [
          {
            lane: 'customer',
            type: 'message.created',
            data: {
              message: contractMessage({
                message,
                id: toPublicId('message', authorityMessageUuid(runtime.connectionId, message.ref)),
                conversationId: toPublicId('conversation', control.id),
                sequence: null,
                clientMessageId: null,
                delivery: null,
                facts: {
                  sources: [],
                  card: { part: detail.part, senderName: detail.senderName },
                },
              }),
            },
            authorityCreatedAt: message.createdAt,
            authorityId,
          },
        ]);
      },
    );
    await this.journal.notify(tenantId, control.id, entries);
  }

  private async setState(
    tenantId: string,
    sourceKey: string,
    state: 'unknown' | 'aborted',
    detail?: CardDetail,
  ) {
    // A failed post is no longer in flight: the next attempt may look it up and post again.
    const updatedAt =
      state === 'unknown' ? new Date(this.clock().getTime() - IN_FLIGHT_MS) : this.clock();
    await withTenant(this.db, { tenantId, actorId: 'commerce' }, (tx) =>
      tx
        .update(schema.publications)
        .set({ state, updatedAt, ...(detail ? { detail } : {}) })
        .where(
          and(
            eq(schema.publications.sourceKey, sourceKey),
            inArray(schema.publications.state, ['reserved', 'unknown']),
          ),
        ),
    );
  }
}
