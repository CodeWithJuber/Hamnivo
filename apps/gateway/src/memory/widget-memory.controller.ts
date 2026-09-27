import { CorrectMemoryRequest, SetMemoryConsentRequest } from '@hamnivo/contracts';
import { Body, Controller, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import type { WidgetClaims } from '../widget/tokens.service.js';
import { CurrentWidget, WidgetRoute } from '../widget/widget.guard.js';
import { CustomerMemoryService } from './customer-memory.service.js';

/**
 * The customer's own memory from the chat widget (L04). Responses are personal: `no-store` keeps
 * them out of every shared and browser cache (K09).
 */
@Controller('v1/widget/memory')
export class WidgetMemoryController {
  constructor(private readonly memory: CustomerMemoryService) {}

  @Get()
  @WidgetRoute()
  @Header('cache-control', 'no-store')
  get(@CurrentWidget() claims: WidgetClaims) {
    return this.memory.get(claims);
  }

  @Post('consent')
  @WidgetRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  consent(@CurrentWidget() claims: WidgetClaims, @Body() body: unknown) {
    return this.memory.setConsent(claims, parseInput(SetMemoryConsentRequest, body));
  }

  @Post('forget')
  @WidgetRoute()
  @HttpCode(202)
  @Header('cache-control', 'no-store')
  forget(@CurrentWidget() claims: WidgetClaims) {
    return this.memory.forget(claims);
  }

  @Get('deletions/:deletionId')
  @WidgetRoute()
  @Header('cache-control', 'no-store')
  deletion(@CurrentWidget() claims: WidgetClaims, @Param('deletionId') deletionId: string) {
    return this.memory.deletion(claims, deletionId);
  }

  @Post(':memoryId/correct')
  @WidgetRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  correct(
    @CurrentWidget() claims: WidgetClaims,
    @Param('memoryId') memoryId: string,
    @Body() body: unknown,
  ) {
    return this.memory.correct(claims, memoryId, parseInput(CorrectMemoryRequest, body).value);
  }

  @Post(':memoryId/confirm')
  @WidgetRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  confirm(@CurrentWidget() claims: WidgetClaims, @Param('memoryId') memoryId: string) {
    return this.memory.confirm(claims, memoryId);
  }

  @Post(':memoryId/delete')
  @WidgetRoute()
  @HttpCode(202)
  @Header('cache-control', 'no-store')
  delete(@CurrentWidget() claims: WidgetClaims, @Param('memoryId') memoryId: string) {
    return this.memory.delete(claims, memoryId);
  }
}
