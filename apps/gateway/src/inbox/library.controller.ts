import {
  CreateTagRequest,
  SaveSavedReplyRequest,
  UpdateSavedReplyRequest,
  UpdateTagRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { InboxLibraryService } from './library.service.js';

/**
 * Studio's editor for the saved replies and tags of a brand's chat account. The service checks
 * `inbox.manage` against the brand; the route only needs it somewhere in the tenant.
 */
@Controller('v1/admin/brands/:brandId')
export class InboxLibraryController {
  constructor(private readonly library: InboxLibraryService) {}

  @Get('saved-replies')
  @StaffRoute({ tenant: true, permission: 'inbox.manage' })
  savedReplies(@CurrentPrincipal() principal: StaffPrincipal, @Param('brandId') brandId: string) {
    return this.library.savedReplies(principal, brandId);
  }

  @Post('saved-replies')
  @StaffRoute({ tenant: true, permission: 'inbox.manage' })
  @HttpCode(201)
  createSavedReply(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.library.createSavedReply(
      principal,
      brandId,
      parseInput(SaveSavedReplyRequest, body),
    );
  }

  @Patch('saved-replies/:savedReplyId')
  @StaffRoute({ tenant: true, permission: 'inbox.manage' })
  updateSavedReply(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('savedReplyId') savedReplyId: string,
    @Body() body: unknown,
  ) {
    return this.library.updateSavedReply(
      principal,
      brandId,
      savedReplyId,
      parseInput(UpdateSavedReplyRequest, body),
    );
  }

  @Delete('saved-replies/:savedReplyId')
  @StaffRoute({ tenant: true, permission: 'inbox.manage' })
  @HttpCode(204)
  async deleteSavedReply(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('savedReplyId') savedReplyId: string,
  ): Promise<void> {
    await this.library.deleteSavedReply(principal, brandId, savedReplyId);
  }

  @Get('tags')
  @StaffRoute({ tenant: true, permission: 'inbox.manage' })
  tags(@CurrentPrincipal() principal: StaffPrincipal, @Param('brandId') brandId: string) {
    return this.library.tags(principal, brandId);
  }

  @Post('tags')
  @StaffRoute({ tenant: true, permission: 'inbox.manage' })
  @HttpCode(201)
  createTag(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.library.createTag(principal, brandId, parseInput(CreateTagRequest, body));
  }

  @Patch('tags/:title')
  @StaffRoute({ tenant: true, permission: 'inbox.manage' })
  updateTag(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('title') title: string,
    @Body() body: unknown,
  ) {
    return this.library.updateTag(principal, brandId, title, parseInput(UpdateTagRequest, body));
  }

  @Delete('tags/:title')
  @StaffRoute({ tenant: true, permission: 'inbox.manage' })
  @HttpCode(204)
  async deleteTag(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('title') title: string,
  ): Promise<void> {
    await this.library.deleteTag(principal, brandId, title);
  }
}
