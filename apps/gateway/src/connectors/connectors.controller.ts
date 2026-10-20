import {
  CreateConnectorRequest,
  connectorRoutes,
  ReconnectConnectorRequest,
  TestConnectorPermissionsRequest,
  UpdateConnectorGrantsRequest,
} from '@hamnivo/contracts';
import { toPublicId } from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService, validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { ConnectorsService } from './connectors.service.js';

@Controller('v1/admin/connectors')
export class ConnectorsController {
  constructor(
    private readonly connectors: ConnectorsService,
    private readonly idempotency: IdempotencyService,
  ) {}
  @Get('catalog')
  @StaffRoute({ tenant: true, permission: 'tools.read' })
  catalog() {
    return this.connectors.catalog();
  }
  @Get()
  @StaffRoute({ tenant: true, permission: 'tools.read' })
  list(@CurrentPrincipal() principal: StaffPrincipal, @Query() query: unknown) {
    return this.connectors.list(principal, parseInput(connectorRoutes.list.query, query).brandId);
  }
  @Post()
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  async create(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateConnectorRequest, body);
    const result = await this.idempotency.run(
      {
        tenantId: principal.tenantId,
        actor: toPublicId('staff', principal.staffMemberId),
        route: 'POST /v1/admin/connectors',
        key: validIdempotencyKey(request.headers['idempotency-key']),
        body: input,
      },
      async () => ({ status: 201, body: await this.connectors.create(principal, input) }),
    );
    reply.code(result.status);
    if (result.replayed) reply.header('Idempotent-Replayed', 'true');
    return result.body;
  }
  @Post(':connectionId/test')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  test(@CurrentPrincipal() principal: StaffPrincipal, @Param('connectionId') id: string) {
    return this.connectors.test(
      principal,
      parseInput(connectorRoutes.test.params, { connectionId: id }).connectionId,
    );
  }
  @Post(':connectionId/permissions/test')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  testPermissions(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('connectionId') id: string,
    @Body() body: unknown,
  ) {
    return this.connectors.testPermissions(
      principal,
      parseInput(connectorRoutes.testPermissions.params, { connectionId: id }).connectionId,
      parseInput(TestConnectorPermissionsRequest, body),
    );
  }
  @Post(':connectionId/reconnect')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  reconnect(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('connectionId') id: string,
    @Body() body: unknown,
  ) {
    return this.connectors.reconnect(
      principal,
      parseInput(connectorRoutes.reconnect.params, { connectionId: id }).connectionId,
      parseInput(ReconnectConnectorRequest, body),
    );
  }
  @Post(':connectionId/disable')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  disable(@CurrentPrincipal() principal: StaffPrincipal, @Param('connectionId') id: string) {
    return this.connectors.disable(
      principal,
      parseInput(connectorRoutes.disable.params, { connectionId: id }).connectionId,
    );
  }
  @Put(':connectionId/grants')
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  grants(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('connectionId') id: string,
    @Body() body: unknown,
  ) {
    return this.connectors.grants(
      principal,
      parseInput(connectorRoutes.grants.params, { connectionId: id }).connectionId,
      parseInput(UpdateConnectorGrantsRequest, body),
    );
  }
}
