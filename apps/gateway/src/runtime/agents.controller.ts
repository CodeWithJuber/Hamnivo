import {
  agentRoutes,
  CreateAgentRequest,
  PublishAgentRequest,
  SaveAgentDraftRequest,
  UpdateAgentRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService, validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { AgentsService } from './agents.service.js';

@Controller('v1/admin/agents')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'agents.read' })
  async list(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: await this.agents.list(principal) };
  }

  @Post()
  @StaffRoute({ tenant: true, permission: 'agents.manage' })
  async create(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateAgentRequest, body);
    const result = await this.idempotency.run(
      {
        tenantId: principal.tenantId,
        actor: `staff:${principal.staffMemberId}`,
        route: agentRoutes.createAgent.operationId,
        key: validIdempotencyKey(request.headers['idempotency-key']),
        body: input,
      },
      async () => ({ status: 201, body: await this.agents.create(principal, input) }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  @Get(':agentId')
  @StaffRoute({ tenant: true, permission: 'agents.read' })
  get(@CurrentPrincipal() principal: StaffPrincipal, @Param('agentId') agentId: string) {
    return this.agents.get(principal, agentId);
  }

  @Patch(':agentId')
  @StaffRoute({ tenant: true, permission: 'agents.manage' })
  update(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('agentId') agentId: string,
    @Body() body: unknown,
  ) {
    return this.agents.update(principal, agentId, parseInput(UpdateAgentRequest, body));
  }

  @Get(':agentId/versions')
  @StaffRoute({ tenant: true, permission: 'agents.read' })
  async versions(@CurrentPrincipal() principal: StaffPrincipal, @Param('agentId') agentId: string) {
    return { items: await this.agents.versions(principal, agentId) };
  }

  @Put(':agentId/draft')
  @StaffRoute({ tenant: true, permission: 'agents.manage' })
  saveDraft(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('agentId') agentId: string,
    @Body() body: unknown,
  ) {
    return this.agents.saveDraft(principal, agentId, parseInput(SaveAgentDraftRequest, body));
  }

  @Post(':agentId/publish')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'agents.publish' })
  publish(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('agentId') agentId: string,
    @Body() body: unknown,
  ) {
    return this.agents.publish(principal, agentId, parseInput(PublishAgentRequest, body ?? {}));
  }
}
