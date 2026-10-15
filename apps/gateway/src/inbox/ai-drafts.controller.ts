import { ApproveAiDraftRequest, RejectAiDraftRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { AiDraftsService } from './ai-drafts.service.js';

/**
 * AI drafts awaiting review (HNV-09-05). The service checks the permission on the conversation
 * itself: reading it to see drafts, replying in it to approve or reject one.
 */
@Controller('v1/inbox/conversations')
export class AiDraftsController {
  constructor(private readonly drafts: AiDraftsService) {}

  @Get(':conversationId/ai-drafts')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  list(@CurrentPrincipal() principal: StaffPrincipal, @Param('conversationId') id: string) {
    return this.drafts.list(principal, id);
  }

  @Post(':conversationId/ai-drafts/:draftId/approve')
  @StaffRoute({ tenant: true, permission: 'conversations.reply' })
  @HttpCode(200)
  approve(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Param('draftId') draftId: string,
    @Body() body: unknown,
  ) {
    return this.drafts.approve(principal, id, draftId, parseInput(ApproveAiDraftRequest, body));
  }

  @Post(':conversationId/ai-drafts/:draftId/reject')
  @StaffRoute({ tenant: true, permission: 'conversations.reply' })
  @HttpCode(200)
  reject(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Param('draftId') draftId: string,
    @Body() body: unknown,
  ) {
    return this.drafts.reject(principal, id, draftId, parseInput(RejectAiDraftRequest, body));
  }
}
