import { BlockVisitorRequest, blockRoutes } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { VisitorBlocksService } from './blocks.service.js';

/** Blocking visitors (H20): from a chat, from Live visitors, and the list to unblock from. */
@Controller('v1')
export class VisitorBlocksController {
  constructor(private readonly blocks: VisitorBlocksService) {}

  @Post('inbox/conversations/:conversationId/block')
  @StaffRoute({ tenant: true, permission: 'visitors.block' })
  @HttpCode(201)
  blockConversation(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.blocks.blockConversation(
      principal,
      conversationId,
      parseInput(BlockVisitorRequest, body),
    );
  }

  @Get('visitors/blocks')
  @StaffRoute({ tenant: true, permission: 'visitors.block' })
  list(@CurrentPrincipal() principal: StaffPrincipal, @Query() query: unknown) {
    return this.blocks.list(principal, parseInput(blockRoutes.listVisitorBlocks.query, query));
  }

  @Delete('visitors/blocks/:blockId')
  @StaffRoute({ tenant: true, permission: 'visitors.block' })
  @HttpCode(200)
  lift(@CurrentPrincipal() principal: StaffPrincipal, @Param('blockId') blockId: string) {
    return this.blocks.lift(principal, blockId);
  }

  @Post('visitors/:visitorId/block')
  @StaffRoute({ tenant: true, permission: 'visitors.block' })
  @HttpCode(201)
  blockVisitor(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('visitorId') visitorId: string,
    @Body() body: unknown,
  ) {
    return this.blocks.blockVisitor(
      principal,
      visitorId,
      parseInput(blockRoutes.blockLiveVisitor.body, body),
    );
  }
}
