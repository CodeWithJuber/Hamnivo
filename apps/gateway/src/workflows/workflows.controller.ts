import {
  CreateA2AConnectionRequest,
  CreateWorkflowRequest,
  PublishWorkflowRequest,
  SaveWorkflowRequest,
  SetWorkflowEnabledRequest,
  StartWorkflowRequest,
  workflowRoutes,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { WorkflowsService } from './workflows.service.js';
@Controller('v1/admin')
export class WorkflowsController {
  constructor(private readonly service: WorkflowsService) {}
  @Get('brands/:brandId/workflows')
  @StaffRoute({ tenant: true, permission: 'automations.read' })
  list(@CurrentPrincipal() p: StaffPrincipal, @Param('brandId') id: string) {
    return this.service.list(p, id);
  }
  @Post('brands/:brandId/workflows')
  @HttpCode(201)
  @StaffRoute({ tenant: true, permission: 'automations.manage' })
  create(
    @CurrentPrincipal() p: StaffPrincipal,
    @Param('brandId') id: string,
    @Body() body: unknown,
  ) {
    return this.service.create(p, id, parseInput(CreateWorkflowRequest, body));
  }
  @Get('workflows/:workflowId')
  @StaffRoute({ tenant: true, permission: 'automations.read' })
  get(@CurrentPrincipal() p: StaffPrincipal, @Param('workflowId') id: string) {
    return this.service.get(p, id);
  }
  @Put('workflows/:workflowId')
  @StaffRoute({ tenant: true, permission: 'automations.manage' })
  save(
    @CurrentPrincipal() p: StaffPrincipal,
    @Param('workflowId') id: string,
    @Body() body: unknown,
  ) {
    return this.service.save(p, id, parseInput(SaveWorkflowRequest, body));
  }
  @Post('workflows/:workflowId/publish')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'automations.manage' })
  publish(
    @CurrentPrincipal() p: StaffPrincipal,
    @Param('workflowId') id: string,
    @Body() body: unknown,
  ) {
    return this.service.publish(p, id, parseInput(PublishWorkflowRequest, body).revision);
  }
  @Put('workflows/:workflowId/enabled')
  @StaffRoute({ tenant: true, permission: 'automations.manage' })
  enabled(
    @CurrentPrincipal() p: StaffPrincipal,
    @Param('workflowId') id: string,
    @Body() body: unknown,
  ) {
    return this.service.setEnabled(p, id, parseInput(SetWorkflowEnabledRequest, body).enabled);
  }
  @Get('workflows/:workflowId/versions')
  @StaffRoute({ tenant: true, permission: 'automations.read' })
  versions(@CurrentPrincipal() p: StaffPrincipal, @Param('workflowId') id: string) {
    return this.service.versions(p, id);
  }
  @Post('workflows/:workflowId/versions/:version/restore')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'automations.manage' })
  restore(@CurrentPrincipal() p: StaffPrincipal, @Param() params: unknown, @Body() body: unknown) {
    const { workflowId, version } = parseInput(
      workflowRoutes.restoreWorkflowVersion.params,
      params,
    );
    return this.service.restore(
      p,
      workflowId,
      version,
      parseInput(PublishWorkflowRequest, body).revision,
    );
  }
  @Get('workflows/:workflowId/runs')
  @StaffRoute({ tenant: true, permission: 'automations.read' })
  runs(@CurrentPrincipal() p: StaffPrincipal, @Param('workflowId') id: string) {
    return this.service.listRuns(p, id);
  }
  @Post('workflows/:workflowId/runs')
  @HttpCode(201)
  @StaffRoute({ tenant: true, permission: 'automations.manage' })
  start(
    @CurrentPrincipal() p: StaffPrincipal,
    @Param('workflowId') id: string,
    @Body() body: unknown,
  ) {
    return this.service.start(p, id, parseInput(StartWorkflowRequest, body));
  }
  @Post('workflow-runs/:runId/cancel')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'automations.manage' })
  cancel(@CurrentPrincipal() p: StaffPrincipal, @Param('runId') id: string) {
    return this.service.cancel(p, id);
  }
  @Get('brands/:brandId/a2a-connections')
  @StaffRoute({ tenant: true, permission: 'automations.read' })
  connections(@CurrentPrincipal() p: StaffPrincipal, @Param('brandId') id: string) {
    return this.service.connections(p, id);
  }
  @Post('brands/:brandId/a2a-connections')
  @HttpCode(201)
  @StaffRoute({ tenant: true, permission: 'automations.manage' })
  createConnection(
    @CurrentPrincipal() p: StaffPrincipal,
    @Param('brandId') id: string,
    @Body() body: unknown,
  ) {
    return this.service.createConnection(p, id, parseInput(CreateA2AConnectionRequest, body));
  }
  @Put('a2a-connections/:connectionId/enabled')
  @StaffRoute({ tenant: true, permission: 'automations.manage' })
  connectionEnabled(
    @CurrentPrincipal() p: StaffPrincipal,
    @Param('connectionId') id: string,
    @Body() body: unknown,
  ) {
    return this.service.enableConnection(
      p,
      id,
      parseInput(SetWorkflowEnabledRequest, body).enabled,
    );
  }
}
