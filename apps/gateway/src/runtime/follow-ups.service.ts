import type { Message, MessagePart } from '@hamnivo/contracts';
import { type ClaimedOutboxEvent, type Db, schema, type TenantTx, withTenant } from '@hamnivo/db';
import { FOLLOW_UPS_MARKER, followUpsOf } from '@hamnivo/domain';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { generateText } from 'ai';
import { and, desc, eq, lte } from 'drizzle-orm';
import { JournalService } from '../authority/journal.service.js';
import { reservationSize } from '../billing/ai-credits.service.js';
import type { AppConfig } from '../config.js';
import { APP_DB, CONFIG } from '../tokens.js';
import { brandSurface } from '../widget/settings.service.js';
import { AgentsService } from './agents.service.js';
import { ModelFactory } from './models.js';

/** After an AI answer is published: questions the customer might ask next (see FollowUpsService). */
export const FOLLOW_UPS_TOPIC = 'reply.follow_ups';

export interface FollowUpsEvent {
  conversationId: string;
  /** The publication of the answer. */
  sourceKey: string;
  runId: string;
  /** The answer's message in the authority. */
  authorityId: number;
}

/** The model has this long; a slow suggestion is no suggestion. */
const TIMEOUT_MS = 10_000;
const MAX_OUTPUT_TOKENS = 120;

const INSTRUCTIONS = `${FOLLOW_UPS_MARKER}
A support assistant just answered a customer. Suggest up to three short questions the customer
might ask next, in the language of the answer. One question per line, at most eight words each,
written as the customer would ask them. Only questions about what this conversation is about.
No numbering, no quotes, nothing else. If no question fits, write nothing.`;

/**
 * Questions a customer might ask next, under the newest AI answer (chips in the chat). Written by
 * the agent's own model after the answer is published, so the answer's own path is untouched:
 * this costs a few metered tokens and changes nothing that was said. It is skipped when the
 * brand switched it off, when people have the conversation, and when the customer already wrote
 * again (the next answer gets its own). The questions are a part of the answer's message
 * (`suggestions`), journaled as `message.updated`; nothing else of the message changes.
 */
@Injectable()
export class FollowUpsService {
  private readonly logger = new Logger(FollowUpsService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly journal: JournalService,
    private readonly agents: AgentsService,
    private readonly models: ModelFactory,
  ) {}

  private tx<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(this.db, { tenantId, actorId: 'ai' }, work);
  }

  async onFollowUps(event: ClaimedOutboxEvent): Promise<void> {
    if (!this.config.AI_FOLLOW_UPS) return;
    const tenantId = event.tenantId;
    const payload = event.payload as FollowUpsEvent;
    const found = await this.tx(tenantId, async (tx) => {
      const [control] = await tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, payload.conversationId));
      const [publication] = await tx
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.sourceKey, payload.sourceKey));
      if (!control?.brandId || publication?.state !== 'sent') return null;
      if ((publication.detail as { followUps?: unknown }).followUps) return null;
      if (control.ownerMode !== 'AI_ACTIVE') return null;
      // The customer wrote again: the answer to that will have its own.
      const sentAt = publication.sentAt ?? publication.updatedAt;
      if (control.lastCustomerMessageAt && control.lastCustomerMessageAt > sentAt) return null;
      const surface = await brandSurface(tx, control.brandId);
      if (surface.settings.help.followUps === false) return null;
      const agent = await this.agents.activeFor(tx, control.brandId);
      if (agent?.config.mode !== 'answer') return null;
      const turn = await this.lastTurn(tx, payload.conversationId, payload.authorityId);
      if (!turn) return null;
      return { agent, publication, turn };
    });
    if (!found) return;
    const { agent, turn } = found;
    const prompt = `Customer: ${turn.question}\n\nAnswer: ${turn.answer}`.slice(0, 4000);
    let text: string;
    try {
      ({ text } = await this.models.executeAttempt(
        tenantId,
        agent.config.model,
        {
          key: `run:${payload.runId}:follow_ups`,
          reserveTokens: reservationSize(INSTRUCTIONS, [prompt], MAX_OUTPUT_TOKENS, 1),
          timeoutMs: TIMEOUT_MS,
          attribution: { runId: payload.runId },
        },
        (resolved) =>
          generateText({
            model: resolved.model,
            instructions: INSTRUCTIONS,
            messages: [{ role: 'user', content: prompt }],
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(TIMEOUT_MS),
          }),
      ));
    } catch (error) {
      // A suggestion is a courtesy: no retry, no hand-off, nothing changes for the customer.
      this.logger.warn(`follow-ups not written for ${payload.conversationId}: ${String(error)}`);
      return;
    }
    // Never the customer's own question or a line of the answer back.
    const items = followUpsOf(text, [turn.question, turn.answer]);
    if (items.length === 0) return;
    const entries = await this.tx(tenantId, async (tx) => {
      const [publication] = await tx
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.sourceKey, payload.sourceKey))
        .for('update');
      if (!publication || (publication.detail as { followUps?: unknown }).followUps) return [];
      await tx
        .update(schema.publications)
        .set({ detail: { ...(publication.detail as object), followUps: items } })
        .where(eq(schema.publications.sourceKey, payload.sourceKey));
      const message = await this.journaled(tx, payload.conversationId, payload.authorityId);
      if (!message) return [];
      const parts: MessagePart[] = [
        ...message.parts.filter((part) => part.type !== 'suggestions'),
        { type: 'suggestions', items },
      ];
      return this.journal.append(tx, tenantId, payload.conversationId, [
        {
          lane: 'customer',
          type: 'message.updated',
          data: { message: { ...message, parts } },
          authorityId: payload.authorityId,
        },
      ]);
    });
    await this.journal.notify(tenantId, payload.conversationId, entries);
  }

  /** The answer as journaled, and the customer's words just before it. */
  private async lastTurn(
    tx: TenantTx,
    conversationId: string,
    authorityId: number,
  ): Promise<{ question: string; answer: string } | null> {
    const answer = await this.journaled(tx, conversationId, authorityId);
    if (answer?.sender.kind !== 'ai_agent') return null;
    const j = schema.conversationJournal;
    const [answerRow] = await tx
      .select({ seq: j.seq })
      .from(j)
      .where(
        and(
          eq(j.conversationId, conversationId),
          eq(j.authorityId, authorityId),
          eq(j.eventType, 'message.created'),
        ),
      );
    if (!answerRow) return null;
    const earlier = await tx
      .select({ event: j.event })
      .from(j)
      .where(
        and(
          eq(j.conversationId, conversationId),
          eq(j.lane, 'customer'),
          eq(j.eventType, 'message.created'),
          lte(j.seq, answerRow.seq),
        ),
      )
      .orderBy(desc(j.seq))
      .limit(8);
    const question = earlier
      .map((row) => (row.event as { data?: { message?: Message } }).data?.message)
      .find((message) => message?.sender.kind === 'customer');
    const words = (message: Message | undefined) =>
      (message?.parts ?? [])
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join(' ')
        .trim();
    const said = words(question);
    const answered = words(answer);
    return said && answered ? { question: said, answer: answered } : null;
  }

  private async journaled(
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
          eq(j.lane, 'customer'),
          eq(j.eventType, 'message.created'),
        ),
      );
    return (row?.event as { data?: { message?: Message } } | undefined)?.data?.message ?? null;
  }
}
