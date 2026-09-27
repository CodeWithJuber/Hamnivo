import { adminRoutes, ConnectChatwootRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService, validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { ConnectionsService } from './connections.service.js';

@Controller('v1/admin/authority/connections')
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'integrations.manage', tenantWide: true })
  async list(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: await this.connections.list(principal) };
  }

  @Post()
  @StaffRoute({ tenant: true, permission: 'integrations.manage' })
  async connect(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(ConnectChatwootRequest, body);
    const result = await this.idempotency.run(
      {
        tenantId: principal.tenantId,
        actor: `staff:${principal.staffMemberId}`,
        route: adminRoutes.connectChatwoot.operationId,
        key: validIdempotencyKey(request.headers['idempotency-key']),
        body: input,
      },
      async () => ({
        status: 201,
        body: await this.connections.connectChatwoot(principal, input.brandId),
      }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }
}
