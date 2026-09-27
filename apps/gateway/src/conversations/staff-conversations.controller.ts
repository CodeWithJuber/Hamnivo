import { StaffMessageRequest, TakeoverRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { StaffConversationsService } from './staff-conversations.service.js';

@Controller('v1/conversations')
export class StaffConversationsController {
  constructor(private readonly conversations: StaffConversationsService) {}

  @Get(':conversationId')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  get(@CurrentPrincipal() principal: StaffPrincipal, @Param('conversationId') id: string) {
    return this.conversations.get(principal, id);
  }

  @Post(':conversationId/takeover')
  @StaffRoute({ tenant: true, permission: 'conversations.takeover' })
  @HttpCode(200)
  takeover(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Body() body: unknown,
  ) {
    return this.conversations.takeover(
      principal,
      id,
      parseInput(TakeoverRequest, body ?? {}).expectedEpoch,
    );
  }

  @Post(':conversationId/return-to-ai')
  @StaffRoute({ tenant: true, permission: 'conversations.assign' })
  @HttpCode(200)
  returnToAi(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Body() body: unknown,
  ) {
    return this.conversations.returnToAi(
      principal,
      id,
      parseInput(TakeoverRequest, body ?? {}).expectedEpoch,
    );
  }

  @Post(':conversationId/messages')
  // Replies need conversations.reply and notes conversations.note; the service checks which.
  @StaffRoute({ tenant: true })
  @HttpCode(202)
  send(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Body() body: unknown,
  ) {
    return this.conversations.send(principal, id, parseInput(StaffMessageRequest, body));
  }
}
