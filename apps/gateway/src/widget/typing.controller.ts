import { TypingRequest } from '@hamnivo/contracts';
import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CustomerTypingService } from '../inbox/customer-typing.service.js';
import type { WidgetClaims } from './tokens.service.js';
import { CurrentWidget, WidgetRoute } from './widget.guard.js';

/** The customer is typing in one of their conversations (staff see it live). */
@Controller('v1/widget')
export class WidgetTypingController {
  constructor(private readonly typing: CustomerTypingService) {}

  @Post('conversations/:conversationId/typing')
  @WidgetRoute()
  @HttpCode(204)
  async report(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.typing.report(claims, conversationId, parseInput(TypingRequest, body).typing);
  }
}
