import {
  AvailabilityPing,
  SetAvailabilityRequest,
  UpdateInboxAlertSettings,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { InboxAlertsService } from './alerts.service.js';
import { AvailabilityService } from './availability.service.js';

/**
 * What a staff member hears and sees when customers write (alerts, unread chats, availability).
 * Everything here belongs to the caller; the routes need `conversations.read` somewhere, like the
 * inbox itself.
 */
@Controller('v1/inbox')
export class InboxAlertsController {
  constructor(
    private readonly alerts: InboxAlertsService,
    private readonly availability: AvailabilityService,
  ) {}

  @Get('preferences')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  preferences(@CurrentPrincipal() principal: StaffPrincipal) {
    return this.alerts.preferences(principal);
  }

  @Patch('preferences')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  update(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return this.alerts.update(principal, parseInput(UpdateInboxAlertSettings, body));
  }

  @Put('availability')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  @HttpCode(200)
  setAvailability(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return this.availability.choose(principal, parseInput(SetAvailabilityRequest, body).status);
  }

  @Post('availability/ping')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  @HttpCode(200)
  ping(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return this.availability.ping(principal, parseInput(AvailabilityPing, body).active);
  }

  @Get('unread')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  unread(@CurrentPrincipal() principal: StaffPrincipal) {
    return this.alerts.unread(principal);
  }

  @Post('conversations/:conversationId/read')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  @HttpCode(204)
  async read(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
  ): Promise<void> {
    await this.alerts.read(principal, id);
  }
}
