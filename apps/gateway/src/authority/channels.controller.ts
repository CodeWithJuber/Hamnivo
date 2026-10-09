import {
  ConnectEmailRequest,
  ConnectTelegramRequest,
  ConnectWhatsappRequest,
  UpdateChannelRequest,
  UpdateEmailRequest,
} from '@hamnivo/contracts';
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

  /** Never kept for replays: the request holds the mailbox's passwords. */
  @Post('brands/:brandId/channels/email')
  @StaffRoute({ tenant: true, permission: 'integrations.manage' })
  async connectEmail(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.channels.connectEmail(principal, brandId, parseInput(ConnectEmailRequest, body));
  }

  @Get('channels/:channelId/email')
  @StaffRoute({ tenant: true, permission: 'integrations.manage' })
  async emailSettings(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('channelId') channelId: string,
  ) {
    return this.channels.emailSettings(principal, channelId);
  }

  @Put('channels/:channelId/email')
  @StaffRoute({ tenant: true, permission: 'integrations.manage' })
  async updateEmail(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('channelId') channelId: string,
    @Body() body: unknown,
  ) {
    return this.channels.updateEmailSettings(
      principal,
      channelId,
      parseInput(UpdateEmailRequest, body),
    );
  }

  /** Never kept for replays: the request holds the WhatsApp access token. */
  @Post('brands/:brandId/channels/whatsapp')
  @StaffRoute({ tenant: true, permission: 'integrations.manage' })
  async connectWhatsapp(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.channels.connectWhatsapp(
      principal,
      brandId,
      parseInput(ConnectWhatsappRequest, body),
    );
  }

  @Get('channels/:channelId/whatsapp')
  @StaffRoute({ tenant: true, permission: 'integrations.manage' })
  async whatsappSetup(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('channelId') channelId: string,
  ) {
    return this.channels.whatsappSetup(principal, channelId);
  }

  /** Never kept for replays: the request holds the bot token. */
  @Post('brands/:brandId/channels/telegram')
  @StaffRoute({ tenant: true, permission: 'integrations.manage' })
  async connectTelegram(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.channels.connectTelegram(
      principal,
      brandId,
      parseInput(ConnectTelegramRequest, body),
    );
  }
}
