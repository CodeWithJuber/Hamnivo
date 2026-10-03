import type { ConversationMemoryCustomer } from '@hamnivo/contracts';
import { fromPublicId, InvalidPublicIdError, toPublicId } from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { enforce } from '../identity/staff.guard.js';
import { InboxAccess } from '../inbox/access.js';

/**
 * Which customer's memory a conversation belongs to, so the inbox can show what is remembered
 * beside the conversation. Only the id is given: the memory itself comes from the memory API,
 * which checks the person's `memory.read` for the customer's brand again. A conversation the
 * person cannot see does not exist for them, and a person without `memory.read` for its brand is
 * refused.
 */
@Injectable()
export class ConversationMemoryService {
  constructor(private readonly access: InboxAccess) {}

  async customerOf(
    principal: StaffPrincipal,
    conversationId: string,
  ): Promise<ConversationMemoryCustomer> {
    try {
      fromPublicId('conversation', conversationId);
    } catch (error) {
      if (error instanceof InvalidPublicIdError) {
        throw new AppError('NOT_FOUND', { detail: 'Conversation not found.' });
      }
      throw error;
    }
    return this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(
        tx,
        principal,
        conversationId,
        'conversations.read',
      );
      enforce(this.access.decide(principal, 'memory.read', found.resource));
      const { principalId } = found.control;
      return { customerId: principalId ? toPublicId('customer', principalId) : null };
    });
  }
}
