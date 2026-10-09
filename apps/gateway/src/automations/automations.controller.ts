import {
  automationRoutes,
  CreateAutomationRequest,
  PublishAutomationRequest,
  SaveAutomationRequest,
  SetAutomationEnabledRequest,
  UpdatePromptLimitsRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { AutomationsService } from './automations.service.js';

/** Automations (G21): website prompts and chat rules, as drafts, versions and runs. */
@Controller('v1/admin')
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @Get('brands/:brandId/automations')
  @StaffRoute({ tenant: true, permission: 'automations.read' })
  list(@CurrentPrincipal() principal: StaffPrincipal, @Param('brandId') brandId: string) {
    return this.automations.list(principal, brandId);
  }

  @Get('brands/:brandId/automations/options')
  @StaffRoute({ tenant: true, permission: 'automations.read' })
  options(@CurrentPrincipal() principal: StaffPrincipal, @Param('brandId') brandId: string) {
    return this.automations.options(principal, brandId);
  }

  @Post('brands/:brandId/automations')
  @StaffRoute({ tenant: true, permission: 'automations.manage' })
  @HttpCode(201)
  create(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.automations.create(principal, brandId, parseInput(CreateAutomationRequest, body));
  }

  @Put('brands/:brandId/automations/prompt-limits')
  @StaffRoute({ tenant: true, permission: 'automations.manage' })
  promptLimits(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.automations.updatePromptLimits(
      principal,
      brandId,
      parseInput(UpdatePromptLimitsRequest, body),
    );
  }

  @Get('automations/:automationId')
  @StaffRoute({ tenant: true, permission: 'automations.read' })
  get(@CurrentPrincipal() principal: StaffPrincipal, @Param('automationId') id: string) {
    return this.automations.get(principal, id);
  }

  @Put('automations/:automationId')
  @StaffRoute({ tenant: true, permission: 'automations.manage' })
  save(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('automationId') id: string,
    @Body() body: unknown,
  ) {
    return this.automations.save(principal, id, parseInput(SaveAutomationRequest, body));
  }

  @Post('automations/:automationId/publish')
  @StaffRoute({ tenant: true, permission: 'automations.manage' })
  @HttpCode(200)
  publish(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('automationId') id: string,
    @Body() body: unknown,
  ) {
    return this.automations.publish(
      principal,
      id,
      parseInput(PublishAutomationRequest, body).revision,
    );
  }

  @Put('automations/:automationId/enabled')
  @StaffRoute({ tenant: true, permission: 'automations.manage' })
  setEnabled(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('automationId') id: string,
    @Body() body: unknown,
  ) {
    return this.automations.setEnabled(
      principal,
      id,
      parseInput(SetAutomationEnabledRequest, body).enabled,
    );
  }

  @Delete('automations/:automationId')
  @StaffRoute({ tenant: true, permission: 'automations.manage' })
  @HttpCode(204)
  async remove(@CurrentPrincipal() principal: StaffPrincipal, @Param('automationId') id: string) {
    await this.automations.remove(principal, id);
  }

  @Get('automations/:automationId/versions')
  @StaffRoute({ tenant: true, permission: 'automations.read' })
  versions(@CurrentPrincipal() principal: StaffPrincipal, @Param('automationId') id: string) {
    return this.automations.versions(principal, id);
  }

  @Post('automations/:automationId/versions/:version/restore')
  @StaffRoute({ tenant: true, permission: 'automations.manage' })
  @HttpCode(200)
  restore(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { automationId, version } = parseInput(
      automationRoutes.restoreAutomationVersion.params,
      params,
    );
    return this.automations.restore(
      principal,
      automationId,
      version,
      parseInput(PublishAutomationRequest, body).revision,
    );
  }

  @Get('automations/:automationId/runs')
  @StaffRoute({ tenant: true, permission: 'automations.read' })
  runs(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('automationId') id: string,
    @Query() query: unknown,
  ) {
    const { limit } = parseInput(automationRoutes.listAutomationRuns.query, query);
    return this.automations.runs(principal, id, limit);
  }
}
