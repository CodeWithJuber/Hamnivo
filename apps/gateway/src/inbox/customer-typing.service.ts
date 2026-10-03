import { type Db, fromPublicId, schema, withTenant } from '@hamnivo/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { AppError } from '../common/app-error.js';
import { APP_DB, REDIS } from '../tokens.js';
import type { WidgetClaims } from '../widget/tokens.service.js';
import { InboxSignals } from './signals.service.js';
import { TypingSignals } from './typing.service.js';

/** One customer may report typing this often per conversation; more is ignored. */
const MIN_REPORT_GAP_MS = 1500;

/**
 * The customer's typing, as the widget reports it. Staff who may see the conversation hear of it
 * through the inbox stream; nothing is stored beyond a few seconds.
 */
@Injectable()
export class CustomerTypingService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly typing: TypingSignals,
    private readonly signals: InboxSignals,
  ) {}

  async report(claims: WidgetClaims, publicId: string, typing: boolean): Promise<void> {
    const conversationId = fromPublicId('conversation', publicId);
    // A report that is too soon after the last one changes nothing (stopping always goes through).
    if (typing) {
      const gate = await this.redis.set(
        `hamnivo:typing:gate:${claims.tenantId}:${claims.principalId}:${conversationId}`,
        '1',
        'PX',
        MIN_REPORT_GAP_MS,
        'NX',
      );
      if (gate !== 'OK') return;
    }
    const [own] = await withTenant(this.db, { tenantId: claims.tenantId }, (tx) =>
      tx
        .select({ id: schema.conversationControls.id })
        .from(schema.conversationControls)
        .where(
          and(
            eq(schema.conversationControls.id, conversationId),
            eq(schema.conversationControls.principalId, claims.principalId),
          ),
        ),
    );
    // Never "forbidden": that would confirm a conversation of someone else exists.
    if (!own) throw new AppError('NOT_FOUND', { detail: 'Conversation not found.' });
    const changed = await this.typing.setCustomerTyping(claims.tenantId, conversationId, typing);
    // Stopping tells staff once. While the customer keeps typing, each report is told again, so
    // a Studio that missed the "stopped" signal can drop the line after a few seconds.
    if (changed || typing) await this.signals.changed(claims.tenantId, [conversationId], 'typing');
  }
}
