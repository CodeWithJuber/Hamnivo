import { appendAudit, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import type { AuthorityMessage } from '@hamnivo/domain';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { enqueueOutbox } from '../outbox/outbox.js';
import { CLOCK, type Clock } from '../tokens.js';
import type { ControlRow } from './ownership.service.js';
import { uuidV5 } from './uuid.js';

export const LATE_PUBLICATION_NOTE =
  'An AI reply reached the customer after a person took over this conversation. ' +
  'Please read it and follow up with the customer if needed.';

export type PublicationOutcome = 'sent' | 'late_publication';

/** Chatwoot stores message times in whole seconds, so ordering against them is only this exact. */
const AUTHORITY_CLOCK_SLACK_MS = 1000;

/**
 * Confirms that an AI publication reached Chatwoot (ADR 0003). The fences check ownership when the
 * reply is reserved and again just before it is posted, but a takeover committed while the post is
 * in flight can still let one reply through. Such a reply stays visible (nothing is deleted); it is
 * marked `late_publication`, audited, and the new owner gets a private note about it. Chatwoot's
 * times have one-second resolution, so a reply stored within a second before the takeover is also
 * marked: a note too many, never one missed.
 */
@Injectable()
export class PublicationsService {
  private readonly logger = new Logger(PublicationsService.name);

  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /** Records the Chatwoot message for a publication key; the control row must be locked. */
  async confirm(
    tx: TenantTx,
    tenantId: string,
    control: ControlRow,
    sourceKey: string,
    message: AuthorityMessage,
  ): Promise<PublicationOutcome | null> {
    const [publication] = await tx
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.sourceKey, sourceKey))
      .for('update');
    if (!publication || publication.state === 'aborted') return null;
    // Lateness is judged once, when the message is first confirmed; a later sighting (a webhook
    // after the reply was recorded, or a reconciler pass) sees ownership changes made afterwards.
    if (publication.state === 'late_publication' || publication.state === 'sent') {
      return publication.state;
    }
    const late =
      publication.epoch < control.ownershipEpoch &&
      (await this.ownerChangedBefore(tx, control.id, publication.epoch + 1, message.createdAt));
    const now = this.clock();
    await tx
      .update(schema.publications)
      .set({
        state: late ? 'late_publication' : 'sent',
        authorityMessageId: Number(message.ref),
        sentAt: publication.sentAt ?? now,
        updatedAt: now,
      })
      .where(eq(schema.publications.id, publication.id));
    if (!late) return 'sent';

    await appendAudit(tx, {
      actorType: 'system',
      actorId: 'authority',
      action: 'conversation.late_publication',
      targetType: 'conversation',
      targetId: toPublicId('conversation', control.id),
      outcome: 'failed',
      data: {
        publication: publication.id,
        publishedAtEpoch: publication.epoch,
        currentEpoch: control.ownershipEpoch,
        ownerMode: control.ownerMode,
      },
    });
    await enqueueOutbox(tx, tenantId, {
      topic: 'conversation.note',
      aggregateType: 'conversation',
      aggregateId: control.id,
      payload: {
        conversationId: control.id,
        key: `hv1:n:${uuidV5(control.id, `late:${publication.id}`)}`,
        text: LATE_PUBLICATION_NOTE,
      },
    });
    this.logger.warn(
      `late publication in conversation ${control.id}: reply from epoch ${publication.epoch} ` +
        `reached Chatwoot at epoch ${control.ownershipEpoch}`,
    );
    return 'late_publication';
  }

  /** Whether the ownership change that started `epoch` may have been committed before `at`. */
  private async ownerChangedBefore(
    tx: TenantTx,
    conversationId: string,
    epoch: number,
    at: Date,
  ): Promise<boolean> {
    const a = schema.auditEvents;
    const [change] = await tx
      .select({ occurredAt: a.occurredAt })
      .from(a)
      .where(
        and(
          eq(a.targetType, 'conversation'),
          eq(a.targetId, toPublicId('conversation', conversationId)),
          eq(a.action, 'conversation.owner_changed'),
          sql`(${a.data} ->> 'epoch')::bigint = ${epoch}`,
        ),
      )
      .limit(1);
    return (
      change !== undefined && change.occurredAt.getTime() < at.getTime() + AUTHORITY_CLOCK_SLACK_MS
    );
  }
}
