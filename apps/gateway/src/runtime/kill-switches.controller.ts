import { agentRoutes, CreateKillSwitchRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService, validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { KillSwitchesService } from './kill-switches.service.js';

@Controller('v1/admin/kill-switches')
export class KillSwitchesController {
  constructor(
    private readonly switches: KillSwitchesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'agents.read' })
  async list(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: await this.switches.list(principal) };
  }

  /** agents.publish for reply switches, tools.manage for tool switches (checked on the target). */
  @Post()
  @StaffRoute({ tenant: true })
  async create(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateKillSwitchRequest, body);
    const result = await this.idempotency.run(
      {
        tenantId: principal.tenantId,
        actor: `staff:${principal.staffMemberId}`,
        route: agentRoutes.createKillSwitch.operationId,
        key: validIdempotencyKey(request.headers['idempotency-key']),
        body: input,
      },
      async () => ({ status: 201, body: await this.switches.create(principal, input) }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  @Post(':killSwitchId/clear')
  @HttpCode(200)
  @StaffRoute({ tenant: true })
  clear(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('killSwitchId') killSwitchId: string,
  ) {
    return this.switches.clear(principal, killSwitchId);
  }
}
