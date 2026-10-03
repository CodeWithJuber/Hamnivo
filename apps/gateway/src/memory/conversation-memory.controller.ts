import type { StaffPrincipal } from '@hamnivo/policy';
import { Controller, Get, Header, Param } from '@nestjs/common';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { ConversationMemoryService } from './conversation-memory.service.js';

/** The memory customer of a conversation (L04), for the inbox panel. Never cached (K09). */
@Controller('v1/admin/memory/conversations')
export class ConversationMemoryController {
  constructor(private readonly conversations: ConversationMemoryService) {}

  @Get(':conversationId')
  @StaffRoute({ tenant: true, permission: 'memory.read' })
  @Header('cache-control', 'no-store')
  customer(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') conversationId: string,
  ) {
    return this.conversations.customerOf(principal, conversationId);
  }
}
