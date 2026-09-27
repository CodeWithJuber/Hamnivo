import {
  decisionRoutes,
  ReviewDecisionRequest,
  SaveRubricDraftRequest,
  SetDecisionModeRequest,
  SetTeamRoutingRequest,
  TestRubricRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { RoutingService } from './routing.service.js';
import { RubricsService } from './rubrics.service.js';
import { TeamRoutingService } from './team-routing.service.js';

/**
 * Jev-assisted routing in Studio (J02, J05, J07, J08, board 12). Each handler checks the brand
 * permission itself: reading needs `decisions.read`; rubrics, modes and each team's routing for
 * the brand need `decisions.manage`. Teams themselves are the inbox's (`/v1/admin/teams`).
 */
@Controller('v1/admin')
export class DecisionsController {
  constructor(
    private readonly teams: TeamRoutingService,
    private readonly rubrics: RubricsService,
    private readonly routing: RoutingService,
  ) {}

  @Get('brands/:brandId/routing/teams')
  @StaffRoute({ tenant: true, permission: 'decisions.read' })
  async listTeams(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
  ) {
    return { items: await this.teams.list(principal, brandId) };
  }

  @Put('brands/:brandId/routing/teams/:teamId')
  @StaffRoute({ tenant: true, permission: 'decisions.manage' })
  setTeamRouting(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('teamId') teamId: string,
    @Body() body: unknown,
  ) {
    return this.teams.set(principal, brandId, teamId, parseInput(SetTeamRoutingRequest, body));
  }

  @Get('brands/:brandId/decisions/:task')
  @StaffRoute({ tenant: true, permission: 'decisions.read' })
  getTask(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('task') task: string,
  ) {
    return this.rubrics.get(principal, brandId, task);
  }

  @Put('brands/:brandId/decisions/:task/draft')
  @StaffRoute({ tenant: true, permission: 'decisions.manage' })
  saveDraft(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('task') task: string,
    @Body() body: unknown,
  ) {
    return this.rubrics.saveDraft(
      principal,
      brandId,
      task,
      parseInput(SaveRubricDraftRequest, body),
    );
  }

  @Post('brands/:brandId/decisions/:task/publish')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'decisions.manage' })
  publish(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('task') task: string,
  ) {
    return this.rubrics.publish(principal, brandId, task);
  }

  @Put('brands/:brandId/decisions/:task/mode')
  @StaffRoute({ tenant: true, permission: 'decisions.manage' })
  setMode(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('task') task: string,
    @Body() body: unknown,
  ) {
    const input = parseInput(SetDecisionModeRequest, body);
    return this.rubrics.setMode(principal, brandId, task, input.mode);
  }

  @Post('brands/:brandId/decisions/:task/test')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'decisions.manage' })
  test(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('task') task: string,
    @Body() body: unknown,
  ) {
    return this.routing.test(principal, brandId, task, parseInput(TestRubricRequest, body));
  }

  @Get('brands/:brandId/decisions/:task/records')
  @StaffRoute({ tenant: true, permission: 'decisions.read' })
  records(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('task') task: string,
    @Query() query: unknown,
  ) {
    const input = parseInput(decisionRoutes.listDecisionRecords.query, query);
    return this.rubrics.records(principal, brandId, task, input);
  }

  @Get('brands/:brandId/decisions/:task/experiment')
  @StaffRoute({ tenant: true, permission: 'decisions.read' })
  experiment(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('task') task: string,
    @Query() query: unknown,
  ) {
    const input = parseInput(decisionRoutes.getDecisionExperiment.query, query);
    return this.rubrics.experiment(principal, brandId, task, input.days);
  }

  @Get('decisions/:decisionId')
  @StaffRoute({ tenant: true, permission: 'decisions.read' })
  record(@CurrentPrincipal() principal: StaffPrincipal, @Param('decisionId') decisionId: string) {
    return this.rubrics.record(principal, decisionId);
  }

  @Post('decisions/:decisionId/review')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'decisions.manage' })
  review(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('decisionId') decisionId: string,
    @Body() body: unknown,
  ) {
    return this.rubrics.review(principal, decisionId, parseInput(ReviewDecisionRequest, body));
  }
}
