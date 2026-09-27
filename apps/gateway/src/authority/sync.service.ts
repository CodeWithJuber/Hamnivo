import { type ClaimedOutboxEvent, type Db, schema, withTenant } from '@hamnivo/db';
import type { OwnerMode } from '@hamnivo/db/schema';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { APP_DB } from '../tokens.js';
import type { OwnerTarget } from './ownership.service.js';
import { AuthorityRegistry } from './registry.js';
import { StaffLinksService } from './staff-links.service.js';
import { uuidV5 } from './uuid.js';

interface OwnerChanged {
  conversationId: string;
  epoch: number;
  previousMode: OwnerMode;
  target: OwnerTarget;
  reason: string;
  handoffNote?: string;
}

/**
 * Applies Hamnivo's ownership changes in Chatwoot (outbox topic `conversation.owner_changed`),
 * each with the credential of whoever acts: the staff member's own user for takeovers, the bot for
 * handing off, the integration user otherwise. Safe to repeat; superseded changes are skipped.
 */
@Injectable()
export class AuthoritySyncService {
  private readonly logger = new Logger(AuthoritySyncService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    private readonly registry: AuthorityRegistry,
    private readonly staffLinks: StaffLinksService,
  ) {}

  async applyOwnerChange(event: ClaimedOutboxEvent): Promise<void> {
    const payload = event.payload as OwnerChanged;
    const tenantId = event.tenantId;
    const [control] = await withTenant(this.db, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, payload.conversationId)),
    );
    if (!control) return;
    if (control.ownershipEpoch !== payload.epoch || control.ownerSyncedEpoch >= payload.epoch) {
      // A newer change supersedes this one (its own event will sync), or it was already applied.
      return;
    }
    const runtime = await this.registry.get(tenantId, control.connectionId);
    const authority = runtime.authority;
    const ref = String(control.externalConversationId);
    const target = payload.target;
    switch (target.kind) {
      case 'staff': {
        const userId = await this.staffLinks.ensure(runtime, target.staffMemberId);
        await authority.setOwner(
          ref,
          { kind: 'user', userRef: String(userId) },
          { kind: 'staff', userRef: String(userId) },
        );
        break;
      }
      case 'ai': {
        const bot = runtime.bots.find((b) => b.id === target.botId) ?? runtime.primaryBot;
        if (!bot) throw new Error('No AI bot is attached to this connection');
        await authority.setOwner(
          ref,
          { kind: 'bot', botRef: String(bot.externalBotId) },
          { kind: 'integration' },
        );
        break;
      }
      case 'queue': {
        if (payload.previousMode === 'AI_ACTIVE' && runtime.primaryBot) {
          // Chatwoot's bot handoff: the bot lets go and the conversation opens for people.
          await authority.setStatus(ref, 'open', {
            kind: 'bot',
            botRef: String(runtime.primaryBot.externalBotId),
          });
        } else {
          await authority.setOwner(ref, { kind: 'none' }, { kind: 'integration' });
          await authority.setStatus(ref, 'open', { kind: 'integration' });
        }
        break;
      }
      case 'external':
        break;
    }
    if (payload.handoffNote) {
      const key = `hv1:n:${uuidV5(control.id, `handoff:${payload.epoch}`)}`;
      if (!(await authority.findByKey(ref, key))) {
        await authority.appendMessage({
          conversationRef: ref,
          key,
          author: { kind: 'integration' },
          visibility: 'private',
          text: payload.handoffNote,
        });
      }
    }
    await withTenant(this.db, { tenantId }, (tx) =>
      tx
        .update(schema.conversationControls)
        .set({ ownerSyncedEpoch: payload.epoch })
        .where(
          and(
            eq(schema.conversationControls.id, control.id),
            eq(schema.conversationControls.ownershipEpoch, payload.epoch),
          ),
        ),
    );
    this.logger.log(
      `owner of ${control.id} synced to Chatwoot at epoch ${payload.epoch} (${target.kind})`,
    );
  }
}
