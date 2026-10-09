import { UpdateChannelRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { ChannelInboxesService } from './channel-inboxes.service.js';

/** Settings → Channels (ADR 0013): the brand's email, WhatsApp and Telegram inboxes. */
@Controller('v1/admin')
export class ChannelsController {
  constructor(private readonly channels: ChannelInboxesService) {}

  @Get('brands/:brandId/channels')
  @StaffRoute({ tenant: true, permission: 'integrations.manage' })
  async list(@CurrentPrincipal() principal: StaffPrincipal, @Param('brandId') brandId: string) {
    return { items: await this.channels.list(principal, brandId) };
  }

  @Post('brands/:brandId/channels/find')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'integrations.manage' })
  async find(@CurrentPrincipal() principal: StaffPrincipal, @Param('brandId') brandId: string) {
    return { items: await this.channels.find(principal, brandId) };
  }

  @Put('channels/:channelId')
  @StaffRoute({ tenant: true, permission: 'integrations.manage' })
  async update(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('channelId') channelId: string,
    @Body() body: unknown,
  ) {
    return this.channels.update(principal, channelId, parseInput(UpdateChannelRequest, body));
  }
}
