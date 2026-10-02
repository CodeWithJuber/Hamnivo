import { checkRoutes, SaveCheckDraftRequest, SetDecisionModeRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { ChecksAdminService } from './checks-admin.service.js';

/**
 * Checks around AI replies in Studio. Each handler checks the brand permission itself: reading
 * needs `decisions.read`; rubrics and modes need `decisions.manage`.
 */
@Controller('v1/admin/brands/:brandId/checks')
export class ChecksController {
  constructor(private readonly checks: ChecksAdminService) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'decisions.read' })
  async list(@CurrentPrincipal() principal: StaffPrincipal, @Param('brandId') brandId: string) {
    return { items: await this.checks.list(principal, brandId) };
  }

  @Put(':task/draft')
  @StaffRoute({ tenant: true, permission: 'decisions.manage' })
  saveDraft(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('task') task: string,
    @Body() body: unknown,
  ) {
    return this.checks.saveDraft(principal, brandId, task, parseInput(SaveCheckDraftRequest, body));
  }

  @Post(':task/publish')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'decisions.manage' })
  publish(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('task') task: string,
  ) {
    return this.checks.publish(principal, brandId, task);
  }

  @Put(':task/mode')
  @StaffRoute({ tenant: true, permission: 'decisions.manage' })
  setMode(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('task') task: string,
    @Body() body: unknown,
  ) {
    return this.checks.setMode(
      principal,
      brandId,
      task,
      parseInput(SetDecisionModeRequest, body).mode,
    );
  }

  @Get(':task/records')
  @StaffRoute({ tenant: true, permission: 'decisions.read' })
  records(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('task') task: string,
    @Query() query: unknown,
  ) {
    return this.checks.records(
      principal,
      brandId,
      task,
      parseInput(checkRoutes.listCheckRecords.query, query),
    );
  }
}
