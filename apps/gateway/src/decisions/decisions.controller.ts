import {
  CreateRoutingTeamRequest,
  decisionRoutes,
  ReviewDecisionRequest,
  SaveRubricDraftRequest,
  SetDecisionModeRequest,
  TestRubricRequest,
  UpdateRoutingTeamRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService, validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { RoutingService } from './routing.service.js';
import { RubricsService } from './rubrics.service.js';
import { TeamsService } from './teams.service.js';

/**
 * Jev-assisted routing in Studio (J02, J05, J07, J08, board 12). Each handler checks the brand
 * permission itself: reading needs `decisions.read`, rubrics and modes `decisions.manage`
 * (a fresh sign-in), teams `inbox.manage`.
 */
@Controller('v1/admin')
export class DecisionsController {
  constructor(
    private readonly teams: TeamsService,
    private readonly rubrics: RubricsService,
    private readonly routing: RoutingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('brands/:brandId/routing/teams')
  @StaffRoute({ tenant: true, permission: 'decisions.read' })
  async listTeams(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
  ) {
    return { items: await this.teams.list(principal, brandId) };
  }

  @Post('brands/:brandId/routing/teams')
  @StaffRoute({ tenant: true, permission: 'inbox.manage' })
  async createTeam(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateRoutingTeamRequest, body);
    const result = await this.idempotency.run(
      {
        tenantId: principal.tenantId,
        actor: `staff:${principal.staffMemberId}`,
        route: decisionRoutes.createRoutingTeam.operationId,
        key: validIdempotencyKey(request.headers['idempotency-key']),
        body: { brandId, ...input },
      },
      async () => ({ status: 201, body: await this.teams.create(principal, brandId, input) }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  @Patch('routing-teams/:teamId')
  @StaffRoute({ tenant: true, permission: 'inbox.manage' })
  updateTeam(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('teamId') teamId: string,
    @Body() body: unknown,
  ) {
    return this.teams.update(principal, teamId, parseInput(UpdateRoutingTeamRequest, body));
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
